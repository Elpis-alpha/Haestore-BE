import { addMoney, multiplyMoney, type Money } from '../../lib/money.js';
import type { CartLine, LineChange, LiveCatalogue } from './cart-types.js';

/**
 * Every read of a cart re-prices it from the catalogue.
 *
 * The alternative — trusting the stored line price until checkout — is how a shopper
 * reaches the payment screen and discovers a different number than the one they have
 * been looking at for ten minutes. Re-pricing on read means the bag is *always* showing
 * live figures, and the stored snapshot's only job is to let the difference be named.
 *
 * **This function does not change the cart.** It reports. A quantity that exceeds what
 * is on the shelf stays as the shopper typed it, flagged, and `sellableQuantity` carries
 * what could actually be bought — so the total is honest without the basket silently
 * editing itself while somebody is looking at it. Checkout (Phase 7) is where a line
 * that cannot be fulfilled becomes a refusal rather than a notice.
 */

export type PricedLine = CartLine & {
  /** What this line would cost right now: unit price times what can actually be sold. */
  lineTotal: Money;
  /** Clamped to stock. Equal to `quantity` on a line with no problem. */
  sellableQuantity: number;
  /** Null once a variant has stopped selling; the line is still shown, and named. */
  available: number | null;
  lowStockThreshold: number;
  backorderable: boolean;
  /** The most this line may be raised to from the cart UI. */
  maxQuantity: number;
  changes: LineChange[];
};

export type PricedCart = {
  lines: PricedLine[];
  savedForLater: PricedLine[];
  subtotal: Money;
  /** Total pieces, not rows — what the header's bag counts. */
  itemCount: number;
  currency: string;
  /** True when any line carries a change the shopper should resolve before paying. */
  needsAttention: boolean;
};

/** The cap on one line, so a stepper cannot be driven to a number nothing can fill. */
export const MAX_LINE_QUANTITY = 99;

export function repriceCart(
  cart: { lines: CartLine[]; savedForLater: CartLine[]; currency: string },
  live: LiveCatalogue,
): PricedCart {
  const lines = cart.lines.map((line) => price(line, live));
  const savedForLater = cart.savedForLater.map((line) => price(line, live));

  const zero: Money = { amount: 0, currency: cart.currency };
  const subtotal = lines.reduce<Money>(
    (total, line) =>
      sameCurrency(line.lineTotal, total) ? addMoney(total, line.lineTotal) : total,
    zero,
  );

  return {
    lines,
    savedForLater,
    subtotal,
    // Saved lines are deliberately not counted. They are not in the bag; a badge that
    // includes them would promise a total the checkout will not charge.
    itemCount: lines.reduce((n, line) => n + line.sellableQuantity, 0),
    currency: cart.currency,
    needsAttention: lines.some((line) => line.changes.length > 0),
  };
}

function price(line: CartLine, live: LiveCatalogue): PricedLine {
  const current = live.get(line.lineKey);
  const changes: LineChange[] = [];

  if (!current || !current.sellable) {
    // Priced at zero because it cannot be sold, and kept visible because the shopper
    // put it there. Removing it on their behalf would make the bag change on its own.
    return {
      ...line,
      lineTotal: { amount: 0, currency: line.unitPrice.currency },
      sellableQuantity: 0,
      available: null,
      lowStockThreshold: 0,
      backorderable: false,
      maxQuantity: 0,
      changes: [{ kind: 'dropped', reason: 'unavailable' }],
    };
  }

  if (current.price.currency.toUpperCase() !== line.unitPrice.currency.toUpperCase()) {
    return {
      ...line,
      lineTotal: { amount: 0, currency: line.unitPrice.currency },
      sellableQuantity: 0,
      available: current.available,
      lowStockThreshold: current.lowStockThreshold,
      backorderable: current.backorderable,
      maxQuantity: 0,
      changes: [{ kind: 'dropped', reason: 'currency' }],
    };
  }

  if (current.price.amount !== line.unitPrice.amount) {
    changes.push({ kind: 'price_changed', from: line.unitPrice, to: current.price });
  }

  const ceiling = current.backorderable
    ? MAX_LINE_QUANTITY
    : Math.min(MAX_LINE_QUANTITY, current.available);

  let sellableQuantity = line.quantity;

  if (!current.backorderable && current.available <= 0) {
    changes.push({ kind: 'saved_for_later', reason: 'out_of_stock' });
    sellableQuantity = 0;
  } else if (line.quantity > ceiling) {
    changes.push({
      kind: 'clamped',
      from: line.quantity,
      to: ceiling,
      available: current.available,
    });
    sellableQuantity = ceiling;
  }

  return {
    ...line,
    sku: current.sku,
    title: current.title,
    slug: current.slug,
    axisValues: current.axisValues,
    ...(current.imagePublicId ? { imagePublicId: current.imagePublicId } : {}),
    unitPrice: current.price,
    lineTotal: multiplyMoney(current.price, sellableQuantity),
    sellableQuantity,
    available: current.available,
    lowStockThreshold: current.lowStockThreshold,
    backorderable: current.backorderable,
    maxQuantity: ceiling,
    changes,
  };
}

const sameCurrency = (a: Money, b: Money) => a.currency.toUpperCase() === b.currency.toUpperCase();
