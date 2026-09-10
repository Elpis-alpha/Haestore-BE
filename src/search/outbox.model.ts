import { Schema, type InferSchemaType, type HydratedDocument, type ClientSession } from 'mongoose';
import { registerModel } from '../db/register-model.js';

/**
 * The transactional outbox.
 *
 * The failure this exists to prevent is one line of code wide. The obvious way to keep
 * a search index current is:
 *
 *     await product.save();
 *     await queue.add('index', { id: product.id });   // <- crash here
 *
 * A crash between those two statements leaves a product saved in Mongo and absent from
 * the index, permanently and silently. No error is logged, because nothing failed; the
 * product simply never appears in the shop again until someone notices and rebuilds.
 * Reversing the order trades it for the opposite bug — an index entry for a product
 * that was never written.
 *
 * There is no arrangement of two systems that makes those two writes atomic. So only
 * one system is written: the intent to index is appended **inside the same transaction
 * as the domain write**, to the same database. Either both land or neither does. A
 * separate relay then drains the outbox into BullMQ, and because draining is idempotent
 * it can crash, restart and re-deliver freely — the worst case is indexing a product
 * twice, which is a no-op.
 *
 * `processedAt` is not how the relay finds its place; the change stream's resume token
 * is. It exists so the sweep in relay.ts can find rows the stream never delivered — the
 * safety net under the safety net — and so an operator can see what is stuck.
 */

export const OUTBOX_KINDS = [
  'product',
  'settings',
  'category-branch',
  'attribute-definition',
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

const outboxSchema = new Schema(
  {
    /**
     * `product` reindexes one product. `settings` re-derives the index configuration.
     * `category-branch` reindexes everything beneath a category, because a rename or a
     * move rewrites the denormalised ancestry on an unbounded number of products and
     * one row per product would put tens of thousands of documents through a
     * transaction that is already rewriting them. `attribute-definition` is the same
     * idea for an edited definition, whose new option labels have to be re-rendered
     * onto every product carrying that key.
     */
    kind: { type: String, required: true, enum: OUTBOX_KINDS },
    /** Null for `settings`, which has no entity. */
    entityId: { type: String, default: null },
    op: { type: String, required: true, enum: ['upsert', 'delete', 'sync'] },

    /**
     * A hint, never the truth. The worker rebuilds the document from Mongo, so a
     * payload that is stale by the time it is drained changes nothing. It is carried
     * only for logging and for the rare case where the entity is gone by then.
     */
    payload: { type: Schema.Types.Mixed },

    processedAt: { type: Date, default: null },
    attempts: { type: Number, required: true, default: 0 },
    lastError: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'search_outbox' },
);

/** The sweep's query: anything still unprocessed, oldest first. */
outboxSchema.index({ processedAt: 1, createdAt: 1 });

/**
 * Processed rows are rubbish after a day, but they are deliberately not deleted
 * immediately: a row that is still present is the only evidence available when someone
 * asks why a product took four minutes to appear.
 */
outboxSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 86_400, partialFilterExpression: { processedAt: { $type: 'date' } } },
);

export type SearchOutboxAttrs = InferSchemaType<typeof outboxSchema>;
export type SearchOutboxDoc = HydratedDocument<SearchOutboxAttrs>;

export const SearchOutbox = registerModel('SearchOutbox', outboxSchema);

export type OutboxEntry = {
  kind: OutboxKind;
  entityId?: string | null;
  op: 'upsert' | 'delete' | 'sync';
  payload?: unknown;
};

/**
 * Appends to the outbox.
 *
 * **The session argument is not optional by accident.** Every caller must be inside a
 * transaction, because an append that is not part of the domain write is exactly the
 * two-write problem this file exists to eliminate — it would just move the crash window
 * rather than close it.
 */
export async function appendOutbox(
  session: ClientSession,
  entries: OutboxEntry | OutboxEntry[],
): Promise<void> {
  const rows = (Array.isArray(entries) ? entries : [entries]).map((e) => ({
    kind: e.kind,
    entityId: e.entityId ?? null,
    op: e.op,
    payload: e.payload,
  }));
  if (rows.length === 0) return;
  // `ordered: false` so one malformed row cannot abort a batch, and the transaction
  // fails loudly on the write itself rather than on a partially applied insert.
  await SearchOutbox.insertMany(rows, { session, ordered: false });
}
