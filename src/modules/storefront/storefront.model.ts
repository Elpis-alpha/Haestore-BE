import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';
import { STOREFRONT_HANDLES } from './storefront.schema.js';

/**
 * One version of a composed page.
 *
 * **A published version is never edited.** Publishing is a status flip on a version that
 * already exists, performed in a transaction that retires the previous one, so the front
 * page is always exactly one complete version — never a half-saved mixture of two — and
 * rollback is publishing an older number again.
 *
 * Three statuses, and the index below is what makes them mean something:
 *
 * - `draft` — the one working copy. Edited in place, guarded by `revision`. Not live, so
 *   an in-place edit here costs nothing a visitor could see.
 * - `published` — what the storefront serves. Exactly one per handle.
 * - `retired` — every version that has been published and replaced. Kept whole, so any
 *   of them can be published again.
 *
 * `sections` is `Mixed` because its shape is a discriminated union Mongoose cannot
 * express. It is validated by the Zod schema on every write, which is the same
 * arrangement as product attributes: a permissive store and a strict service.
 */
const storefrontLayoutSchema = new Schema(
  {
    handle: { type: String, required: true, enum: STOREFRONT_HANDLES },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, required: true, enum: ['draft', 'published', 'retired'] },

    sections: { type: [Schema.Types.Mixed], default: [] },
    /** What changed, in the admin's words. Shown in the version history. */
    note: { type: String, trim: true, maxlength: 200, default: '' },

    /** Bumped on every draft save; a save carrying a stale revision is refused. */
    revision: { type: Number, required: true, default: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    retiredAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'storefront_layouts' },
);

storefrontLayoutSchema.index({ handle: 1, version: 1 }, { unique: true });

/**
 * **At most one draft and at most one published version per handle — enforced by the
 * database, not by the service.**
 *
 * One index covers both: `{handle, status}` is unique, but only over documents whose
 * status is live, so any number of retired versions can share a handle while a second
 * published one cannot exist. Two admins pressing Publish at the same moment therefore
 * cannot produce a front page with two current versions; one of them gets a write
 * conflict and its transaction rolls back whole.
 *
 * It also fixes the order of operations inside a publish, because MongoDB checks unique
 * constraints per write rather than at commit: the current version must be retired
 * *before* the new one is promoted, or the promotion collides with the version it is
 * about to replace.
 */
storefrontLayoutSchema.index(
  { handle: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['draft', 'published'] } },
    name: 'one_draft_and_one_published_per_handle',
  },
);

export type StorefrontLayoutAttrs = InferSchemaType<typeof storefrontLayoutSchema>;
export type StorefrontLayoutDoc = HydratedDocument<StorefrontLayoutAttrs>;

export const StorefrontLayout = registerModel('StorefrontLayout', storefrontLayoutSchema);
