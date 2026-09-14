import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';
import { REVIEW_BODY_MAX, REVIEW_TITLE_MAX } from './review-rules.js';

/**
 * A review, which exists only because an order reached the person writing it.
 *
 * **`order` is required.** There is no path to a review that does not name the delivered
 * order behind it, so "verified purchase" is not a badge some reviews earn — it is what a
 * review is here. That is also the spam defence, and the reason reviews are published the
 * moment they are written rather than held for approval: somebody who paid and waited for
 * a parcel is not a bot, and a shop that approves its own reviews before anyone can read
 * them is choosing its own average.
 *
 * **One per person per product**, enforced by the unique index rather than a lookup. A
 * second review from the same person replaces the first, which is what someone who
 * changed their mind means.
 *
 * Moderation is two independent facts, deliberately not one status:
 *
 * - `status` is visibility — `published` or `hidden` — and the only thing the rating
 *   average reads.
 * - `needsReview` is the queue: true when written and again whenever edited, false once
 *   someone in the shop has read it. An edit to a hidden review puts it back in front of
 *   a person *without* making it visible again, so hiding cannot be undone by the author
 *   pressing Save.
 */

const reviewSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The earliest of this person's orders for the product that reached `delivered`. */
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },

    rating: { type: Number, required: true, min: 1, max: 5, validate: Number.isInteger },
    title: { type: String, trim: true, maxlength: REVIEW_TITLE_MAX },
    body: { type: String, trim: true, maxlength: REVIEW_BODY_MAX },

    /**
     * "Ada L.", rendered at write time from the account's name — see `reviewerName`.
     * Snapshot rather than a join, so a review reads as it was signed and the public list
     * never has to open a user document.
     */
    authorName: { type: String, required: true, trim: true, maxlength: 60 },

    /** The variant as bought ("250 g · whole bean"), copied from the order line. */
    purchased: {
      type: [
        new Schema(
          { key: { type: String, required: true }, value: { type: String, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },

    status: { type: String, required: true, enum: ['published', 'hidden'], default: 'published' },
    needsReview: { type: Boolean, required: true, default: true },

    /**
     * Why a review was hidden, and by whom. Present only while it is hidden. The note is
     * shown to the author, so it is written to them.
     */
    moderation: {
      type: new Schema(
        {
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          at: { type: Date, required: true },
          note: { type: String, required: true, trim: true, maxlength: 500 },
        },
        { _id: false },
      ),
      default: null,
    },

    /** Set on every edit after the first save, so the page can say "edited". */
    editedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

/** One review per person per product — the rule, as an index. */
reviewSchema.index({ product: 1, user: 1 }, { unique: true });
/** The product page's list, newest first. Every sort ends in `_id` so it is total. */
reviewSchema.index({ product: 1, status: 1, createdAt: -1, _id: -1 });
/** The per-star grouping behind the average and the distribution. */
reviewSchema.index({ product: 1, status: 1, rating: 1 });
/** The account page's own reviews. */
reviewSchema.index({ user: 1, createdAt: -1 });
/** The moderation queue and the dashboard's count of it. */
reviewSchema.index(
  { needsReview: 1, createdAt: 1 },
  { partialFilterExpression: { needsReview: true } },
);
/** The console's hidden and all-reviews lists. */
reviewSchema.index({ status: 1, createdAt: -1 });

export type ReviewAttrs = InferSchemaType<typeof reviewSchema>;
export type ReviewDoc = HydratedDocument<ReviewAttrs>;

export const Review = registerModel('Review', reviewSchema);
