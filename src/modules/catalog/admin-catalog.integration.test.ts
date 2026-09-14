import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { ADMIN_EMAIL, signIn, type TestSession } from '../../test/sign-in.js';
import { createAttributeDefinition } from './attribute-definition.service.js';
import { bindAttribute, createCategory } from './category.service.js';
import { createProduct } from './product.service.js';
import { SearchOutbox } from '../../search/outbox.model.js';
import { Product } from './product.model.js';

/**
 * The catalogue reads Phase 8 added: the admin product list, attribute usage, and the
 * axis labels on the public product that close the gap FRONTEND.md recorded.
 */

const app = createApp();
let admin: TestSession;

beforeEach(async () => {
  admin = await signIn(app, ADMIN_EMAIL);
});

async function kitchen() {
  const shop = await createCategory({
    name: 'Kitchen',
    parent: null,
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });
  const grind = await createAttributeDefinition({
    key: 'grind',
    label: 'Grind',
    type: 'select',
    options: [
      { value: 'whole-bean', label: 'Whole bean', order: 0 },
      { value: 'espresso-fine', label: 'Espresso fine', order: 1 },
    ],
    // The precise case the old label lookup missed: an axis that is not a filter.
    isFilterable: false,
    isSearchable: false,
    isVariantAxis: true,
    filterUi: 'checkbox',
    validation: { requiredByDefault: false },
  });
  const origin = await createAttributeDefinition({
    key: 'origin',
    label: 'Origin',
    type: 'text',
    options: [],
    isFilterable: false,
    isSearchable: false,
    isVariantAxis: false,
    filterUi: 'checkbox',
    validation: { requiredByDefault: false },
  });
  await bindAttribute(String(shop._id), { defId: String(grind._id), required: false, order: 0 });
  await bindAttribute(String(shop._id), { defId: String(origin._id), required: true, order: 1 });
  return { shop };
}

const variant = (grind: string, sku: string) => ({
  sku,
  axisValues: [{ key: 'grind', value: grind }],
  price: { amount: 1600, currency: 'USD' },
  stock: { onHand: 5, lowStockThreshold: 3, backorderable: false },
  imagePublicIds: [],
  status: 'active' as const,
  position: 0,
});

describe('the admin product list', () => {
  it('includes drafts and archived products, and finds the ones needing attention', async () => {
    const { shop } = await kitchen();
    const base = { categoryId: String(shop._id), variantAxes: [], variants: [], images: [] };

    await createProduct({
      ...base,
      title: 'Live Kettle',
      status: 'active',
      attributes: { origin: 'Japan' },
    });
    await createProduct({
      ...base,
      title: 'Draft Kettle',
      status: 'draft',
      attributes: { origin: 'Japan' },
    });
    // Missing a required attribute, which lenient mode flags instead of refusing.
    await createProduct({ ...base, title: 'Flagged Kettle', status: 'draft', attributes: {} });

    const all = await request(app)
      .get('/api/admin/catalog/products')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect((all.body as { page: { total: number } }).page.total).toBe(3);

    const flagged = await request(app)
      .get('/api/admin/catalog/products?needsAttention=true')
      .set('Cookie', admin.cookie)
      .expect(200);
    const rows = (
      flagged.body as { data: { title: string; issueCount: number; category: { name: string } }[] }
    ).data;
    expect(rows.map((r) => r.title)).toEqual(['Flagged Kettle']);
    expect(rows[0]).toMatchObject({ issueCount: 1, category: { name: 'Kitchen' } });

    // "false" is false — the coercion trap z.coerce.boolean() would have fallen into.
    const unflagged = await request(app)
      .get('/api/admin/catalog/products?needsAttention=false')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect((unflagged.body as { page: { total: number } }).page.total).toBe(3);
  });

  it('finds a product by a fragment of its title or its exact SKU', async () => {
    const { shop } = await kitchen();
    await createProduct({
      categoryId: String(shop._id),
      title: 'Single Origin Beans',
      status: 'draft',
      attributes: { origin: 'Ethiopia' },
      variantAxes: ['grind'],
      variants: [variant('whole-bean', 'SOB-WB')],
      images: [],
    });

    for (const q of ['origin be', 'sob-wb']) {
      const res = await request(app)
        .get('/api/admin/catalog/products')
        .query({ q })
        .set('Cookie', admin.cookie)
        .expect(200);
      expect((res.body as { page: { total: number } }).page.total, q).toBe(1);
    }
  });
});

describe('attribute usage', () => {
  it('counts the categories binding each attribute and the products carrying it', async () => {
    const { shop } = await kitchen();
    await createProduct({
      categoryId: String(shop._id),
      title: 'Kettle',
      status: 'draft',
      attributes: { origin: 'Japan' },
      variantAxes: [],
      variants: [],
      images: [],
    });

    const res = await request(app)
      .get('/api/admin/catalog/attributes/usage')
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(res.body).toEqual({
      data: { grind: { categories: 1, products: 0 }, origin: { categories: 1, products: 1 } },
    });
  });
});

describe('axis labels on the public product', () => {
  it('names every axis and value, including an axis that is not a filter', async () => {
    const { shop } = await kitchen();
    const product = await createProduct({
      categoryId: String(shop._id),
      title: 'House Espresso',
      status: 'active',
      attributes: { origin: 'Brazil' },
      variantAxes: ['grind'],
      variants: [
        variant('whole-bean', 'HE-WB'),
        { ...variant('espresso-fine', 'HE-EF'), position: 1 },
      ],
      images: [],
    });

    const res = await request(app).get(`/api/catalog/products/${product.slug}`).expect(200);
    expect((res.body as { data: { axes: unknown } }).data.axes).toEqual([
      {
        key: 'grind',
        label: 'Grind',
        options: [
          { value: 'whole-bean', label: 'Whole bean' },
          { value: 'espresso-fine', label: 'Espresso fine' },
        ],
      },
    ]);
  });
});

describe('generating a variant grid', () => {
  /**
   * The route used to save the grid straight onto the document, skipping the pipeline
   * every other product write goes through. These are the three things that skipped.
   */
  it('goes through the product write pipeline: reindexed, summarised, and sellable', async () => {
    const { shop } = await kitchen();
    const product = await createProduct({
      categoryId: String(shop._id),
      title: 'Grind Test',
      status: 'active',
      attributes: { origin: 'Peru' },
      variantAxes: ['grind'],
      variants: [variant('whole-bean', 'GT-WB')],
      images: [],
    });
    const before = await SearchOutbox.countDocuments({ entityId: String(product._id) });

    await request(app)
      .post(`/api/admin/catalog/products/${String(product._id)}/variants/generate`)
      .set('Origin', 'http://localhost:3000')
      .set('Cookie', admin.cookie)
      .send({ axes: [{ key: 'grind', values: ['whole-bean', 'espresso-fine'] }] })
      .expect(200);

    const stored = await Product.findById(product._id).lean();
    expect(stored!.variants).toHaveLength(2);
    // The kept row keeps its stock, and `available` is maintained from it.
    expect(stored!.variants[0]!.stock).toMatchObject({ onHand: 5, available: 5 });
    expect(stored!.priceRange).toMatchObject({ min: 1600, max: 1600 });
    expect(await SearchOutbox.countDocuments({ entityId: String(product._id) })).toBeGreaterThan(
      before,
    );
  });
});

describe('specification labels on the public product', () => {
  it('names every attribute in the admin’s words, filterable or not', async () => {
    const { shop } = await kitchen();
    const product = await createProduct({
      categoryId: String(shop._id),
      title: 'Labelled Kettle',
      status: 'active',
      attributes: { origin: 'Japan' },
      variantAxes: [],
      variants: [],
      images: [],
    });

    const res = await request(app).get(`/api/catalog/products/${product.slug}`).expect(200);
    const attributes = (res.body as { data: { attributes: { key: string; label?: string }[] } })
      .data.attributes;
    // `origin` is free text and not a filter, so the category's filter list never named it.
    expect(attributes).toContainEqual(expect.objectContaining({ key: 'origin', label: 'Origin' }));
  });
});
