import type { CartLine, LineChange, LineReport, LiveCatalogue, LiveVariant } from './cart-types.js';

/**
 * Combining a guest cart with an account's cart.
 *
 * A pure function over three inputs — what the guest had, what the account had, and
 * what the shop currently sells — returning what the cart becomes and a report of every
 * way it differs from either input. It is pure because this is the one piece of cart
 * logic whose bugs are invisible: a merge that silently doubles a quantity produces a
 * perfectly valid cart, and the customer finds out at the payment screen or not at all.
 *
 * **A quantity collision takes MAX, not SUM.** The dominant real case is one person, one
 * device, one intent: they added coffee while signed out, then signed in on the same
 * browser where they had already added it. SUM turns that into six bags. MAX preserves
 * "I want roughly this many" and can never inflate a total unasked. The genuine
 * two-device case — 2 on the laptop, 3 on the phone, wanting 5 — is rarer, is visible
 * in the report, and is one edit to fix. The two errors are not symmetric: undercounting
 * is a shopper adding one more, overcounting is a shopper paying for something they did
 * not order.
 *
 * Nothing here reserves stock. Reservation belongs to checkout (Phase 7), where it is
 * held against a real order for a bounded time; a cart that reserved would let anyone
 * empty the shelves for free by filling a basket and leaving.
 */

export type MergeInput = {
  guestLines: CartLine[];
  guestSaved: CartLine[];
  userLines: CartLine[];
  userSaved: CartLine[];
  live: LiveCatalogue;
};

export type MergeResult = {
  lines: CartLine[];
  savedForLater: CartLine[];
  report: LineReport[];
};

export function mergeCarts(input: MergeInput): MergeResult {
  const { live } = input;

  const guest = byKey(input.guestLines);
  const user = byKey(input.userLines);

  const lines: CartLine[] = [];
  const savedForLater: CartLine[] = [];
  const report: LineReport[] = [];

  /**
   * The account's own lines first, in their existing order, then whatever the guest
   * cart adds. Signing in should not reshuffle a basket that was already there — the
   * new arrivals collect at the bottom where they are easy to see.
   */
  for (const lineKey of [...user.keys(), ...guest.keys()].filter(unique)) {
    const mine = user.get(lineKey);
    const theirs = guest.get(lineKey);
    const base = mine ?? theirs;
    /* c8 ignore next */
    if (!base) continue;

    const changes: LineChange[] = [];
    const current = live.get(lineKey);

    // Gone, drafted, archived, or the variant deleted from the grid. Named in the
    // report rather than quietly vanishing: a bag that is one item shorter than the
    // shopper left it, with no explanation, is indistinguishable from a bug.
    if (!current || !current.sellable) {
      report.push(rowFor(base, [{ kind: 'dropped', reason: 'unavailable' }]));
      continue;
    }

    // One shop, one currency — but the currency lives in the data rather than being
    // baked in, so a change is representable and must not be merged past silently.
    if (current.price.currency.toUpperCase() !== base.unitPrice.currency.toUpperCase()) {
      report.push(rowFor(base, [{ kind: 'dropped', reason: 'currency' }]));
      continue;
    }

    if (!mine) changes.push({ kind: 'added' });

    const wanted = Math.max(mine?.quantity ?? 0, theirs?.quantity ?? 0);
    if (mine && wanted > mine.quantity) {
      changes.push({ kind: 'quantity_raised', from: mine.quantity, to: wanted });
    }

    // Always the current price, never the snapshot. The snapshot is what makes the
    // difference sayable; it is never what anyone is charged.
    if (current.price.amount !== base.unitPrice.amount) {
      changes.push({
        kind: 'price_changed',
        from: base.unitPrice,
        to: current.price,
      });
    }

    const merged: CartLine = {
      ...base,
      ...snapshotOf(current),
      quantity: wanted,
      // The earlier of the two, so "added 20 minutes ago" survives signing in.
      addedAt: earliest(mine?.addedAt, theirs?.addedAt) ?? base.addedAt,
    };

    if (current.available <= 0 && !current.backorderable) {
      // Moved, not deleted. Somebody put it there on purpose and the shop may restock;
      // deleting it makes that decision for them and cannot be undone from the UI.
      changes.push({ kind: 'saved_for_later', reason: 'out_of_stock' });
      savedForLater.push(merged);
      report.push(rowFor(merged, changes));
      continue;
    }

    if (!current.backorderable && wanted > current.available) {
      changes.push({
        kind: 'clamped',
        from: wanted,
        to: current.available,
        available: current.available,
      });
      merged.quantity = current.available;
    }

    lines.push(merged);
    if (changes.length > 0) report.push(rowFor(merged, changes));
  }

  /**
   * Saved-for-later from both sides, minus anything that ended up in the cart proper.
   *
   * A line the shopper had saved on one side and active on the other belongs in the
   * cart: they moved it *back*, and the save is the older decision. This runs after the
   * loop above so `lines` is already final.
   */
  const inCart = new Set(lines.map((l) => l.lineKey));
  const saved = byKey([...input.userSaved, ...input.guestSaved]);
  for (const [lineKey, line] of saved) {
    if (inCart.has(lineKey)) continue;
    if (savedForLater.some((l) => l.lineKey === lineKey)) continue;
    const current = live.get(lineKey);
    if (!current || !current.sellable) continue;
    savedForLater.push({ ...line, ...snapshotOf(current) });
  }

  return { lines, savedForLater, report };
}

/**
 * Re-snapshots the display fields from the catalogue.
 *
 * A title or a photograph that changed while the cart sat is worth carrying across;
 * the price is handled above, because that one has to be *reported* as well as applied.
 */
function snapshotOf(current: LiveVariant): Partial<CartLine> {
  return {
    sku: current.sku,
    title: current.title,
    slug: current.slug,
    axisValues: current.axisValues,
    ...(current.imagePublicId ? { imagePublicId: current.imagePublicId } : {}),
    unitPrice: current.price,
  };
}

/**
 * Last write wins on a duplicate key.
 *
 * The stored shape cannot contain one — `lineKey` is unique within a cart by
 * construction — but this also consumes the concatenation of two saved-for-later lists,
 * where a collision is normal.
 */
function byKey(lines: CartLine[]): Map<string, CartLine> {
  const map = new Map<string, CartLine>();
  for (const line of lines) {
    const existing = map.get(line.lineKey);
    map.set(
      line.lineKey,
      existing ? { ...line, quantity: Math.max(existing.quantity, line.quantity) } : line,
    );
  }
  return map;
}

function rowFor(line: CartLine, changes: LineChange[]): LineReport {
  return {
    lineKey: line.lineKey,
    title: line.title,
    axisValues: line.axisValues,
    changes,
  };
}

const unique = <T>(value: T, index: number, all: T[]) => all.indexOf(value) === index;

function earliest(a?: Date, b?: Date): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}
