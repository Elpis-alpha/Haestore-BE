import { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { registerModel } from '../../db/register-model.js';
import { ATTRIBUTE_TYPES, VARIANT_HARD_LIMIT } from './attribute-types.js';

/**
 * Money, embedded. Integer minor units and a currency, never a float — see
 * lib/money.ts for why.
 */
const moneySchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
  },
  { _id: false },
);

/**
 * One attribute value on a product, in a **typed** slot.
 *
 * The two obvious alternatives were both rejected, and the reasons are worth keeping
 * because both look simpler:
 *
 * A `Map` of key to value needs either one index per key, which grows without bound as
 * admins define attributes, or a wildcard index — and **a wildcard index supports only
 * a single predicate**, so it can never be compounded with `status` plus
 * `categoryAncestors` plus a sort. That is exactly the shape of every listing query.
 *
 * A `{ key, value }` pair with a Mixed value cannot answer "weight between 250 and
 * 1000 g", because a Mixed index only compares within a BSON type bracket. It also has
 * no type to validate against, so `{ key: 'roast', value: true }` would be a legal
 * document — which defeats the entire point of defining attributes.
 *
 * Typed slots cost one nullable field per kind and buy a real compound multikey index.
 */
const attributeValueSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true },
    defId: { type: Schema.Types.ObjectId, ref: 'AttributeDefinition', required: true },
    type: { type: String, required: true, enum: ATTRIBUTE_TYPES },

    valueString: { type: String, trim: true },
    valueStrings: { type: [String], default: undefined },
    valueNumber: { type: Number },
    valueBool: { type: Boolean },
    valueDim: {
      type: new Schema(
        {
          length: { type: Number, required: true },
          width: { type: Number, required: true },
          height: { type: Number, required: true },
          unit: { type: String, required: true, trim: true },
        },
        { _id: false },
      ),
      default: undefined,
    },

    unit: { type: String, trim: true },
    /**
     * Rendered form, denormalised at write time ("Medium", "250 g", "Dishwasher safe").
     * Without it the PDP specification table would need every AttributeDefinition
     * loaded to turn stored values back into labels; with it the table is one document
     * read. The cost is a backfill when a definition's labels change, which is an
     * admin action that already triggers a reindex.
     */
    displayValue: { type: String, required: true, trim: true, maxlength: 200 },

    order: { type: Number, required: true, default: 0 },
    group: { type: String, trim: true, maxlength: 60 },
  },
  { _id: false },
);

/**
 * A purchasable variant, embedded on the product.
 *
 * Atomicity is *not* what decides embedded versus a separate collection — a guarded
 * `findOneAndUpdate` with `arrayFilters` on a subdocument array is exactly as atomic as
 * one on its own collection, because MongoDB's unit of atomicity is the document and
 * one product contains every variant an order line touches. This was verified against
 * a real replica set in scripts/probe-infra.mjs before the design was settled.
 *
 * What decides it: every listing card needs a price range and a stock flag, which is
 * free when embedded and a `$lookup` per product (or a denormalised cache you have to
 * sync anyway) when separate; and the product page becomes a single read. `_id` is a
 * real ObjectId on every variant, so cart and order lines reference variants the same
 * way they would if this were later lifted into its own collection. See ADR-005.
 */
/**
 * Stock, as its own schema rather than an inline object.
 *
 * An inline nested object infers as optional through InferSchemaType, which would make
 * every read of `variant.stock` a null check for a field that is always written. A
 * named sub-schema with a default keeps the type honest.
 */
const stockSchema = new Schema(
  {
    onHand: { type: Number, required: true, default: 0, min: 0 },
    reserved: { type: Number, required: true, default: 0, min: 0 },
    /**
     * **Stored and maintained, not computed as onHand - reserved.**
     *
     * Comparing two fields inside an array element needs `$expr`, and `$expr` is not
     * allowed inside `$elemMatch`. That would force the reservation guard into an
     * aggregation-pipeline update whose success has to be inferred from
     * `modifiedCount` rather than from the returned document. Storing `available`
     * makes the guard a plain predicate — `'stock.available': { $gte: qty }` — and
     * therefore atomic for free. Verified in scripts/probe-infra.mjs.
     *
     * The invariant `available + reserved === onHand` is asserted by a nightly sweep
     * against the stock ledger, and drift alarms rather than silently self-heals.
     */
    available: { type: Number, required: true, default: 0, min: 0 },
    /** Below this, the storefront says "only a few left" rather than a number. */
    lowStockThreshold: { type: Number, required: true, default: 3, min: 0 },
    backorderable: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const variantSchema = new Schema({
  sku: { type: String, required: true, trim: true, uppercase: true, maxlength: 64 },
  /**
   * The variant's position in the grid: [{ key: 'grind', value: 'whole' }, …]. Only
   * keys listed in the product's `variantAxes` appear here.
   */
  axisValues: {
    type: [
      new Schema(
        {
          key: { type: String, required: true, trim: true, lowercase: true },
          value: { type: String, required: true, trim: true },
        },
        { _id: false },
      ),
    ],
    default: [],
  },

  price: { type: moneySchema, required: true },
  /** The former price, for a strikethrough. Never used in arithmetic. */
  compareAtPrice: { type: moneySchema },

  stock: { type: stockSchema, required: true, default: () => ({}) },

  weightGrams: { type: Number, min: 0 },
  imagePublicIds: { type: [String], default: [] },
  status: { type: String, required: true, enum: ['active', 'inactive'], default: 'active' },
  position: { type: Number, required: true, default: 0 },
});

const productImageSchema = new Schema(
  {
    publicId: { type: String, required: true, trim: true },
    alt: { type: String, trim: true, maxlength: 200, default: '' },
    width: { type: Number },
    height: { type: Number },
    /** Cloudinary-generated LQIP, so the placeholder costs no Worker CPU. */
    blurDataUrl: { type: String },
    position: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    subtitle: { type: String, trim: true, maxlength: 300 },
    description: { type: String, trim: true, maxlength: 20000 },

    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    /**
     * Copied from the category's `ancestors` at write time, so a listing filtered to a
     * whole branch never has to join. Rewritten for affected products when a category
     * moves, inside the same transaction as the move.
     */
    categoryAncestors: { type: [Schema.Types.ObjectId], ref: 'Category', default: [] },

    status: {
      type: String,
      required: true,
      enum: ['draft', 'active', 'archived'],
      default: 'draft',
    },

    attributes: { type: [attributeValueSchema], default: [] },

    /**
     * The axes this product actually uses, chosen from those its category marks
     * eligible. The category says what *may* be an axis; the product says what is.
     */
    variantAxes: { type: [String], default: [] },

    variants: {
      type: [variantSchema],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= VARIANT_HARD_LIMIT,
        message: `A product cannot have more than ${VARIANT_HARD_LIMIT} variants.`,
      },
    },
    defaultVariantId: { type: Schema.Types.ObjectId },

    images: { type: [productImageSchema], default: [] },

    /**
     * Denormalised from the active variants so a listing card can show "$18 – $32" and
     * sort by price without opening the variants array. Recomputed on every write that
     * touches a variant price or status.
     */
    priceRange: {
      min: { type: Number },
      max: { type: Number },
      currency: { type: String, uppercase: true },
    },
    /** Any active variant with stock. Denormalised for the same reason. */
    inStock: { type: Boolean, required: true, default: false },

    /**
     * Set by lenient validation rather than rejecting the write. The admin dashboard
     * lists these; nothing else changes behaviour because of them, and in particular a
     * product with issues still sells.
     */
    needsAttention: { type: Boolean, required: true, default: false },
    validationIssues: {
      type: [
        new Schema(
          {
            key: { type: String, required: true },
            code: { type: String, required: true },
            message: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },

    ratingAverage: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },

    publishedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * The listing query's shape, in index form: live products in a branch, ordered by
 * price. Meilisearch serves this on the storefront (ADR-003); this index backs the
 * degraded no-facet fallback and every admin listing.
 */
productSchema.index({ status: 1, categoryAncestors: 1, 'priceRange.min': 1 });

/**
 * The compound multikey index an attribute filter needs. Mongo permits at most one
 * multikey *path* per compound index, and `attributes` is that one path — `key` and
 * `valueString` are fields of the same array element, which is allowed. Adding a
 * second array field from a different path would be rejected at creation, which is why
 * `categoryAncestors` is not in this index.
 */
productSchema.index({ status: 1, 'attributes.key': 1, 'attributes.valueString': 1 });
productSchema.index({ status: 1, 'attributes.key': 1, 'attributes.valueNumber': 1 });

// SKUs are unique across the shop, but only where one is set.
productSchema.index(
  { 'variants.sku': 1 },
  { unique: true, partialFilterExpression: { 'variants.sku': { $type: 'string' } } },
);

// The admin dashboard's "needs attention" queue.
productSchema.index(
  { needsAttention: 1, updatedAt: -1 },
  { partialFilterExpression: { needsAttention: true } },
);

export type ProductAttrs = InferSchemaType<typeof productSchema>;
export type ProductDoc = HydratedDocument<ProductAttrs>;

export const Product = registerModel('Product', productSchema);
