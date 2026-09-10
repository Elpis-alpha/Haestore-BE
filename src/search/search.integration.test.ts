import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createAttributeDefinition } from '../modules/catalog/attribute-definition.service.js';
import { bindAttribute, createCategory } from '../modules/catalog/category.service.js';
import { createProduct } from '../modules/catalog/product.service.js';
import { meili, PRODUCTS_INDEX } from './meili.js';
import { ensureProductsIndex, indexProduct, syncSearchSettings } from './indexer.js';

/**
 * The search path, against a real Meilisearch.
 *
 * These are the claims that cannot be proved with a fake: that a runtime-defined
 * attribute becomes a working filter without anything naming it, that facet counts
 * survive the shopper actually using them, and that no query string can talk the filter
 * DSL into showing a draft.
 *
 * They index synchronously by calling `indexProduct` rather than by letting the relay
 * and the worker do it, because what is under test here is the query side. The write
 * side — the outbox committing with the domain write — is proved separately in
 * outbox.integration.test.ts.
 */

const app = createApp();

type Facet = {
  key: string;
  label: string;
  filterUi: string;
  range: { min: number; max: number } | null;
  values: { value: string; label: string; count: number; selected: boolean }[];
};
type ListResponse = {
  data: { id: string; title: string }[];
  page: { page: number; perPage: number; total: number; totalPages: number; degraded: boolean };
  facets: Facet[] | null;
  ignoredFilters: { key: string; reason: string }[];
};
const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

/** Meilisearch indexes asynchronously; every write here is awaited to completion. */
async function settle(): Promise<void> {
  const tasks = await meili.getTasks({ statuses: ['enqueued', 'processing'], limit: 100 });
  if (tasks.results.length === 0) return;
  await meili.waitForTasks(
    tasks.results.map((t) => t.uid),
    { timeOutMs: 60_000 },
  );
}

async function coffeeShop() {
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
      { value: 'medium', label: 'Medium', order: 1 },
      { value: 'dark', label: 'Dark', order: 2 },
    ],
    isFilterable: true,
    isSearchable: false,
    isVariantAxis: false,
    filterUi: 'checkbox',
    validation: { requiredByDefault: false },
  });

  const weight = await createAttributeDefinition({
    key: 'weight_g',
    label: 'Weight',
    type: 'number',
    unit: 'g',
    options: [],
    isFilterable: true,
    isSearchable: false,
    isVariantAxis: false,
    filterUi: 'range',
    validation: { min: 100, max: 2000, requiredByDefault: false },
  });

  await bindAttribute(String(beans._id), { defId: String(roast._id), required: false, order: 0 });
  await bindAttribute(String(beans._id), { defId: String(weight._id), required: false, order: 1 });

  return { shop, beans };
}

async function bag(
  categoryId: string,
  title: string,
  amount: number,
  attributes: Record<string, unknown>,
  status: 'draft' | 'active' = 'active',
) {
  const product = await createProduct({
    title,
    categoryId,
    status,
    attributes,
    variantAxes: [],
    variants: [
      {
        axisValues: [],
        price: { amount, currency: 'USD' },
        stock: { onHand: 5, lowStockThreshold: 3, backorderable: false },
        imagePublicIds: [],
        status: 'active',
        position: 0,
      },
    ],
    images: [],
  });
  await indexProduct(String(product._id));
  return product;
}

beforeAll(async () => {
  await ensureProductsIndex();
}, 60_000);

afterAll(async () => {
  await meili.deleteIndex(PRODUCTS_INDEX).catch(() => undefined);
});

beforeEach(async () => {
  // The Mongo and Redis wipes come from the shared setup; the index needs its own.
  await meili
    .index(PRODUCTS_INDEX)
    .deleteAllDocuments()
    .catch(() => undefined);
  await settle();
});

describe('an attribute invented at runtime becomes a working filter', () => {
  it('filters on a key nothing in either repo names, and the search path answers', async () => {
    const { beans } = await coffeeShop();
    // The settings are derived from the definitions that were just created — no list of
    // filterable fields is authored anywhere.
    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Ethiopian', 1800, { roast: 'light', weight_g: 250 });
    await bag(String(beans._id), 'Colombian', 2200, { roast: 'medium', weight_g: 250 });
    await bag(String(beans._id), 'Sumatra', 2600, { roast: 'dark', weight_g: 1000 });
    await settle();

    const body = bodyOf<ListResponse>(
      await request(app).get('/api/catalog/products?category=shop/beans&roast=dark').expect(200),
    );

    expect(body.page.degraded).toBe(false);
    expect(body.data.map((p) => p.title)).toEqual(['Sumatra']);
    expect(body.page.total).toBe(1);
  });

  it('ranges over a numeric attribute', async () => {
    const { beans } = await coffeeShop();
    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Small', 1800, { roast: 'light', weight_g: 250 });
    await bag(String(beans._id), 'Large', 2600, { roast: 'dark', weight_g: 1000 });
    await settle();

    const body = bodyOf<ListResponse>(
      await request(app)
        .get('/api/catalog/products?category=shop/beans&weight_g=500-2000')
        .expect(200),
    );
    expect(body.data.map((p) => p.title)).toEqual(['Large']);
  });
});

describe('facet counts survive being used', () => {
  /**
   * The failure this guards against: with `attr.roast IN ["dark"]` in the filter, the
   * distribution Meilisearch returns for `attr.roast` contains only `dark` — the other
   * values do not read zero, they are absent. Without the disjunctive pass the panel
   * loses its own options the moment a shopper ticks one.
   */
  it('keeps the other values in a group the shopper has already filtered on', async () => {
    const { beans } = await coffeeShop();
    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Ethiopian', 1800, { roast: 'light', weight_g: 250 });
    await bag(String(beans._id), 'Kenyan', 1900, { roast: 'light', weight_g: 250 });
    await bag(String(beans._id), 'Colombian', 2200, { roast: 'medium', weight_g: 250 });
    await bag(String(beans._id), 'Sumatra', 2600, { roast: 'dark', weight_g: 1000 });
    await settle();

    const filtered = bodyOf<ListResponse>(
      await request(app).get('/api/catalog/products?category=shop/beans&roast=dark').expect(200),
    );

    const roast = filtered.facets?.find((f) => f.key === 'roast');
    const counts = Object.fromEntries(roast?.values.map((v) => [v.value, v.count]) ?? []);

    // The counts a shopper needs in order to widen their selection: what they would get
    // by ticking light or medium *as well*, not what is left after ticking dark.
    expect(counts).toEqual({ light: 2, medium: 1, dark: 1 });
    expect(roast?.values.find((v) => v.value === 'dark')?.selected).toBe(true);
  });

  it('narrows a different group normally while doing so', async () => {
    const { beans } = await coffeeShop();
    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Light small', 1800, { roast: 'light', weight_g: 250 });
    await bag(String(beans._id), 'Dark small', 1900, { roast: 'dark', weight_g: 250 });
    await bag(String(beans._id), 'Dark large', 2600, { roast: 'dark', weight_g: 1000 });
    await settle();

    const body = bodyOf<ListResponse>(
      await request(app)
        .get('/api/catalog/products?category=shop/beans&roast=dark&weight_g=900-2000')
        .expect(200),
    );

    expect(body.data.map((p) => p.title)).toEqual(['Dark large']);

    // Roast is corrected disjunctively — but only against the *other* live filter, so
    // "light" reads 0 because no light bag is that heavy, not because dark was selected.
    const roast = body.facets?.find((f) => f.key === 'roast');
    expect(Object.fromEntries(roast?.values.map((v) => [v.value, v.count]) ?? [])).toEqual({
      light: 0,
      medium: 0,
      dark: 1,
    });
  });

  it('reports a numeric facet as bounds a slider can still be widened from', async () => {
    const { beans } = await coffeeShop();
    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Small', 1800, { roast: 'light', weight_g: 250 });
    await bag(String(beans._id), 'Large', 2600, { roast: 'dark', weight_g: 1000 });
    await settle();

    const body = bodyOf<ListResponse>(
      await request(app)
        .get('/api/catalog/products?category=shop/beans&weight_g=900-1000')
        .expect(200),
    );

    const weight = body.facets?.find((f) => f.key === 'weight_g');
    // 250 is outside the selected range and still reported, because otherwise the
    // shopper could never drag the handle back down.
    expect(weight?.range).toEqual({ min: 250, max: 1000 });
  });
});

describe('an attribute defined but not yet synced', () => {
  /**
   * The settings sync is debounced by 30 seconds, so for a short window an attribute
   * exists in the catalogue and not in the index. The filter panel is generated from the
   * catalogue, so it will ask to facet on a field the index does not have — and
   * Meilisearch rejects the *whole request* for that, not just the one facet.
   *
   * Observed against a running server: defining one attribute took the entire filter
   * panel down for every shopper in that category, and the listing silently fell back to
   * MongoDB, until the debounce elapsed.
   */
  it('does not take the whole panel down with it', async () => {
    const { beans } = await coffeeShop();
    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Ethiopian', 1800, { roast: 'light', weight_g: 250 });
    await settle();

    // Defined and bound, but deliberately not synced — exactly the window in question.
    const process = await createAttributeDefinition({
      key: 'process',
      label: 'Processing method',
      type: 'select',
      options: [{ value: 'washed', label: 'Washed', order: 0 }],
      isFilterable: true,
      isSearchable: false,
      isVariantAxis: false,
      filterUi: 'checkbox',
      validation: { requiredByDefault: false },
    });
    await bindAttribute(String(beans._id), {
      defId: String(process._id),
      required: false,
      order: 5,
    });

    const body = bodyOf<ListResponse>(
      await request(app).get('/api/catalog/products?category=shop/beans').expect(200),
    );

    // Still the search path, still faceted on everything the index does know.
    expect(body.page.degraded).toBe(false);
    expect(body.facets?.map((f) => f.key)).toContain('roast');
    // The unsynced one is simply absent for a few seconds.
    expect(body.facets?.map((f) => f.key)).not.toContain('process');
  });

  it('reports a filter on it rather than failing the request', async () => {
    const { beans } = await coffeeShop();
    await syncSearchSettings();
    await settle();
    await bag(String(beans._id), 'Ethiopian', 1800, { roast: 'light', weight_g: 250 });
    await settle();

    const process = await createAttributeDefinition({
      key: 'process',
      label: 'Processing method',
      type: 'select',
      options: [{ value: 'washed', label: 'Washed', order: 0 }],
      isFilterable: true,
      isSearchable: false,
      isVariantAxis: false,
      filterUi: 'checkbox',
      validation: { requiredByDefault: false },
    });
    await bindAttribute(String(beans._id), {
      defId: String(process._id),
      required: false,
      order: 5,
    });

    const body = bodyOf<ListResponse>(
      await request(app)
        .get('/api/catalog/products?category=shop/beans&process=washed')
        .expect(200),
    );

    expect(body.page.degraded).toBe(false);
    expect(body.ignoredFilters.map((f) => f.key)).toContain('process');
  });

  it('picks the attribute up once the sync has landed', async () => {
    const { beans } = await coffeeShop();
    const process = await createAttributeDefinition({
      key: 'process',
      label: 'Processing method',
      type: 'select',
      options: [
        { value: 'washed', label: 'Washed', order: 0 },
        { value: 'natural', label: 'Natural', order: 1 },
      ],
      isFilterable: true,
      isSearchable: false,
      isVariantAxis: false,
      filterUi: 'checkbox',
      validation: { requiredByDefault: false },
    });
    await bindAttribute(String(beans._id), {
      defId: String(process._id),
      required: false,
      order: 5,
    });

    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Washed one', 1800, { roast: 'light', process: 'washed' });
    await bag(String(beans._id), 'Natural one', 1900, { roast: 'dark', process: 'natural' });
    await settle();

    const body = bodyOf<ListResponse>(
      await request(app)
        .get('/api/catalog/products?category=shop/beans&process=natural')
        .expect(200),
    );

    expect(body.ignoredFilters).toHaveLength(0);
    expect(body.data.map((p) => p.title)).toEqual(['Natural one']);
    expect(body.facets?.map((f) => f.key)).toContain('process');
  });
});

describe('the filter DSL cannot be talked into leaking a draft', () => {
  it('never returns a draft, whatever the query string says', async () => {
    const { beans } = await coffeeShop();
    await syncSearchSettings();
    await settle();

    await bag(String(beans._id), 'Public bag', 1800, { roast: 'light' });
    const secret = await createProduct({
      title: 'Unfinished bag',
      categoryId: String(beans._id),
      status: 'draft',
      attributes: { roast: 'dark' },
      variantAxes: [],
      variants: [
        {
          axisValues: [],
          price: { amount: 9900, currency: 'USD' },
          stock: { onHand: 1, lowStockThreshold: 3, backorderable: false },
          imagePublicIds: [],
          status: 'active',
          position: 0,
        },
      ],
      images: [],
    });
    // Even asked to index it directly, a draft is removed rather than stored.
    await indexProduct(String(secret._id));
    await settle();

    const hostile = encodeURIComponent('light" OR status = "draft');
    for (const qs of [
      `roast=${hostile}`,
      `roast=light&status=draft`,
      `roast=light"%20OR%20status%20=%20"draft`,
      `sort=publishedAt:desc`,
    ]) {
      const body = bodyOf<ListResponse>(
        await request(app).get(`/api/catalog/products?category=shop/beans&${qs}`),
      );
      const titles = (body.data ?? []).map((p) => p.title);
      expect(titles).not.toContain('Unfinished bag');
    }
  });

  it('refuses a sort that is not in the whitelist rather than passing it through', async () => {
    await coffeeShop();
    await syncSearchSettings();
    await settle();

    // A raw Meilisearch sort expression would let a caller order by any stored field.
    await request(app).get('/api/catalog/products?sort=priceMin:desc').expect(400);
    await request(app).get('/api/catalog/products?sort=price_asc').expect(200);
  });
});

describe('derived settings', () => {
  it('turns a newly defined filterable attribute into a filterable index field', async () => {
    await coffeeShop();
    await syncSearchSettings();
    await settle();

    const filterable = await meili.index(PRODUCTS_INDEX).getFilterableAttributes();

    expect(filterable).toContain('attr.roast');
    expect(filterable).toContain('attr.weight_g');
    expect(filterable).toContain('status');
  });

  it('does not declare an attribute whose type cannot back a filter', async () => {
    const { beans } = await coffeeShop();
    const note = await createAttributeDefinition({
      key: 'tasting_note',
      label: 'Tasting note',
      type: 'text',
      options: [],
      // The admin asked for a filter; a free-text attribute cannot be one.
      isFilterable: true,
      isSearchable: true,
      isVariantAxis: false,
      filterUi: 'checkbox',
      validation: { requiredByDefault: false },
    });
    await bindAttribute(String(beans._id), { defId: String(note._id), required: false, order: 2 });

    await syncSearchSettings();
    await settle();

    const filterable = await meili.index(PRODUCTS_INDEX).getFilterableAttributes();
    expect(filterable).not.toContain('attr.tasting_note');

    // And the generated panel drops it by the same rule, so the two never disagree.
    const res = await request(app).get('/api/catalog/categories/by-path/shop/beans').expect(200);
    const filters = (res.body as { data: { filters: { key: string }[] } }).data.filters;
    expect(filters.map((f) => f.key)).not.toContain('tasting_note');
  });
});
