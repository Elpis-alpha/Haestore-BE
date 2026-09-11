import type { Money } from '../../lib/money.js';

/**
 * The shapes the cart's pure logic works in.
 *
 * Deliberately plain objects rather than Mongoose documents: merge.ts and repricing.ts
 * are the two files where a mistake is a wrong total or a silently doubled order, so
 * they are written as functions over data and tested as such. The service layer is the
 * only place that knows about documents, sessions and transactions.
 */

/** One row, as stored. */
export type CartLine = {
  lineKey: string;
  productId: string;
  variantId: string;
  sku: string;
  /** Snapshotted so an archived product can still be named in the bag. */
  title: string;
  slug: string;
  axisValues: { key: string; value: string }[];
  imagePublicId?: string;
  /**
   * **What the shopper last saw, never what they are charged.**
   *
   * Every read re-prices from the catalogue (repricing.ts) and every merge adopts the
   * current price. This snapshot exists only so the difference can be *stated* — "was
   * $18, now $20" — which is the one thing a live-only price cannot say. The 2022 cart
   * made the opposite mistake in the other direction: it stored the extended line total
   * in a field called `price` and recovered the unit price by dividing by quantity.
   */
  unitPrice: Money;
  quantity: number;
  addedAt: Date;
};

/** What the catalogue currently says about one variant. */
export type LiveVariant = {
  lineKey: string;
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  slug: string;
  axisValues: { key: string; value: string }[];
  imagePublicId?: string;
  price: Money;
  /** On hand minus what is already reserved for somebody else's order. */
  available: number;
  backorderable: boolean;
  lowStockThreshold: number;
  /** The product is active *and* the variant is active. Either being false sells nothing. */
  sellable: boolean;
};

export type LiveCatalogue = Map<string, LiveVariant>;

/**
 * Everything that can happen to a line that is not "nothing".
 *
 * One flat vocabulary, shared by the merge report and the re-pricing notices, because
 * they say the same things to the same shopper and two enums would drift. Each is
 * phrased as a fact about the line rather than an instruction, so the frontend decides
 * how loudly to say it.
 */
export type LineChange =
  | { kind: 'added' }
  | { kind: 'quantity_raised'; from: number; to: number }
  | { kind: 'price_changed'; from: Money; to: Money }
  | { kind: 'clamped'; from: number; to: number; available: number }
  | { kind: 'saved_for_later'; reason: 'out_of_stock' }
  | { kind: 'dropped'; reason: 'unavailable' | 'currency' };

export type LineReport = {
  lineKey: string;
  title: string;
  axisValues: { key: string; value: string }[];
  changes: LineChange[];
};
