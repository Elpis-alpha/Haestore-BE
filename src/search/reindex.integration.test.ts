import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAttributeDefinition } from '../modules/catalog/attribute-definition.service.js';
import { bindAttribute, createCategory } from '../modules/catalog/category.service.js';
import { createProduct } from '../modules/catalog/product.service.js';
import { Product } from '../modules/catalog/product.model.js';
import { meili, PRODUCTS_INDEX, PRODUCTS_REBUILD_INDEX } from './meili.js';
import { ensureProductsIndex } from './indexer.js';
import { reindexAll } from './reindex.js';

/**
 * Rebuilding the index without emptying the shop.
 *
 * Two things are asserted that a unit test cannot reach, because both are properties of
 * Meilisearch rather than of this code: that a swap carries settings along with the
 * documents (so a rebuild index without settings would go live with no filterable
 * attributes at all), and that the guard refusing a suspiciously small rebuild runs
 * while refusing still helps.
 */

async function settle(): Promise<void> {
  const tasks = await meili.getTasks({ statuses: ['enqueued', 'processing'], limit: 200 });
  if (tasks.results.length === 0) return;
  await meili.waitForTasks(
    tasks.results.map((t) => t.uid),
    { timeOutMs: 60_000 },
  );
}

async function catalogue(count: number) {
  const category = await createCategory({
    name: 'Shop',
    parent: null,
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });

  const roast = await createAttributeDefinition({
    key: 'roast',
    label: 'Roast',
    type: 'select',
    options: [{ value: 'dark', label: 'Dark', order: 0 }],
    isFilterable: true,
    isSearchable: false,
    isVariantAxis: false,
    filterUi: 'checkbox',
    validation: { requiredByDefault: false },
  });
  await bindAttribute(String(category._id), {
    defId: String(roast._id),
    required: false,
    order: 0,
  });

  for (let i = 0; i < count; i += 1) {
    await createProduct({
      title: `Bag ${i}`,
      categoryId: String(category._id),
      status: 'active',
      attributes: { roast: 'dark' },
      variantAxes: [],
      variants: [
        {
          axisValues: [],
          price: { amount: 1000 + i, currency: 'USD' },
          stock: { onHand: 3, lowStockThreshold: 3, backorderable: false },
          imagePublicIds: [],
          status: 'active',
          position: 0,
        },
      ],
      images: [],
    });
  }
  return category;
}

beforeEach(async () => {
  await ensureProductsIndex();
  await meili
    .index(PRODUCTS_INDEX)
    .deleteAllDocuments()
    .catch(() => undefined);
  await settle();
});

afterAll(async () => {
  for (const index of [PRODUCTS_INDEX, PRODUCTS_REBUILD_INDEX]) {
    await meili.deleteIndex(index).catch(() => undefined);
  }
});

describe('reindexAll', () => {
  it('builds elsewhere and swaps, leaving the live index complete and queryable', async () => {
    await catalogue(6);

    const result = await reindexAll();
    await settle();

    expect(result.swapped).toBe(true);
    expect(result.indexed).toBe(6);

    const search = await meili.index(PRODUCTS_INDEX).search('', { hitsPerPage: 20 });
    expect(search.hits).toHaveLength(6);
  });

  /**
   * A swap exchanges the whole index, settings included. Verified against Meilisearch
   * 1.11 before the rebuild was written: swapping into an index whose settings were
   * never configured leaves the live index with `filterableAttributes: []`, and every
   * storefront filter starts returning 400. The rebuild therefore applies settings
   * before the swap, and this is the test that says so.
   */
  it('carries the derived settings across the swap', async () => {
    await catalogue(3);

    await reindexAll();
    await settle();

    const filterable = await meili.index(PRODUCTS_INDEX).getFilterableAttributes();
    expect(filterable).toContain('attr.roast');
    expect(filterable).toContain('status');

    // And they are usable immediately, not merely present.
    const filtered = await meili
      .index(PRODUCTS_INDEX)
      .search('', { filter: 'status = "active" AND attr.roast IN ["dark"]', hitsPerPage: 20 });
    expect(filtered.hits).toHaveLength(3);
  });

  it('refuses a rebuild that found nothing, whatever the size of the shop', async () => {
    await catalogue(10);
    await reindexAll();
    await settle();

    // The database emptying underneath a rebuild is what a wrong MONGODB_URL, an
    // unfinished restore, or a fresh mongod all look like from here — and it looks the
    // same in a ten-product shop as in a ten-thousand-product one, which is why this
    // check is not proportional.
    await Product.deleteMany({});

    const result = await reindexAll();
    await settle();

    expect(result.swapped).toBe(false);
    expect(result.reason).toMatch(/no products at all/);

    // The point of refusing: the shop is still full.
    const search = await meili.index(PRODUCTS_INDEX).search('', { hitsPerPage: 20 });
    expect(search.hits).toHaveLength(10);
  });

  it('does not let a small shop trip the proportional guard on an ordinary archive', async () => {
    // Four products, one archived: a 25% drop, and a percentage means nothing at this
    // size. Refusing here would make --force the normal way to run a rebuild.
    await catalogue(4);
    await reindexAll();
    await settle();

    await Product.updateOne({ title: 'Bag 0' }, { $set: { status: 'archived' } });

    const result = await reindexAll();
    await settle();

    expect(result.swapped).toBe(true);
    expect(result.indexed).toBe(3);
  });

  it('swaps a shrinking rebuild anyway when the operator insists', async () => {
    await catalogue(10);
    await reindexAll();
    await settle();

    await Product.deleteMany({});

    const result = await reindexAll({ force: true });
    await settle();

    expect(result.swapped).toBe(true);
    const search = await meili.index(PRODUCTS_INDEX).search('', { hitsPerPage: 20 });
    expect(search.hits).toHaveLength(0);
  });

  it('does not carry a product that has since been archived back into the index', async () => {
    await catalogue(4);
    await reindexAll();
    await settle();

    await Product.updateOne({ title: 'Bag 0' }, { $set: { status: 'archived' } });

    const result = await reindexAll();
    await settle();

    expect(result.swapped).toBe(true);
    expect(result.indexed).toBe(3);

    // A rebuild index reused from last time would still hold Bag 0, and the swap would
    // put it back on the shelf. It is created fresh every run for exactly this reason.
    const search = await meili.index(PRODUCTS_INDEX).search('', { hitsPerPage: 20 });
    expect(search.hits.map((h) => (h as { title: string }).title)).not.toContain('Bag 0');
  });
});
