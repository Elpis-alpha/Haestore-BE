import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAttributeDefinition } from '../modules/catalog/attribute-definition.service.js';
import {
  bindAttribute,
  createCategory,
  moveCategory,
} from '../modules/catalog/category.service.js';
import { createProduct, deleteProduct, updateProduct } from '../modules/catalog/product.service.js';
import { Product } from '../modules/catalog/product.model.js';
import { SearchOutbox, appendOutbox } from './outbox.model.js';

/**
 * The write side of the index: that the intent to reindex cannot be separated from the
 * write that caused it.
 *
 * The bug being excluded is not hypothetical and not detectable after the fact — a
 * crash between "product saved" and "job enqueued" leaves a product that exists, sells
 * nowhere, and logs nothing. The only defence is that the two are the same commit, so
 * that is what these assert.
 */

async function shop() {
  const category = await createCategory({
    name: 'Shop',
    parent: null,
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });
  return category;
}

const productInput = (categoryId: string, title: string) => ({
  title,
  categoryId,
  status: 'active' as const,
  attributes: {},
  variantAxes: [],
  variants: [
    {
      axisValues: [],
      price: { amount: 1800, currency: 'USD' },
      stock: { onHand: 3, lowStockThreshold: 3, backorderable: false },
      imagePublicIds: [],
      status: 'active' as const,
      position: 0,
    },
  ],
  images: [],
});

describe('every product write records its reindex intent', () => {
  let categoryId: string;

  beforeEach(async () => {
    categoryId = String((await shop())._id);
  });

  it('writes an outbox row when a product is created', async () => {
    const product = await createProduct(productInput(categoryId, 'Ethiopian'));

    const rows = await SearchOutbox.find({ kind: 'product' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'product',
      entityId: String(product._id),
      op: 'upsert',
      processedAt: null,
    });
  });

  it('writes one when a product is edited', async () => {
    const product = await createProduct(productInput(categoryId, 'Ethiopian'));
    await SearchOutbox.deleteMany({});

    await updateProduct(String(product._id), { title: 'Ethiopian Yirgacheffe' });

    const rows = await SearchOutbox.find({ kind: 'product' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityId).toBe(String(product._id));
  });

  it('records an archive as a removal', async () => {
    const product = await createProduct(productInput(categoryId, 'Ethiopian'));
    await SearchOutbox.deleteMany({});

    await deleteProduct(String(product._id));

    const rows = await SearchOutbox.find({ kind: 'product' }).lean();
    expect(rows[0]).toMatchObject({ entityId: String(product._id), op: 'delete' });
  });

  /**
   * The load-bearing one. If the outbox row were appended after the transaction rather
   * than inside it, this test would find a row describing a product that does not
   * exist — which is the same defect as the reverse, seen from the other side.
   */
  it('rolls the outbox row back when the domain write rolls back', async () => {
    const session = await mongoose.startSession();

    await expect(
      session.withTransaction(async () => {
        const [product] = await Product.create(
          [
            {
              title: 'Never committed',
              slug: 'never-committed',
              category: categoryId,
              categoryAncestors: [categoryId],
              status: 'active',
              inStock: true,
            },
          ],
          { session },
        );
        await appendOutbox(session, {
          kind: 'product',
          entityId: String(product?._id),
          op: 'upsert',
        });
        throw new Error('something failed after both writes');
      }),
    ).rejects.toThrow('something failed after both writes');

    await session.endSession();

    // Neither survived. That is the whole guarantee.
    expect(await Product.countDocuments({ slug: 'never-committed' })).toBe(0);
    expect(await SearchOutbox.countDocuments({})).toBe(0);
  });
});

describe('writes that move an unbounded number of products', () => {
  it('records a category move as one branch row, not one row per product', async () => {
    const root = await shop();
    const beans = await createCategory({
      name: 'Beans',
      parent: String(root._id),
      order: 0,
      validationMode: 'lenient',
      status: 'active',
    });
    const other = await createCategory({
      name: 'Pantry',
      parent: null,
      order: 1,
      validationMode: 'lenient',
      status: 'active',
    });

    for (let i = 0; i < 5; i += 1) {
      await createProduct(productInput(String(beans._id), `Bag ${i}`));
    }
    await SearchOutbox.deleteMany({});

    await moveCategory(String(beans._id), String(other._id));

    const rows = await SearchOutbox.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'category-branch', entityId: String(beans._id) });

    // And the denormalised ancestry really did move, which is what makes the branch row
    // necessary rather than merely tidy.
    const product = await Product.findOne({ title: 'Bag 0' }).lean();
    expect(product?.categoryAncestors.map(String)).toContain(String(other._id));
  });
});

describe('attribute definition writes reach the index settings', () => {
  it('records a settings sync when a definition is created', async () => {
    await createAttributeDefinition({
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

    const rows = await SearchOutbox.find({}).lean();
    expect(rows.map((r) => r.kind)).toEqual(['settings']);
  });

  it('records both a settings sync and a display-value backfill when one is edited', async () => {
    const definition = await createAttributeDefinition({
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
    await SearchOutbox.deleteMany({});

    const { updateAttributeDefinition } =
      await import('../modules/catalog/attribute-definition.service.js');
    await updateAttributeDefinition(String(definition._id), {
      options: [{ value: 'dark', label: 'Dark roast', order: 0 }],
    });

    const rows = await SearchOutbox.find({}).lean();
    // The label changed, so every product carrying `roast: dark` holds a stale
    // displayValue until the backfill rewrites it.
    expect(rows.map((r) => r.kind).sort()).toEqual(['attribute-definition', 'settings']);
  });

  it('re-renders the denormalised display value across the catalogue', async () => {
    const root = await shop();
    const definition = await createAttributeDefinition({
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
    await bindAttribute(String(root._id), {
      defId: String(definition._id),
      required: false,
      order: 0,
    });

    const product = await createProduct({
      ...productInput(String(root._id), 'Sumatra'),
      attributes: { roast: 'dark' },
    });
    expect(product.attributes[0]?.displayValue).toBe('Dark');

    const { updateAttributeDefinition } =
      await import('../modules/catalog/attribute-definition.service.js');
    await updateAttributeDefinition(String(definition._id), {
      options: [{ value: 'dark', label: 'Dark roast', order: 0 }],
    });

    const { backfillDefinition } = await import('./indexer.js');
    await backfillDefinition(String(definition._id));

    const after = await Product.findById(product._id).lean();
    expect(after?.attributes[0]?.displayValue).toBe('Dark roast');
    // The stored value itself is untouched — a label is not an identity.
    expect(after?.attributes[0]?.valueString).toBe('dark');
  });
});
