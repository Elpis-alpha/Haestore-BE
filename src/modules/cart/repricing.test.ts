import { describe, expect, it } from 'vitest';
import { MAX_LINE_QUANTITY, repriceCart } from './repricing.js';
import { lineKeyOf } from './line-key.js';
import type { CartLine, LiveCatalogue, LiveVariant } from './cart-types.js';

const P1 = '65a000000000000000000001';
const V1 = '65b000000000000000000001';
const P2 = '65a000000000000000000002';
const V2 = '65b000000000000000000002';

const usd = (amount: number) => ({ amount, currency: 'USD' });

function line(overrides: Partial<CartLine> = {}): CartLine {
  const productId = overrides.productId ?? P1;
  const variantId = overrides.variantId ?? V1;
  return {
    lineKey: lineKeyOf(productId, variantId),
    productId,
    variantId,
    sku: 'SKU-1',
    title: 'House Blend',
    slug: 'house-blend',
    axisValues: [],
    unitPrice: usd(1800),
    quantity: 1,
    addedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function live(...variants: Partial<LiveVariant>[]): LiveCatalogue {
  const map: LiveCatalogue = new Map();
  for (const v of variants) {
    const productId = v.productId ?? P1;
    const variantId = v.variantId ?? V1;
    const lineKey = lineKeyOf(productId, variantId);
    map.set(lineKey, {
      lineKey,
      productId,
      variantId,
      sku: 'SKU-1',
      title: 'House Blend',
      slug: 'house-blend',
      axisValues: [],
      price: usd(1800),
      available: 10,
      backorderable: false,
      lowStockThreshold: 3,
      sellable: true,
      ...v,
    });
  }
  return map;
}

const cart = (lines: CartLine[], savedForLater: CartLine[] = []) => ({
  lines,
  savedForLater,
  currency: 'USD',
});

describe('repriceCart', () => {
  it('multiplies, and never divides', () => {
    // The 2022 cart stored the extended total and recovered the unit price by dividing
    // by quantity. Three at $9.99 is the case that made that look like it worked.
    const result = repriceCart(
      cart([line({ unitPrice: usd(999), quantity: 3 })]),
      live({ price: usd(999) }),
    );

    expect(result.lines[0]?.lineTotal).toEqual(usd(2997));
    expect(result.lines[0]?.unitPrice).toEqual(usd(999));
    expect(result.subtotal).toEqual(usd(2997));
  });

  it('prices from the catalogue, not from the stored snapshot', () => {
    const result = repriceCart(
      cart([line({ unitPrice: usd(1800), quantity: 2 })]),
      live({ price: usd(2000) }),
    );

    expect(result.lines[0]?.unitPrice).toEqual(usd(2000));
    expect(result.lines[0]?.lineTotal).toEqual(usd(4000));
    expect(result.lines[0]?.changes).toContainEqual({
      kind: 'price_changed',
      from: usd(1800),
      to: usd(2000),
    });
    expect(result.needsAttention).toBe(true);
  });

  it('leaves the quantity as the shopper typed it and clamps only the total', () => {
    const result = repriceCart(cart([line({ quantity: 9 })]), live({ available: 4 }));

    expect(result.lines[0]?.quantity).toBe(9);
    expect(result.lines[0]?.sellableQuantity).toBe(4);
    expect(result.lines[0]?.lineTotal).toEqual(usd(7200));
    expect(result.itemCount).toBe(4);
  });

  it('counts pieces, not rows', () => {
    const result = repriceCart(
      cart([line({ quantity: 3 }), line({ productId: P2, variantId: V2, quantity: 2 })]),
      live({}, { productId: P2, variantId: V2 }),
    );

    expect(result.itemCount).toBe(5);
  });

  it('sums the subtotal across lines', () => {
    const result = repriceCart(
      cart([
        line({ quantity: 2 }),
        line({ productId: P2, variantId: V2, unitPrice: usd(4500), quantity: 1 }),
      ]),
      live({ price: usd(1800) }, { productId: P2, variantId: V2, price: usd(4500) }),
    );

    expect(result.subtotal).toEqual(usd(8100));
  });

  it('keeps an unavailable line visible, at zero, and flags it', () => {
    const result = repriceCart(cart([line({ quantity: 2 })]), live({ sellable: false }));

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.lineTotal).toEqual(usd(0));
    expect(result.lines[0]?.sellableQuantity).toBe(0);
    expect(result.lines[0]?.available).toBeNull();
    expect(result.lines[0]?.maxQuantity).toBe(0);
    expect(result.lines[0]?.changes).toEqual([{ kind: 'dropped', reason: 'unavailable' }]);
    expect(result.subtotal).toEqual(usd(0));
  });

  it('excludes an unavailable line from the subtotal without excluding it from the cart', () => {
    const result = repriceCart(
      cart([line({ quantity: 1 }), line({ productId: P2, variantId: V2, quantity: 1 })]),
      live({ sellable: false }, { productId: P2, variantId: V2, price: usd(4500) }),
    );

    expect(result.lines).toHaveLength(2);
    expect(result.subtotal).toEqual(usd(4500));
  });

  it('flags an out-of-stock line and sells none of it', () => {
    const result = repriceCart(cart([line({ quantity: 2 })]), live({ available: 0 }));

    expect(result.lines[0]?.sellableQuantity).toBe(0);
    expect(result.lines[0]?.changes).toContainEqual({
      kind: 'saved_for_later',
      reason: 'out_of_stock',
    });
  });

  it('lets a backorderable line exceed what is on the shelf', () => {
    const result = repriceCart(
      cart([line({ quantity: 12 })]),
      live({ available: 0, backorderable: true }),
    );

    expect(result.lines[0]?.sellableQuantity).toBe(12);
    expect(result.lines[0]?.maxQuantity).toBe(MAX_LINE_QUANTITY);
    expect(result.lines[0]?.changes).toEqual([]);
  });

  it('caps maxQuantity at the hard line limit even with deep stock', () => {
    const result = repriceCart(cart([line()]), live({ available: 5000 }));
    expect(result.lines[0]?.maxQuantity).toBe(MAX_LINE_QUANTITY);
  });

  it('refuses to price a line whose currency changed under it', () => {
    const result = repriceCart(
      cart([line({ quantity: 2 })]),
      live({ price: { amount: 1800, currency: 'EUR' } }),
    );

    expect(result.lines[0]?.changes).toEqual([{ kind: 'dropped', reason: 'currency' }]);
    expect(result.subtotal).toEqual(usd(0));
  });

  it('re-prices saved lines too, and leaves them out of the totals', () => {
    const result = repriceCart(
      cart([], [line({ quantity: 3, unitPrice: usd(1800) })]),
      live({ price: usd(2000) }),
    );

    expect(result.savedForLater[0]?.unitPrice).toEqual(usd(2000));
    expect(result.itemCount).toBe(0);
    expect(result.subtotal).toEqual(usd(0));
    // A saved line is not in the bag, so it cannot be what needs attention in it.
    expect(result.needsAttention).toBe(false);
  });

  it('refreshes the snapshot from the catalogue', () => {
    const result = repriceCart(
      cart([line({ title: 'Old name', slug: 'old-name' })]),
      live({ title: 'House Blend', slug: 'house-blend', imagePublicId: 'haestore/x' }),
    );

    expect(result.lines[0]?.title).toBe('House Blend');
    expect(result.lines[0]?.slug).toBe('house-blend');
    expect(result.lines[0]?.imagePublicId).toBe('haestore/x');
  });

  it('is quiet about a cart with nothing wrong with it', () => {
    const result = repriceCart(cart([line({ quantity: 2 })]), live({}));

    expect(result.lines[0]?.changes).toEqual([]);
    expect(result.needsAttention).toBe(false);
    expect(result.subtotal).toEqual(usd(3600));
  });

  it('returns a zero subtotal in the cart currency when empty', () => {
    const result = repriceCart(cart([]), live());
    expect(result.subtotal).toEqual(usd(0));
    expect(result.itemCount).toBe(0);
  });
});
