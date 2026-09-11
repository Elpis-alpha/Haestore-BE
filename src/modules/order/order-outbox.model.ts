import { Schema, type InferSchemaType, type HydratedDocument, type ClientSession } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * The order-side transactional outbox.
 *
 * Same argument as `search/outbox.model.ts`, applied to money instead of search: an
 * SMTP — here, Gmail API — timeout inside a webhook handler means Stripe sees a non-2xx,
 * retries, and we re-process a payment because the *mail server* was slow. Sending after
 * the commit instead trades that for losing the receipt if the process dies in between.
 *
 * So the intent to send is appended **inside the same transaction that marks the order
 * paid**. Either both land or neither does, and a separate drain turns intents into
 * emails with retries and a backoff.
 *
 * **This one is swept, not streamed**, which is the deliberate difference from the search
 * outbox. That one runs a change stream because a shopper watching a product page notices
 * a stale index within seconds. Nobody notices a receipt three seconds late, order volume
 * is orders of magnitude below catalogue-write volume, and a second change stream is a
 * second thing holding a resume token, a lease and a reconnect loop. The fast path here
 * is instead an opportunistic enqueue after the transaction commits — and because the
 * row is already durable, that enqueue is free to fail. The sweep is what makes it
 * certain; the post-commit enqueue only makes it quick.
 */

export const ORDER_OUTBOX_KINDS = ['order-confirmation', 'order-canceled'] as const;
export type OrderOutboxKind = (typeof ORDER_OUTBOX_KINDS)[number];

const orderOutboxSchema = new Schema(
  {
    kind: { type: String, required: true, enum: ORDER_OUTBOX_KINDS },
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },

    processedAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'order_outbox' },
);

/** The sweep's query: anything unprocessed, oldest first. */
orderOutboxSchema.index({ processedAt: 1, createdAt: 1 });

/**
 * Processed rows expire after a week — longer than the search outbox's day, because
 * "did the customer ever get their receipt?" is a question that arrives days later,
 * and this row is the answer.
 */
orderOutboxSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 604_800, partialFilterExpression: { processedAt: { $type: 'date' } } },
);

export type OrderOutboxAttrs = InferSchemaType<typeof orderOutboxSchema>;
export type OrderOutboxDoc = HydratedDocument<OrderOutboxAttrs>;

export const OrderOutbox = registerModel('OrderOutbox', orderOutboxSchema);

/**
 * Appends to the order outbox.
 *
 * The session is required for the same reason as the search outbox's: an append outside
 * the transaction that caused it would just move the crash window rather than close it.
 */
export async function appendOrderOutbox(
  session: ClientSession,
  entries:
    { kind: OrderOutboxKind; orderId: unknown } | { kind: OrderOutboxKind; orderId: unknown }[],
): Promise<void> {
  const rows = (Array.isArray(entries) ? entries : [entries]).map((e) => ({
    kind: e.kind,
    order: e.orderId,
  }));
  if (rows.length === 0) return;
  await OrderOutbox.insertMany(rows, { session, ordered: false });
}
