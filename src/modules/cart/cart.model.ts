import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * The cart lives in MongoDB, not Redis.
 *
 * ARCHITECTURE.md's rule is that **Redis must be safe to flush at 3 a.m.** — a cache, a
 * rate limiter, a queue and a session are all things a shop survives losing. A cart is
 * not: a lost cart is a lost sale, and it is lost silently, from the shopper's side, as
 * "this site forgot my basket". So the cart is a document with a TTL index, and Redis
 * holds nothing about it.
 *
 * The line shape is the direct repair of the 2022 cart, which stored each line's
 * *extended total* in a field called `price` and recovered the unit price by dividing by
 * quantity. Here the unit price is stored as integer minor units and the extended total
 * is never stored at all — it is computed on read, from the live catalogue, by
 * repricing.ts.
 */

const moneySchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
  },
  { _id: false },
);

const lineSchema = new Schema(
  {
    /**
     * `<productId>_<variantId>`, derived rather than generated — see line-key.ts. It is
     * what makes "the same line" mean the same thing in two carts that never met, which
     * is the premise the merge rests on.
     */
    lineKey: { type: String, required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, required: true },

    /**
     * Denormalised at add time so the bag renders without the catalogue, and so an
     * archived product can still be *named* rather than appearing as a blank row. Every
     * read refreshes these from live data where it can; they are the fallback, not the
     * source.
     */
    sku: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, trim: true },
    axisValues: {
      type: [
        new Schema(
          {
            key: { type: String, required: true, trim: true },
            value: { type: String, required: true, trim: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    imagePublicId: { type: String, trim: true },

    /** What the shopper last saw. Never what they are charged — see cart-types.ts. */
    unitPrice: { type: moneySchema, required: true },

    quantity: { type: Number, required: true, min: 1, max: 99 },
    addedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

/**
 * What a merge did, kept so it can be shown and undone.
 *
 * `previousLines` is the tombstone: the account's own cart exactly as it stood before
 * the guest cart was folded in. Undo restores it — which does mean discarding what the
 * guest cart contributed, because that is what undoing a merge is. The report's rows
 * are what make the other repair possible: a shopper who genuinely wanted 2 + 3 = 5 can
 * see both numbers and set it in one edit.
 */
const mergeReportSchema = new Schema(
  {
    mergedAt: { type: Date, required: true },
    rows: { type: Schema.Types.Mixed, required: true, default: [] },
    previousLines: { type: [lineSchema], default: [] },
    previousSaved: { type: [lineSchema], default: [] },
    /** Seven days, then the tombstone is not worth the bytes and Undo disappears. */
    undoableUntil: { type: Date, required: true },
    undoneAt: { type: Date, default: null },
  },
  { _id: false },
);

const cartSchema = new Schema(
  {
    /**
     * Exactly one of these two is set. A cart with both would be reachable by two
     * identities and could be merged into itself; the partial unique indexes below are
     * what actually prevent a second active cart per owner.
     */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** HMAC of the guest cookie's token, never the token. See guest-cookie.ts. */
    guestKeyHash: { type: String, default: null },

    /**
     * `merging` is the idempotency gate, not a progress indicator.
     *
     * Claiming a guest cart is `findOneAndUpdate({ guestKeyHash, status: 'active' }, …)`.
     * A second, concurrent or replayed sign-in finds nothing to claim and does nothing —
     * which is what makes a merge that is delivered twice harmless, the same way the
     * order state machine will make a webhook delivered three times harmless.
     */
    status: {
      type: String,
      required: true,
      enum: ['active', 'merging', 'merged', 'ordered'],
      default: 'active',
    },

    /** One shop, one currency, but stored rather than baked in. */
    currency: { type: String, required: true, uppercase: true, default: 'USD' },

    lines: { type: [lineSchema], default: [] },
    /** Out of stock, or set aside on purpose. Not counted in the bag, never deleted. */
    savedForLater: { type: [lineSchema], default: [] },

    mergeReport: { type: mergeReportSchema, default: null },

    /**
     * Null on an account's cart, set on a guest's.
     *
     * A signed-in cart has an owner who can come back to it in six months; a guest cart
     * is addressable only by a cookie that itself expires in thirty days, so keeping the
     * document past that is keeping an orphan. The TTL is cleared when a guest cart is
     * claimed by an account.
     */
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/**
 * One active cart per owner, enforced by the database rather than by a service that
 * remembers to check.
 *
 * `status: 'active'` inside the partial filter is what lets a cart leave the index when
 * it is ordered or merged, so the next one may be created — an index on the owner alone
 * would make a second order impossible.
 */
cartSchema.index(
  { user: 1 },
  { unique: true, partialFilterExpression: { user: { $type: 'objectId' }, status: 'active' } },
);
cartSchema.index(
  { guestKeyHash: 1 },
  {
    unique: true,
    partialFilterExpression: { guestKeyHash: { $type: 'string' }, status: 'active' },
  },
);

/** Mongo sweeps a guest cart once its cookie could no longer name it. */
cartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type CartAttrs = InferSchemaType<typeof cartSchema>;
export type CartDoc = HydratedDocument<CartAttrs>;

export const Cart = registerModel('Cart', cartSchema);
