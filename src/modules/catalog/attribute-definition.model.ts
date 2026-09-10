import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { registerModel } from '../../db/register-model.js';
import { ATTRIBUTE_TYPES, FILTER_UIS } from './attribute-types.js';

/**
 * An attribute an admin has defined: roast level, glaze, volume, dishwasher safe.
 *
 * This is the reusable unit of the adaptable catalogue. There is deliberately no
 * separate "attribute set" collection grouping these — a category binds definitions
 * directly, because the thing worth reusing is already the definition itself and a set
 * would only add a layer that has to be kept in sync.
 *
 * **`key` and `type` are immutable once created**, enforced in the service. `key` is
 * load-bearing in four places at once: it is a Meilisearch `filterableAttributes`
 * entry, a public URL parameter, the stored discriminator on every product value, and
 * an entry in `product.variantAxes`. Renaming would break every bookmarked filter URL
 * and orphan the index. A rename is a new definition plus a backfill, and the admin UI
 * says so rather than offering an edit box that quietly breaks things.
 */
const optionSchema = new Schema(
  {
    /** Stored on products and used verbatim in URLs, so it is slug-shaped. */
    value: { type: String, required: true, trim: true, maxlength: 60 },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    /** For `color` attributes: the swatch to paint in the filter panel. */
    swatchHex: { type: String, trim: true, match: /^#[0-9a-fA-F]{6}$/ },
    order: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const attributeDefinitionSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      // Snake case, letter-initial. Not merely a convention: it has to survive being a
      // URL parameter, a Meilisearch attribute name and a JSON key unquoted.
      match: /^[a-z][a-z0-9_]{1,39}$/,
    },
    label: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },

    type: { type: String, required: true, enum: ATTRIBUTE_TYPES },
    /** 'g', 'ml', 'cm'. Display only — never parsed, never converted. */
    unit: { type: String, trim: true, maxlength: 16 },

    options: { type: [optionSchema], default: [] },

    isFilterable: { type: Boolean, required: true, default: true },
    isSearchable: { type: Boolean, required: true, default: false },
    /**
     * Eligibility, not generation. This says the attribute *may* be used as a variant
     * axis; each product then declares which of its category's eligible axes it
     * actually uses. Conflating the two is what gives a single-origin sold only as
     * whole bean a phantom "ground" variant.
     */
    isVariantAxis: { type: Boolean, required: true, default: false },

    filterUi: { type: String, required: true, enum: FILTER_UIS, default: 'checkbox' },

    validation: {
      min: { type: Number },
      max: { type: Number },
      step: { type: Number },
      maxLength: { type: Number },
      /** Applied when a category binds this without saying otherwise. */
      requiredByDefault: { type: Boolean, default: false },
    },

    /**
     * Archived rather than deleted. Products keep values keyed by definitions that may
     * no longer be offered, and deleting the definition would leave those values
     * untyped and unrenderable.
     */
    archivedAt: { type: Date },
  },
  { timestamps: true, collection: 'attribute_definitions' },
);

// Listing definitions for the admin builder, newest-relevant first.
attributeDefinitionSchema.index({ archivedAt: 1, label: 1 });
// The derived Meilisearch settings read exactly this.
attributeDefinitionSchema.index({ isFilterable: 1, archivedAt: 1 });

export type AttributeDefinitionAttrs = InferSchemaType<typeof attributeDefinitionSchema>;
export type AttributeDefinitionDoc = HydratedDocument<AttributeDefinitionAttrs>;

export const AttributeDefinition = registerModel('AttributeDefinition', attributeDefinitionSchema);
