import type { Types } from 'mongoose';
import { registerModel } from '../../db/register-model.js';
import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * A node in the admin-defined category tree.
 *
 * **Ancestry is materialised, including self.** `ancestors` holds the id of every node
 * from the root down to and including this one, so "everything under Coffee & Tea" is
 * `{ ancestors: coffeeTeaId }` — one equality predicate against one index, with no
 * `$graphLookup` and no recursion at read time. The cost is that moving a subtree has
 * to rewrite its descendants' ancestor arrays, which is a rare admin action and is
 * done in a transaction.
 *
 * `path` is the same thing in human form ("coffee-tea/beans") and is what the
 * storefront URL uses. It is the unique key rather than `slug`, so "beans" can exist
 * under more than one parent without a naming fight.
 */
const attributeBindingSchema = new Schema(
  {
    defId: { type: Schema.Types.ObjectId, ref: 'AttributeDefinition', required: true },
    /**
     * Denormalised from the definition. Resolving the effective attribute set is on
     * the read path for both the admin form and the PDP, and carrying the key here
     * means that resolution can answer "which keys apply" without loading every
     * definition first.
     */
    key: { type: String, required: true, trim: true, lowercase: true },
    required: { type: Boolean, required: true, default: false },
    order: { type: Number, required: true, default: 0 },
    /** Groups the PDP specification table and the admin form ("Origin", "Care"). */
    group: { type: String, trim: true, maxlength: 60 },
  },
  { _id: false },
);

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, trim: true, lowercase: true, maxlength: 80 },
    /** Full slug path from the root, unique across the tree. */
    path: { type: String, required: true, unique: true, trim: true, lowercase: true },

    parent: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    /** Root-first, **including this node's own id**. */
    ancestors: { type: [Schema.Types.ObjectId], ref: 'Category', default: [] },
    depth: { type: Number, required: true, default: 0 },
    order: { type: Number, required: true, default: 0 },

    description: { type: String, trim: true, maxlength: 2000 },
    imagePublicId: { type: String, trim: true },

    attributeBindings: { type: [attributeBindingSchema], default: [] },

    /**
     * Keys inherited from ancestors that this branch does not want. Applied before
     * this node's own bindings are merged, so a child can both suppress a parent's
     * attribute and rebind it with different settings.
     */
    suppressedKeys: { type: [String], default: [] },

    /**
     * The single most important field in the attribute system.
     *
     * In `lenient` mode — the default — adding a new *required* attribute does not
     * retroactively invalidate the products already in the category. A sweep marks
     * them `needsAttention` with `validationIssues[]`, and the dashboard surfaces "12
     * products are missing Roast Level". In `strict` mode the write is rejected.
     *
     * Without lenient, every attribute change becomes a migration, and an admin
     * quickly learns not to touch attributes — which makes the adaptable catalogue
     * unusable in practice while appearing to work.
     */
    validationMode: {
      type: String,
      required: true,
      enum: ['lenient', 'strict'],
      default: 'lenient',
    },

    status: { type: String, required: true, enum: ['active', 'hidden'], default: 'active' },
  },
  { timestamps: true },
);

// Rendering a level of the tree, in admin order.
categorySchema.index({ parent: 1, order: 1 });
// "Everything under X" — the predicate the whole materialised-ancestry design exists for.
categorySchema.index({ ancestors: 1, status: 1 });

export type CategoryAttrs = InferSchemaType<typeof categorySchema>;
export type CategoryDoc = HydratedDocument<CategoryAttrs>;
export type AttributeBinding = {
  defId: Types.ObjectId;
  key: string;
  required: boolean;
  order: number;
  group?: string;
};

export const Category = registerModel('Category', categorySchema);
