import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * Idempotency at the API edge.
 *
 * Every `POST /api/checkout/*` requires an `Idempotency-Key`. This record is what makes
 * a replay of that key harmless **before any inner guard is consulted** — which matters
 * because the inner guards protect different things: the order's status filter stops a
 * second payment, but nothing below this stops a second *order* being created from the
 * same cart by a double-tapped button on flaky mobile data.
 *
 * Three outcomes, and the third is the one that is usually missing:
 *
 * - **Same key, same request** → replay the stored response byte for byte. The client
 *   cannot tell whether it was the first attempt, which is the entire point.
 * - **Same key, still in flight** → 409. Not a wait, because holding the second request
 *   open is how you turn a double-tap into two held connections and a timeout.
 * - **Same key, *different* request** → 422. This is a client bug — a key being reused
 *   for a different body — and replaying the first response would answer a question
 *   that was never asked. Refusing is the only honest answer.
 *
 * The request hash is what makes the third case detectable at all.
 */

const idempotencyKeySchema = new Schema(
  {
    /** The client's key, scoped by route and caller so two clients cannot collide. */
    key: { type: String, required: true },
    /** `POST /api/checkout/session` — a key is only valid for the route it was used on. */
    scope: { type: String, required: true },
    /**
     * The caller: a user id, a guest key hash, or `anon`. Without this, one client's
     * key could replay another's stored response, which would hand over an order.
     */
    owner: { type: String, required: true },

    /** SHA-256 of the canonical request body. The differing-hash check reads this. */
    requestHash: { type: String, required: true },

    status: {
      type: String,
      required: true,
      enum: ['in_flight', 'completed'],
      default: 'in_flight',
    },

    /** The stored response, replayed verbatim on a matching retry. */
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: 'idempotency_keys' },
);

/**
 * The uniqueness that does the work. The insert is the claim: a second concurrent
 * request with the same key loses on this index rather than on a check it could race.
 */
idempotencyKeySchema.index({ owner: 1, scope: 1, key: 1 }, { unique: true });

/**
 * 24 hours, which is longer than any client will retry and short enough that a key is
 * reusable the next day. Both providers' retry windows are irrelevant here — this
 * guards the shopper's browser, not the provider's redelivery.
 */
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86_400 });

export type IdempotencyKeyAttrs = InferSchemaType<typeof idempotencyKeySchema>;
export type IdempotencyKeyDoc = HydratedDocument<IdempotencyKeyAttrs>;

export const IdempotencyKey = registerModel('IdempotencyKey', idempotencyKeySchema);
