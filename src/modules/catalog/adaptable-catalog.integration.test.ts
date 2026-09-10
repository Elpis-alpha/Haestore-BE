import { describe, expect, it } from 'vitest';
import { createAttributeDefinition } from './attribute-definition.service.js';
import {
  bindAttribute,
  createCategory,
  moveCategory,
  setSuppressedKeys,
  updateCategory,
} from './category.service.js';
import { createProduct, recategoriseProduct, updateProduct } from './product.service.js';
import { resolveEffectiveAttributes } from './effective-attributes.js';
import { Product } from './product.model.js';
import { Category } from './category.model.js';

/**
 * The proof that "adaptable" is real.
 *
 * The 2022 project was called Adaptable Stores and never was: its Item model began
 * with a free-form category string and moved *away* from flexibility to a hardcoded
 * enum of Cloth, Shoe and Cosmetic — five fields, no variants, no options, no stock.
 *
 * Everything below happens without a deploy, a migration or a schema change. If this
 * file passes, an administrator can invent a kind of product the code has never heard
 * of and sell it.
 */

async function coffeeTree() {
  const shop = await createCategory({
    name: 'Shop',
    parent: null,
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });
  const coffee = await createCategory({
    name: 'Coffee & Tea',
    parent: String(shop._id),
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });
  const beans = await createCategory({
    name: 'Beans',
    parent: String(coffee._id),
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });
  return { shop, coffee, beans };
}

const roastDef = () =>
  createAttributeDefinition({
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

const weightDef = () =>
  createAttributeDefinition({
    key: 'weight_g',
    label: 'Weight',
    type: 'number',
    unit: 'g',
    options: [
      { value: '250', label: '250 g', order: 0 },
      { value: '1000', label: '1 kg', order: 1 },
    ],
    isFilterable: true,
    isSearchable: false,
    isVariantAxis: true,
    filterUi: 'checkbox',
    validation: { requiredByDefault: false },
  });

describe('an admin defines a kind of product the code has never heard of', () => {
  it('binds an attribute high in the tree and it applies all the way down', async () => {
    const { shop, coffee, beans } = await coffeeTree();
    const roast = await roastDef();
    const weight = await weightDef();

    await bindAttribute(String(coffee._id), {
      defId: String(roast._id),
      required: false,
      order: 0,
    });
    await bindAttribute(String(beans._id), {
      defId: String(weight._id),
      required: false,
      order: 1,
    });

    const atBeans = await resolveEffectiveAttributes(String(beans._id));
    expect(atBeans.attributes.map((a) => a.key)).toEqual(['roast', 'weight_g']);

    // Inheritance is visible, so the admin form can say where a field came from rather
    // than presenting inherited and local attributes as if they were the same thing.
    const inherited = atBeans.attributes.find((a) => a.key === 'roast');
    expect(inherited?.inheritedFrom).toEqual({ id: String(coffee._id), name: 'Coffee & Tea' });
    expect(atBeans.attributes.find((a) => a.key === 'weight_g')?.inheritedFrom).toBeNull();

    // A sibling branch is unaffected: this is a tree, not a global schema.
    const atShop = await resolveEffectiveAttributes(String(shop._id));
    expect(atShop.attributes).toHaveLength(0);
  });

  it('lets a branch suppress an inherited attribute and rebind it differently', async () => {
    const { coffee, beans } = await coffeeTree();
    const roast = await roastDef();

    await bindAttribute(String(coffee._id), {
      defId: String(roast._id),
      required: false,
      order: 0,
    });
    await setSuppressedKeys(String(beans._id), ['roast']);
    expect((await resolveEffectiveAttributes(String(beans._id))).attributes).toHaveLength(0);

    // Rebinding lifts the suppression, which is what makes "inherit it, but required
    // and in a different group here" expressible.
    await bindAttribute(String(beans._id), {
      defId: String(roast._id),
      required: true,
      order: 0,
      group: 'Roasting',
    });
    const rebound = (await resolveEffectiveAttributes(String(beans._id))).attributes;
    expect(rebound).toHaveLength(1);
    expect(rebound[0]).toMatchObject({ key: 'roast', required: true, group: 'Roasting' });
  });

  it('stores a product against attributes that did not exist when the code was written', async () => {
    const { coffee, beans } = await coffeeTree();
    const roast = await roastDef();
    const weight = await weightDef();
    await bindAttribute(String(coffee._id), {
      defId: String(roast._id),
      required: false,
      order: 0,
    });
    await bindAttribute(String(beans._id), {
      defId: String(weight._id),
      required: false,
      order: 1,
    });

    const product = await createProduct({
      title: 'Ethiopia, Yirgacheffe',
      categoryId: String(beans._id),
      status: 'active',
      attributes: { roast: 'medium', weight_g: 250 },
      variantAxes: ['weight_g'],
      variants: [
        {
          axisValues: [{ key: 'weight_g', value: '250' }],
          price: { amount: 1800, currency: 'USD' },
          stock: { onHand: 12, lowStockThreshold: 3, backorderable: false },
          imagePublicIds: [],
          status: 'active',
          position: 0,
        },
        {
          axisValues: [{ key: 'weight_g', value: '1000' }],
          price: { amount: 6000, currency: 'USD' },
          stock: { onHand: 4, lowStockThreshold: 3, backorderable: false },
          imagePublicIds: [],
          status: 'active',
          position: 1,
        },
      ],
      images: [],
    });

    expect(product.slug).toBe('ethiopia-yirgacheffe');
    expect(product.needsAttention).toBe(false);

    // Values landed in typed slots with their rendered form denormalised.
    const stored = Object.fromEntries(product.attributes.map((a) => [a.key, a]));
    expect(stored.roast).toMatchObject({ valueString: 'medium', displayValue: 'Medium' });
    expect(stored.weight_g).toMatchObject({ valueNumber: 250, displayValue: '250 g' });

    // The denormalised listing fields the card reads.
    expect(product.priceRange).toMatchObject({ min: 1800, max: 6000, currency: 'USD' });
    expect(product.inStock).toBe(true);

    // available is stored, not derived, and starts equal to onHand.
    expect(product.variants.map((v) => v.stock.available)).toEqual([12, 4]);
    expect(product.defaultVariantId).toBeDefined();

    // The branch predicate the whole materialised-ancestry design exists for.
    const inBranch = await Product.find({ categoryAncestors: coffee._id }).lean();
    expect(inBranch).toHaveLength(1);
  });
});

describe('adding a required attribute does not break what is already there', () => {
  it('flags existing products instead of invalidating them', async () => {
    const { beans } = await coffeeTree();
    const roast = await roastDef();
    await bindAttribute(String(beans._id), { defId: String(roast._id), required: false, order: 0 });

    const product = await createProduct({
      title: 'House blend',
      categoryId: String(beans._id),
      status: 'active',
      attributes: { roast: 'dark' },
      variantAxes: [],
      variants: [
        {
          axisValues: [],
          price: { amount: 1400, currency: 'USD' },
          stock: { onHand: 5, lowStockThreshold: 3, backorderable: false },
          imagePublicIds: [],
          status: 'active',
          position: 0,
        },
      ],
      images: [],
    });
    expect(product.needsAttention).toBe(false);

    // The moment that would be a migration in a rigid schema: a new *required*
    // attribute arrives in a category that already holds live products.
    const process = await createAttributeDefinition({
      key: 'process',
      label: 'Process',
      type: 'select',
      options: [
        { value: 'washed', label: 'Washed', order: 0 },
        { value: 'natural', label: 'Natural', order: 1 },
      ],
      isFilterable: true,
      isSearchable: false,
      isVariantAxis: false,
      filterUi: 'checkbox',
      validation: { requiredByDefault: true },
    });
    await bindAttribute(String(beans._id), {
      defId: String(process._id),
      required: true,
      order: 1,
    });

    // The product still saves, still sells, and now says what it is missing.
    const touched = await updateProduct(String(product._id), { subtitle: 'A daily cup' });
    expect(touched.status).toBe('active');
    expect(touched.needsAttention).toBe(true);
    expect(touched.validationIssues.map((i) => i.key)).toEqual(['process']);
    expect(touched.validationIssues[0]?.message).toContain('Process is required');

    // And filling it in clears the flag.
    const fixed = await updateProduct(String(product._id), {
      attributes: { roast: 'dark', process: 'washed' },
    });
    expect(fixed.needsAttention).toBe(false);
    expect(fixed.validationIssues).toHaveLength(0);
  });

  it('refuses the same write when the category asked for strict mode', async () => {
    const { beans } = await coffeeTree();
    const roast = await roastDef();
    await updateCategory(String(beans._id), { validationMode: 'strict' });
    await bindAttribute(String(beans._id), { defId: String(roast._id), required: true, order: 0 });

    await expect(
      createProduct({
        title: 'Nameless',
        categoryId: String(beans._id),
        status: 'draft',
        attributes: {},
        variantAxes: [],
        variants: [],
        images: [],
      }),
    ).rejects.toThrow();
  });
});

describe('moving things around keeps the catalogue coherent', () => {
  it('rewrites descendant paths and every affected product’s ancestry', async () => {
    const { shop, coffee, beans } = await coffeeTree();
    expect(beans.path).toBe('shop/coffee-tea/beans');

    const product = await createProduct({
      title: 'Single origin',
      categoryId: String(beans._id),
      status: 'active',
      attributes: {},
      variantAxes: [],
      variants: [],
      images: [],
    });

    // Rename the middle of the tree: the leaf's path has to follow.
    await updateCategory(String(coffee._id), { name: 'Coffee and Tea' });

    const movedBeans = await Category.findById(beans._id).lean();
    expect(movedBeans?.path).toBe('shop/coffee-and-tea/beans');

    // Now reparent the leaf to the root of the shop.
    await moveCategory(String(beans._id), String(shop._id));

    const reparented = await Category.findById(beans._id).lean();
    expect(reparented?.path).toBe('shop/beans');
    expect(reparented?.depth).toBe(1);
    expect(reparented?.ancestors.map(String)).toEqual([String(shop._id), String(beans._id)]);

    // The product's denormalised copy moved with it, or every branch listing would be
    // quietly wrong from here on.
    const after = await Product.findById(product._id).lean();
    expect(after?.categoryAncestors.map(String)).toEqual([String(shop._id), String(beans._id)]);
  });

  it('refuses to move a category inside its own subtree', async () => {
    const { coffee, beans } = await coffeeTree();
    await expect(moveCategory(String(coffee._id), String(beans._id))).rejects.toThrow(
      /cannot be moved inside itself/,
    );
  });

  it('drops values the destination category does not use, and says so', async () => {
    const { shop, beans } = await coffeeTree();
    const roast = await roastDef();
    await bindAttribute(String(beans._id), { defId: String(roast._id), required: false, order: 0 });

    const product = await createProduct({
      title: 'Wandering bag',
      categoryId: String(beans._id),
      status: 'active',
      attributes: { roast: 'light' },
      variantAxes: [],
      variants: [],
      images: [],
    });
    expect(product.attributes).toHaveLength(1);

    const moved = await recategoriseProduct(String(product._id), String(shop._id));

    expect(moved.attributes).toHaveLength(0);
    expect(moved.needsAttention).toBe(true);
    expect(moved.validationIssues[0]).toMatchObject({ key: 'roast', code: 'unknown_attribute' });
  });
});

describe('the cache cannot serve a previous answer', () => {
  it('reflects a new binding immediately', async () => {
    const { beans } = await coffeeTree();

    // Populate the cache with the empty answer first, so a stale read would be visible.
    expect((await resolveEffectiveAttributes(String(beans._id))).attributes).toHaveLength(0);

    const roast = await roastDef();
    await bindAttribute(String(beans._id), { defId: String(roast._id), required: false, order: 0 });

    // Bumping the version counter makes every existing key unreachable rather than
    // evicting anything, so there is no invalidation fan-out to get wrong.
    expect((await resolveEffectiveAttributes(String(beans._id))).attributes).toHaveLength(1);
  });

  it('reflects an edited definition immediately', async () => {
    const { beans } = await coffeeTree();
    const roast = await roastDef();
    await bindAttribute(String(beans._id), { defId: String(roast._id), required: false, order: 0 });

    const before = await resolveEffectiveAttributes(String(beans._id));
    expect(before.attributes[0]?.options).toHaveLength(3);

    const { updateAttributeDefinition } = await import('./attribute-definition.service.js');
    await updateAttributeDefinition(String(roast._id), {
      options: [
        { value: 'light', label: 'Light', order: 0 },
        { value: 'medium', label: 'Medium', order: 1 },
        { value: 'dark', label: 'Dark', order: 2 },
        { value: 'french', label: 'French', order: 3 },
      ],
    });

    const after = await resolveEffectiveAttributes(String(beans._id));
    expect(after.attributes[0]?.options).toHaveLength(4);
  });
});
