import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { toSearchDocument } from './product-document.js';
import type { ProductAttrs } from '../modules/catalog/product.model.js';

/**
 * The projection into the index.
 *
 * Most of what matters here is what is *absent*: an index that quietly accumulated the
 * variant array and the validation state would become a second copy of the catalogue,
 * and the moment something read a price from it the two would be free to disagree.
 */

const attr = (over: Record<string, unknown>) => ({
  key: 'roast',
  defId: new Types.ObjectId(),
  type: 'select',
  displayValue: 'Dark',
  order: 0,
  ...over,
});

const product = (over: Record<string, unknown> = {}) =>
  ({
    _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
    title: 'Ethiopian Yirgacheffe',
    slug: 'ethiopian-yirgacheffe',
    category: new Types.ObjectId('507f1f77bcf86cd799439012'),
    categoryAncestors: [new Types.ObjectId('507f1f77bcf86cd799439013')],
    status: 'active',
    attributes: [],
    variantAxes: [],
    variants: [],
    images: [],
    priceRange: { min: 1800, max: 3200, currency: 'USD' },
    inStock: true,
    needsAttention: false,
    validationIssues: [],
    ratingAverage: 4.5,
    ratingCount: 12,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    publishedAt: new Date('2026-02-01T00:00:00Z'),
    ...over,
  }) as unknown as ProductAttrs & { _id: unknown };

const none = new Set<string>();

describe('toSearchDocument', () => {
  it('flattens the price range into sortable scalars', () => {
    const doc = toSearchDocument(product(), none);
    expect(doc).toMatchObject({ priceMin: 1800, priceMax: 3200, currency: 'USD' });
  });

  it('emits dates as epoch milliseconds, because Meilisearch sorts numbers', () => {
    const doc = toSearchDocument(product(), none);
    expect(doc.createdAt).toBe(Date.parse('2026-01-01T00:00:00Z'));
    expect(doc.publishedAt).toBe(Date.parse('2026-02-01T00:00:00Z'));
  });

  it('falls back to createdAt when a product was never published', () => {
    // A null sorts to one end in Meilisearch, which would park every such product in a
    // block at the top or bottom of a newest-first listing.
    const doc = toSearchDocument(product({ publishedAt: undefined }), none);
    expect(doc.publishedAt).toBe(doc.createdAt);
  });

  it('puts attribute values under `attr` in the slot their type dictates', () => {
    const doc = toSearchDocument(
      product({
        attributes: [
          attr({ key: 'roast', type: 'select', valueString: 'dark' }),
          attr({ key: 'tags', type: 'multiselect', valueStrings: ['organic', 'fair'] }),
          attr({ key: 'weight_g', type: 'number', valueNumber: 250 }),
          attr({ key: 'dishwasher_safe', type: 'boolean', valueBool: true }),
        ],
      }),
      none,
    );

    expect(doc.attr).toEqual({
      roast: 'dark',
      tags: ['organic', 'fair'],
      weight_g: 250,
      dishwasher_safe: true,
    });
  });

  it('keeps a false boolean, which a truthiness check would drop', () => {
    const doc = toSearchDocument(
      product({
        attributes: [attr({ key: 'dishwasher_safe', type: 'boolean', valueBool: false })],
      }),
      none,
    );
    expect(doc.attr.dishwasher_safe).toBe(false);
  });

  it('keeps a zero, for the same reason', () => {
    const doc = toSearchDocument(
      product({ attributes: [attr({ key: 'caffeine_mg', type: 'number', valueNumber: 0 })] }),
      none,
    );
    expect(doc.attr.caffeine_mg).toBe(0);
  });

  it('omits a dimension, which has no ordering to range over', () => {
    const doc = toSearchDocument(
      product({
        attributes: [
          attr({
            key: 'size',
            type: 'dimension',
            valueDim: { length: 1, width: 2, height: 3, unit: 'cm' },
          }),
        ],
      }),
      none,
    );
    expect(doc.attr).toEqual({});
  });

  it('only puts a display value in the search text when the definition is searchable', () => {
    const attributes = [
      attr({ key: 'roast', displayValue: 'Dark' }),
      attr({ key: 'origin', displayValue: 'Ethiopia' }),
    ];
    expect(toSearchDocument(product({ attributes }), none).attrText).toBeUndefined();
    expect(toSearchDocument(product({ attributes }), new Set(['origin'])).attrText).toBe(
      'Ethiopia',
    );
  });

  it('carries only the first image, ordered by position', () => {
    const doc = toSearchDocument(
      product({
        images: [
          { publicId: 'second', alt: 'b', position: 1 },
          { publicId: 'first', alt: 'a', position: 0 },
        ],
      }),
      none,
    );
    expect(doc.image).toMatchObject({ publicId: 'first', alt: 'a' });
  });

  it('never carries internal or product-page-only state into the index', () => {
    const doc = toSearchDocument(
      product({
        attributes: [attr({})],
        variants: [{ sku: 'X', stock: { onHand: 3 } }],
        validationIssues: [{ key: 'roast', code: 'missing', message: 'x' }],
        needsAttention: true,
      }),
      none,
    ) as unknown as Record<string, unknown>;

    for (const field of ['variants', 'validationIssues', 'needsAttention', 'variantAxes']) {
      expect(doc).not.toHaveProperty(field);
    }
  });

  it('indexes a product with no priceable variant rather than dropping it', () => {
    // Dropping it would be a product that is active, in the shop, and invisible — with
    // nothing anywhere to explain why.
    const doc = toSearchDocument(product({ priceRange: undefined, inStock: false }), none);
    expect(doc.priceMin).toBe(0);
    expect(doc.priceMax).toBe(0);
    expect(doc.currency).toBe('USD');
  });

  it('stamps status as active, since only active products are indexed', () => {
    expect(toSearchDocument(product(), none).status).toBe('active');
  });
});

describe('toSearchDocument — what a product is sold in', () => {
  const variant = (axisValues: { key: string; value: string }[], status = 'active') => ({
    _id: new Types.ObjectId(),
    sku: 'X',
    axisValues,
    price: { amount: 1000, currency: 'USD' },
    stock: { onHand: 1, reserved: 0, available: 1, lowStockThreshold: 3, backorderable: false },
    imagePublicIds: [],
    status,
    position: 0,
  });

  it('makes every active variant’s axis value a filterable fact', () => {
    const doc = toSearchDocument(
      product({
        variantAxes: ['glaze'],
        variants: [
          variant([{ key: 'glaze', value: 'celadon' }]),
          variant([{ key: 'glaze', value: 'tenmoku' }]),
          variant([{ key: 'glaze', value: 'celadon' }]),
        ],
      }),
      none,
      new Map([['glaze', 'color']]),
    );
    expect(doc.attr.glaze).toEqual(['celadon', 'tenmoku']);
  });

  it('indexes a numeric axis as numbers, so a range filter can compare them', () => {
    const doc = toSearchDocument(
      product({
        variantAxes: ['grind', 'weight_g'],
        variants: [
          variant([
            { key: 'grind', value: 'whole' },
            { key: 'weight_g', value: '250' },
          ]),
          variant([
            { key: 'grind', value: 'whole' },
            { key: 'weight_g', value: '1000' },
          ]),
        ],
      }),
      none,
      new Map([
        ['grind', 'select'],
        ['weight_g', 'number'],
      ]),
    );
    expect(doc.attr.weight_g).toEqual([250, 1000]);
    expect(doc.attr.grind).toEqual(['whole']);
  });

  it('leaves out what is not for sale, and never overrides what the product states', () => {
    const doc = toSearchDocument(
      product({
        variantAxes: ['scent'],
        attributes: [
          attr({
            key: 'scent',
            type: 'select',
            valueString: 'unscented',
            displayValue: 'Unscented',
          }),
        ],
        variants: [
          variant([{ key: 'scent', value: 'lavender' }]),
          variant([{ key: 'scent', value: 'vetiver' }], 'inactive'),
        ],
      }),
      none,
      new Map([['scent', 'select']]),
    );
    expect(doc.attr.scent).toBe('unscented');

    const unstated = toSearchDocument(
      product({
        variantAxes: ['scent'],
        variants: [
          variant([{ key: 'scent', value: 'lavender' }]),
          variant([{ key: 'scent', value: 'vetiver' }], 'inactive'),
        ],
      }),
      none,
      new Map([['scent', 'select']]),
    );
    expect(unstated.attr.scent).toEqual(['lavender']);
  });

  it('turns a yes-or-no axis into a boolean only when every variant agrees', () => {
    const one = (values: string[]) =>
      toSearchDocument(
        product({
          variantAxes: ['gift_wrapped'],
          variants: values.map((value) => variant([{ key: 'gift_wrapped', value }])),
        }),
        none,
        new Map([['gift_wrapped', 'boolean']]),
      ).attr.gift_wrapped;
    expect(one(['true'])).toBe(true);
    expect(one(['true', 'false'])).toBeUndefined();
  });
});
