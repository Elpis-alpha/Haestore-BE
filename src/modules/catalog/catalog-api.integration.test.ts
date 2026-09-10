import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { createAttributeDefinition } from './attribute-definition.service.js';
import { bindAttribute, createCategory } from './category.service.js';
import { createProduct } from './product.service.js';

/**
 * The storefront's half of the contract, over HTTP.
 *
 * The point of these is the filter panel: the frontend asks a category what it can be
 * filtered by and is told, so an attribute defined this morning appears in the shop
 * without a deploy. Nothing in the response is hardcoded anywhere in either repo.
 */

const app = createApp();

/**
 * Supertest types `res.body` as `any`, which would quietly turn every assertion below
 * into an unchecked one. Narrowing here keeps the tests honest about the shape they
 * claim the API returns.
 */
type Filter = {
  key: string;
  label: string;
  type: string;
  filterUi: string;
  options: { value: string }[];
};
type CategoryResponse = { data: { category: { path: string }; filters: Filter[] } };
type Card = { _id: string; title: string; validationIssues?: unknown; needsAttention?: unknown };
type ListResponse = {
  data: Card[];
  page: { perPage: number; hasMore: boolean; nextCursor: string | null; degraded: boolean };
};
type ErrorResponse = { error: { code: string; message: string } };

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

async function shopWithCoffee() {
  const shop = await createCategory({
    name: 'Shop',
    parent: null,
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });
  const beans = await createCategory({
    name: 'Beans',
    parent: String(shop._id),
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });

  const roast = await createAttributeDefinition({
    key: 'roast',
    label: 'Roast level',
    type: 'select',
    options: [
      { value: 'light', label: 'Light', order: 0 },
      { value: 'dark', label: 'Dark', order: 1 },
    ],
    isFilterable: true,
    isSearchable: false,
    isVariantAxis: false,
    filterUi: 'checkbox',
    validation: { requiredByDefault: false },
  });

  // Filterable is a property of the definition: an internal note should not become a
  // public filter just because a category binds it.
  const note = await createAttributeDefinition({
    key: 'buyer_note',
    label: 'Buyer note',
    type: 'text',
    options: [],
    isFilterable: false,
    isSearchable: false,
    isVariantAxis: false,
    filterUi: 'checkbox',
    validation: { requiredByDefault: false },
  });

  await bindAttribute(String(shop._id), { defId: String(roast._id), required: false, order: 0 });
  await bindAttribute(String(beans._id), { defId: String(note._id), required: false, order: 1 });

  return { shop, beans };
}

const makeProduct = (
  categoryId: string,
  title: string,
  amount: number,
  status: 'draft' | 'active',
) =>
  createProduct({
    title,
    categoryId,
    status,
    attributes: {},
    variantAxes: [],
    variants: [
      {
        axisValues: [],
        price: { amount, currency: 'USD' },
        stock: { onHand: 3, lowStockThreshold: 3, backorderable: false },
        imagePublicIds: [],
        status: 'active',
        position: 0,
      },
    ],
    images: [],
  });

describe('the storefront is told what it can filter by', () => {
  beforeEach(async () => {
    await shopWithCoffee();
  });

  it('generates the filter panel from admin-defined attributes, inherited included', async () => {
    const res = await request(app).get('/api/catalog/categories/by-path/shop/beans').expect(200);

    const body = bodyOf<CategoryResponse>(res);
    expect(body.data.category.path).toBe('shop/beans');

    // `roast` was bound to the parent and arrives here by inheritance; `buyer_note` is
    // bound here but is not filterable, so it must not appear.
    expect(body.data.filters.map((f) => f.key)).toEqual(['roast']);

    const roast = body.data.filters[0];
    expect(roast).toMatchObject({ label: 'Roast level', type: 'select', filterUi: 'checkbox' });
    expect(roast?.options.map((o) => o.value)).toEqual(['light', 'dark']);
  });

  it('404s a path that does not exist rather than guessing', async () => {
    await request(app).get('/api/catalog/categories/by-path/shop/nope').expect(404);
  });
});

describe('every list endpoint is bounded and projected', () => {
  it('refuses a page size above the maximum instead of honouring it', async () => {
    // The 2022 listing had no limit and no projection, so one request returned every
    // field of every item, image buffers included.
    const res = await request(app).get('/api/catalog/products?per_page=5000').expect(400);
    expect(bodyOf<ErrorResponse>(res).error.code).toBe('BAD_REQUEST');
  });

  it('never returns drafts, and never returns internal review state', async () => {
    const { beans } = await shopWithCoffee();
    await makeProduct(String(beans._id), 'Live bag', 1800, 'active');
    await makeProduct(String(beans._id), 'Secret bag', 9900, 'draft');

    const body = bodyOf<ListResponse>(await request(app).get('/api/catalog/products').expect(200));
    const titles = body.data.map((p) => p.title);

    expect(titles).toContain('Live bag');
    expect(titles).not.toContain('Secret bag');
    expect(body.data[0]).not.toHaveProperty('validationIssues');
    expect(body.data[0]).not.toHaveProperty('needsAttention');
  });

  it('pages by cursor, without repeating or skipping a row', async () => {
    const { beans } = await shopWithCoffee();
    for (let i = 0; i < 5; i += 1) {
      await makeProduct(String(beans._id), `Bag ${i}`, 1000 + i, 'active');
    }

    const first = bodyOf<ListResponse>(
      await request(app).get('/api/catalog/products?per_page=2').expect(200),
    );
    expect(first.data).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);

    const second = bodyOf<ListResponse>(
      await request(app)
        .get(`/api/catalog/products?per_page=2&cursor=${first.page.nextCursor}`)
        .expect(200),
    );

    const firstIds = first.data.map((p) => p._id);
    expect(second.data.some((p) => firstIds.includes(p._id))).toBe(false);

    // Five rows across pages of two: 2, 2, then 1 with no further page.
    const third = bodyOf<ListResponse>(
      await request(app)
        .get(`/api/catalog/products?per_page=2&cursor=${second.page.nextCursor}`)
        .expect(200),
    );
    expect(third.data).toHaveLength(1);
    expect(third.page.hasMore).toBe(false);
    expect(third.page.nextCursor).toBeNull();
  });

  it('filters a whole branch with one predicate against the materialised ancestry', async () => {
    const { shop, beans } = await shopWithCoffee();
    await makeProduct(String(beans._id), 'In the branch', 1800, 'active');

    const atRoot = bodyOf<ListResponse>(
      await request(app).get('/api/catalog/products?category=shop').expect(200),
    );
    expect(atRoot.data).toHaveLength(1);

    const atLeaf = bodyOf<ListResponse>(
      await request(app).get('/api/catalog/products?category=shop/beans').expect(200),
    );
    expect(atLeaf.data).toHaveLength(1);
    expect(String(shop._id)).toBeTruthy();
  });
});

describe('the admin surface is not reachable without a session', () => {
  it('answers 401 to an anonymous caller on every admin route', async () => {
    // requireRole is mounted once on the router, so this holds for routes that did not
    // exist when the test was written.
    for (const path of [
      '/api/admin/catalog/attributes',
      '/api/admin/catalog/categories',
      '/api/admin/catalog/products/000000000000000000000000',
    ]) {
      await request(app).get(path).expect(401);
    }
  });
});
