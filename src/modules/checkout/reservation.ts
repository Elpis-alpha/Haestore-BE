import mongoose, { type ClientSession } from 'mongoose';
import { Product } from '../catalog/product.model.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Stock reservation — the half of the cart that Phase 6 deliberately left out.
 *
 * The cart does not reserve, and says so in three places: a reserving cart lets anyone
 * empty the shelves for free by adding items and walking away, and needs a sweeper to
 * give it all back. A reservation is held against a **real order**, which is a thing
 * somebody has committed to, and it is released by the sweeper if payment never arrives.
 *
 * The guard is the one Phase 0's probe proved against a real replica set, and its shape
 * is load-bearing in a way that is easy to undo by accident:
 *
 *     findOneAndUpdate(
 *       { _id, variants: { $elemMatch: { _id: variantId, status: 'active',
 *                                        'stock.available': { $gte: qty } } } },
 *       { $inc: { 'variants.$[v].stock.available': -qty,
 *                 'variants.$[v].stock.reserved':  +qty } },
 *       { arrayFilters: [{ 'v._id': variantId }] },
 *     )
 *
 * **The availability test lives in the filter, so the check and the decrement are one
 * operation.** Reading the stock, deciding in JavaScript and then writing is the same
 * mistake as the order status machine in a different costume — two requests both read
 * 1, both decide "yes", and both decrement. Here the second one matches no document and
 * `null` comes back, which *is* the refusal.
 *
 * This is also why `stock.available` is stored rather than computed as
 * `onHand - reserved`: comparing two fields of the same array element needs `$expr`,
 * and `$expr` is not allowed inside `$elemMatch`. Storing the difference keeps the
 * guard a plain predicate, and therefore atomic for free. See DATA-MODEL.md.
 */

export type ReservationRequest = {
  productId: string;
  variantId: string;
  quantity: number;
};

/** Named so the checkout can tell the shopper *which* line it could not fill. */
export class InsufficientStockError extends AppError {
  readonly lineKey: string;

  constructor(lineKey: string, title: string) {
    super(409, 'INSUFFICIENT_STOCK', `${title} sold out while you were checking out.`, {
      details: { lineKey },
    });
    this.name = 'InsufficientStockError';
    this.lineKey = lineKey;
  }
}

/**
 * Moves `quantity` from available to reserved on one variant.
 *
 * Returns false rather than throwing, because the caller knows which line this was and
 * this function does not.
 */
export async function reserveOne(
  request: ReservationRequest,
  session?: ClientSession,
): Promise<boolean> {
  const variantId = new mongoose.Types.ObjectId(request.variantId);

  const updated = await Product.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(request.productId),
      status: 'active',
      variants: {
        $elemMatch: {
          _id: variantId,
          status: 'active',
          'stock.available': { $gte: request.quantity },
        },
      },
    },
    {
      $inc: {
        'variants.$[v].stock.available': -request.quantity,
        'variants.$[v].stock.reserved': request.quantity,
      },
    },
    {
      arrayFilters: [{ 'v._id': variantId }],
      new: true,
      ...(session ? { session } : {}),
      projection: { _id: 1 },
    },
  );

  return updated !== null;
}

/**
 * Gives `quantity` back to the shelf.
 *
 * Deliberately **unguarded on the reserved count**, and that is not an oversight. The
 * caller has already established, via the order's `stockReserved` flag flipping from
 * true to false exactly once, that this release is the only one. Guarding on
 * `'stock.reserved': { $gte: qty }` as well would turn an administrator's manual stock
 * correction — which can legitimately leave `reserved` looking wrong — into a release
 * that silently does nothing and strands the stock.
 *
 * The floor is enforced by the schema's `min: 0` on both counters, so the worst case is
 * a write that fails loudly rather than a negative availability.
 */
export async function releaseOne(
  request: ReservationRequest,
  session?: ClientSession,
): Promise<boolean> {
  const variantId = new mongoose.Types.ObjectId(request.variantId);

  const updated = await Product.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(request.productId), 'variants._id': variantId },
    {
      $inc: {
        'variants.$[v].stock.available': request.quantity,
        'variants.$[v].stock.reserved': -request.quantity,
      },
    },
    {
      arrayFilters: [{ 'v._id': variantId }],
      new: true,
      ...(session ? { session } : {}),
      projection: { _id: 1 },
    },
  );

  return updated !== null;
}

/**
 * Reserves every line of an order, or none of them.
 *
 * **All-or-nothing, and the rollback is explicit rather than left to the transaction.**
 * Inside `withTransaction` the abort would undo these writes anyway, but this function
 * is also called from the reconcile path where there is no ambient transaction, and a
 * partial reservation there would hold stock for an order that was never created —
 * invisible stock, held forever, with nothing pointing at it.
 *
 * The rollback only covers what this call actually took, so it cannot give back stock
 * that a concurrent order is holding.
 */
export async function reserveAll(
  requests: ReservationRequest[],
  session?: ClientSession,
): Promise<{ ok: true } | { ok: false; failedAt: number }> {
  const taken: ReservationRequest[] = [];

  for (const [index, request] of requests.entries()) {
    if (await reserveOne(request, session)) {
      taken.push(request);
      continue;
    }

    // Undo what this call took. Inside a transaction this is belt and braces; outside
    // one it is the only thing standing between a refused checkout and stranded stock.
    for (const done of taken) {
      await releaseOne(done, session).catch((err: Error) =>
        logger.error(
          { err: err.message, ...done },
          'reservation: rollback failed, stock may be stranded',
        ),
      );
    }

    return { ok: false, failedAt: index };
  }

  return { ok: true };
}

/** Releases every line. Used by the sweeper and by cancellation. */
export async function releaseAll(
  requests: ReservationRequest[],
  session?: ClientSession,
): Promise<void> {
  for (const request of requests) {
    const released = await releaseOne(request, session);
    if (!released) {
      // The product was hard-deleted, which the catalogue does not do — it archives.
      // Worth a loud log rather than a throw: failing the release would leave the order
      // stuck holding a reservation against a variant that no longer exists.
      logger.error({ ...request }, 'reservation: could not release, variant not found');
    }
  }
}

/** A consumption that found fewer units on the shelf, or held, than the order shipped. */
export type ConsumeShortfall = ReservationRequest & { onHand: number; reserved: number };

/**
 * Turns fulfilment into a permanent stock reduction.
 *
 * Shipping is where reserved stock stops being a hold and becomes stock that has left
 * the building: `onHand` and `reserved` both come down, `available` is untouched
 * because the hold already took it out. This is the one place `onHand` moves outside of
 * an admin correction.
 *
 * **Floored at zero, and the floor is in the filter.** An admin who counts the shelf and
 * corrects `onHand` below what paid orders already hold is recording the truth, and the
 * correction is allowed. But `$inc` does not run the schema's `min: 0`, so shipping one of
 * those orders used to drive `onHand` negative — and a product holding a negative count
 * then failed validation on its next save, which locked the admin out of editing the one
 * product that most needed a correction. So the ordinary decrement only matches when both
 * counters can afford it; otherwise the shortfall path sets the counters to what is left,
 * never below zero, and reports it. Shipping is never refused for a bookkeeping error: the
 * parcel is already in someone's hands.
 *
 * Call it inside a transaction. The shortfall path reads before it writes, and a
 * transaction's write conflict is what makes that safe against a concurrent change.
 */
export async function consumeAll(
  requests: ReservationRequest[],
  session?: ClientSession,
): Promise<ConsumeShortfall[]> {
  const shortfalls: ConsumeShortfall[] = [];

  for (const request of requests) {
    const productId = new mongoose.Types.ObjectId(request.productId);
    const variantId = new mongoose.Types.ObjectId(request.variantId);
    const options = { arrayFilters: [{ 'v._id': variantId }], ...(session ? { session } : {}) };

    const consumed = await Product.findOneAndUpdate(
      {
        _id: productId,
        variants: {
          $elemMatch: {
            _id: variantId,
            'stock.onHand': { $gte: request.quantity },
            'stock.reserved': { $gte: request.quantity },
          },
        },
      },
      {
        $inc: {
          'variants.$[v].stock.onHand': -request.quantity,
          'variants.$[v].stock.reserved': -request.quantity,
        },
      },
      { ...options, projection: { _id: 1 } },
    );
    if (consumed) continue;

    const read = Product.findOne({ _id: productId, 'variants._id': variantId }).select({
      'variants.$': 1,
    });
    if (session) read.session(session);
    const stock = (await read.lean())?.variants[0]?.stock;
    if (!stock) {
      logger.error({ ...request }, 'reservation: could not consume, variant not found');
      continue;
    }

    const onHand = Math.max(0, stock.onHand - request.quantity);
    const reserved = Math.max(0, stock.reserved - request.quantity);
    await Product.updateOne(
      { _id: productId, 'variants._id': variantId },
      {
        $set: {
          'variants.$[v].stock.onHand': onHand,
          'variants.$[v].stock.reserved': reserved,
          // Never raised by a shipment, and never above what is now on the shelf unheld.
          'variants.$[v].stock.available': Math.min(
            stock.available,
            Math.max(0, onHand - reserved),
          ),
        },
      },
      options,
    );

    shortfalls.push({ ...request, onHand: stock.onHand, reserved: stock.reserved });
    logger.warn(
      { ...request, onHand: stock.onHand, reserved: stock.reserved },
      'reservation: shipped more than the shelf count held; stock floored at zero',
    );
  }

  return shortfalls;
}
