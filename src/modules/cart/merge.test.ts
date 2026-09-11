import { describe, expect, it } from 'vitest';
import { mergeCarts } from './merge.js';
import { lineKeyOf } from './line-key.js';
import type { CartLine, LiveCatalogue, LiveVariant } from './cart-types.js';

/**
 * The merge, branch by branch.
 *
 * Every one of these is a case the plan named as a unit test, and each is a way a
 * merge can be wrong without anything throwing: a doubled quantity, a stale price, a
 * line that vanished, a line that was silently deleted rather than saved. None of them
 * would show up in an integration test that only asserts "the cart merged".
 */

const P1 = '65a000000000000000000001';
const V1 = '65b000000000000000000001';
const V2 = '65b000000000000000000002';
const P2 = '65a000000000000000000002';
const V3 = '65b000000000000000000003';

const usd = (amount: number) => ({ amount, currency: 'USD' });

function line(overrides: Partial<CartLine> & { productId: string; variantId: string }): CartLine {
  const lineKey = lineKeyOf(overrides.productId, overrides.variantId);
  return {
    lineKey,
    sku: 'SKU-1',
    title: 'House Blend',
    slug: 'house-blend',
    axisValues: [{ key: 'grind', value: 'whole' }],
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
      axisValues: [{ key: 'grind', value: 'whole' }],
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

const empty = { guestLines: [], guestSaved: [], userLines: [], userSaved: [] };

describe('mergeCarts', () => {
  it('reassigns a guest cart when the account has none', () => {
    const result = mergeCarts({
      ...empty,
      guestLines: [line({ productId: P1, variantId: V1, quantity: 2 })],
      live: live({}),
    });

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.quantity).toBe(2);
    expect(result.report[0]?.changes).toEqual([{ kind: 'added' }]);
  });

  it('takes the maximum on a collision, never the sum', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, quantity: 2 })],
      guestLines: [line({ productId: P1, variantId: V1, quantity: 3 })],
      live: live({}),
    });

    expect(result.lines).toHaveLength(1);
    // The whole argument of the design: 5 here would be a silently doubled order.
    expect(result.lines[0]?.quantity).toBe(3);
    expect(result.report[0]?.changes).toContainEqual({
      kind: 'quantity_raised',
      from: 2,
      to: 3,
    });
  });

  it('leaves the account quantity alone when it is already the larger', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, quantity: 4 })],
      guestLines: [line({ productId: P1, variantId: V1, quantity: 1 })],
      live: live({}),
    });

    expect(result.lines[0]?.quantity).toBe(4);
    // Nothing changed, so the shopper is told nothing.
    expect(result.report).toEqual([]);
  });

  it('drops a line whose variant no longer sells, and says so', () => {
    const result = mergeCarts({
      ...empty,
      guestLines: [line({ productId: P1, variantId: V1, quantity: 1 })],
      live: live({ sellable: false }),
    });

    expect(result.lines).toEqual([]);
    expect(result.report[0]?.changes).toEqual([{ kind: 'dropped', reason: 'unavailable' }]);
  });

  it('drops a line the catalogue has no record of at all', () => {
    const result = mergeCarts({
      ...empty,
      guestLines: [line({ productId: P2, variantId: V3 })],
      live: live({}),
    });

    expect(result.lines).toEqual([]);
    expect(result.report[0]?.changes).toEqual([{ kind: 'dropped', reason: 'unavailable' }]);
  });

  it('adopts the current price and reports the drift', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, unitPrice: usd(1800) })],
      live: live({ price: usd(2000) }),
    });

    expect(result.lines[0]?.unitPrice).toEqual(usd(2000));
    expect(result.report[0]?.changes).toContainEqual({
      kind: 'price_changed',
      from: usd(1800),
      to: usd(2000),
    });
  });

  it('clamps to what is actually on the shelf', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, quantity: 2 })],
      guestLines: [line({ productId: P1, variantId: V1, quantity: 9 })],
      live: live({ available: 4 }),
    });

    expect(result.lines[0]?.quantity).toBe(4);
    expect(result.report[0]?.changes).toContainEqual({
      kind: 'clamped',
      from: 9,
      to: 4,
      available: 4,
    });
  });

  it('does not clamp a backorderable variant', () => {
    const result = mergeCarts({
      ...empty,
      guestLines: [line({ productId: P1, variantId: V1, quantity: 9 })],
      live: live({ available: 0, backorderable: true }),
    });

    expect(result.lines[0]?.quantity).toBe(9);
    expect(result.savedForLater).toEqual([]);
  });

  it('saves an out-of-stock line for later rather than deleting it', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, quantity: 2 })],
      live: live({ available: 0 }),
    });

    expect(result.lines).toEqual([]);
    expect(result.savedForLater).toHaveLength(1);
    expect(result.savedForLater[0]?.quantity).toBe(2);
    expect(result.report[0]?.changes).toContainEqual({
      kind: 'saved_for_later',
      reason: 'out_of_stock',
    });
  });

  it('keeps the account lines first and appends the guest arrivals', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1 })],
      guestLines: [
        line({ productId: P2, variantId: V3, title: 'Celadon Bowl' }),
        line({ productId: P1, variantId: V1 }),
      ],
      live: live({}, { productId: P2, variantId: V3, title: 'Celadon Bowl' }),
    });

    expect(result.lines.map((l) => l.title)).toEqual(['House Blend', 'Celadon Bowl']);
  });

  it('carries the earlier addedAt across', () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-02-01T00:00:00Z');
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, addedAt: newer })],
      guestLines: [line({ productId: P1, variantId: V1, addedAt: older })],
      live: live({}),
    });

    expect(result.lines[0]?.addedAt).toEqual(older);
  });

  it('refreshes the snapshot fields from the catalogue', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, title: 'Old name' })],
      live: live({ title: 'House Blend', imagePublicId: 'haestore/new' }),
    });

    expect(result.lines[0]?.title).toBe('House Blend');
    expect(result.lines[0]?.imagePublicId).toBe('haestore/new');
  });

  it('refuses to merge a line whose currency changed under it', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, unitPrice: usd(1800) })],
      live: live({ price: { amount: 1800, currency: 'EUR' } }),
    });

    expect(result.lines).toEqual([]);
    expect(result.report[0]?.changes).toEqual([{ kind: 'dropped', reason: 'currency' }]);
  });

  it('unions both saved-for-later lists', () => {
    const result = mergeCarts({
      ...empty,
      userSaved: [line({ productId: P1, variantId: V1 })],
      guestSaved: [line({ productId: P2, variantId: V3, title: 'Celadon Bowl' })],
      live: live({}, { productId: P2, variantId: V3, title: 'Celadon Bowl' }),
    });

    expect(result.savedForLater.map((l) => l.lineKey)).toEqual([
      lineKeyOf(P1, V1),
      lineKeyOf(P2, V3),
    ]);
  });

  it('prefers the cart over a save when the same line is in both', () => {
    const result = mergeCarts({
      ...empty,
      userSaved: [line({ productId: P1, variantId: V1 })],
      guestLines: [line({ productId: P1, variantId: V1, quantity: 2 })],
      live: live({}),
    });

    expect(result.lines).toHaveLength(1);
    expect(result.savedForLater).toEqual([]);
  });

  it('reports a line that is raised and re-priced as one row with both changes', () => {
    const result = mergeCarts({
      ...empty,
      userLines: [line({ productId: P1, variantId: V1, quantity: 1, unitPrice: usd(1800) })],
      guestLines: [line({ productId: P1, variantId: V1, quantity: 3 })],
      live: live({ price: usd(2000) }),
    });

    expect(result.report).toHaveLength(1);
    expect(result.report[0]?.changes.map((c) => c.kind)).toEqual([
      'quantity_raised',
      'price_changed',
    ]);
  });

  it('is a no-op on two empty carts', () => {
    const result = mergeCarts({ ...empty, live: live() });
    expect(result).toEqual({ lines: [], savedForLater: [], report: [] });
  });

  it('treats a second copy of a line in one list as a collision, not two rows', () => {
    // The stored shape cannot produce this, but the concatenated saved-for-later lists
    // can, and a duplicate key downstream would violate the cart's own unique index.
    const result = mergeCarts({
      ...empty,
      guestSaved: [
        line({ productId: P1, variantId: V1, quantity: 1 }),
        line({ productId: P1, variantId: V1, quantity: 4 }),
      ],
      live: live({}),
    });

    expect(result.savedForLater).toHaveLength(1);
    expect(result.savedForLater[0]?.quantity).toBe(4);
  });

  it('does not resurrect a saved line whose variant stopped selling', () => {
    const result = mergeCarts({
      ...empty,
      userSaved: [line({ productId: P1, variantId: V1 })],
      live: live({ sellable: false }),
    });

    expect(result.savedForLater).toEqual([]);
  });

  it('keeps two variants of the same product as two lines', () => {
    const result = mergeCarts({
      ...empty,
      guestLines: [line({ productId: P1, variantId: V1 }), line({ productId: P1, variantId: V2 })],
      live: live({ variantId: V1 }, { variantId: V2 }),
    });

    expect(result.lines).toHaveLength(2);
  });
});
