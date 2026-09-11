import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * The wishlist requires an account, and that is a decision rather than an omission.
 *
 * A wishlist is a promise to remember something across devices and across months. A
 * guest cookie can keep neither: it is one browser, it expires in thirty days, and
 * clearing site data destroys it without warning. Offering one to a signed-out visitor
 * would be advertising a durability the storage cannot provide — the same reasoning
 * that kept a disabled add-to-bag button off the Phase 4 product page.
 *
 * The signed-out shape of the same need is the cart's own `savedForLater`, which is
 * honest about its lifetime because it lives in the bag alongside things that are
 * plainly temporary.
 *
 * One document per person, with the items embedded. A wishlist is read whole, written
 * one item at a time, and is small by nature; a collection of one-row documents would
 * buy an unbounded size nobody wants and cost a query on every render.
 */

const wishlistItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    /**
     * Optional, and usually absent.
     *
     * "I want the celadon bowl" is a wish about a product; "I want the 250 g whole bean"
     * is a wish about a variant. Both are real, so the variant is recorded when the
     * shopper chose one and left null when they did not — rather than forcing a choice
     * at the moment they are least sure.
     */
    variantId: { type: Schema.Types.ObjectId, default: null },
    addedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false },
);

const wishlistSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    items: {
      type: [wishlistItemSchema],
      default: [],
      /**
       * Bounded, because an embedded array with no ceiling is a 16 MB document waiting
       * to happen — and because the 2022 user document's unbounded `tokens[]` is the
       * precedent this codebase exists to not repeat.
       */
      validate: {
        validator: (items: unknown[]) => items.length <= 200,
        message: 'A wishlist holds at most 200 items.',
      },
    },
  },
  { timestamps: true },
);

export type WishlistAttrs = InferSchemaType<typeof wishlistSchema>;
export type WishlistDoc = HydratedDocument<WishlistAttrs>;

export const WISHLIST_LIMIT = 200;

export const Wishlist = registerModel('Wishlist', wishlistSchema);
