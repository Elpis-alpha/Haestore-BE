import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * Webhook deduplication, as a unique index rather than as a check.
 *
 * Both providers redeliver. Stripe retries any non-2xx with backoff for up to three
 * days; PayPal does much the same. On top of that, at-least-once delivery means a
 * successful handler whose 200 was lost in transit will simply be told again. So a
 * handler is going to see the same event two or three times, and often out of order.
 *
 * The recording is an **insert of a uniquely-indexed id**, and a duplicate-key error is
 * the answer rather than an exception to report:
 *
 *     try { await PaymentEvent.create({ provider, eventId }) }
 *     catch (e) { if (isDuplicateKey(e)) return 'already-seen' }
 *
 * Checking first and inserting after — `if (!(await PaymentEvent.exists(...)))` — reads
 * the same and is wrong, because two concurrent deliveries of the same event both pass
 * the check before either insert lands. Retries arrive in bursts, so that race is not
 * theoretical.
 *
 * This is belt to `markOrderPaid`'s braces. The status filter already makes paying an
 * order twice impossible; this stops the *work around* it — re-sending a receipt,
 * re-enqueueing a reindex — from happening twice as well.
 */

const paymentEventSchema = new Schema(
  {
    provider: { type: String, required: true, enum: ['stripe', 'paypal'] },
    /** The provider's own event id: `evt_…` for Stripe, `WH-…` for PayPal. */
    eventId: { type: String, required: true },
    type: { type: String, required: true },

    /** The order it resolved to, when it resolved to one. Null for events we ignore. */
    order: { type: Schema.Types.ObjectId, ref: 'Order', default: null },

    /**
     * What the handler decided. Kept because "we received it and deliberately did
     * nothing" and "we received it and it failed" look identical from outside, and the
     * difference is the whole question when a payment is disputed.
     */
    outcome: {
      type: String,
      required: true,
      enum: ['applied', 'ignored', 'duplicate', 'failed'],
      default: 'applied',
    },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'payment_events' },
);

/** The dedupe itself. Compound, because the two providers' id spaces are unrelated. */
paymentEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

/**
 * Swept after 30 days.
 *
 * Long enough to outlive both providers' retry windows by an order of magnitude, which
 * is what the index is for; short enough that this does not become an unbounded log.
 */
paymentEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2_592_000 });

export type PaymentEventAttrs = InferSchemaType<typeof paymentEventSchema>;
export type PaymentEventDoc = HydratedDocument<PaymentEventAttrs>;

export const PaymentEvent = registerModel('PaymentEvent', paymentEventSchema);

/**
 * Mongo's duplicate-key error, named.
 *
 * Written as a predicate over `unknown` because a caught error is `unknown` and the
 * alternative at every call site is a cast that asserts a shape nobody checked.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
