import mongoose, { type ClientSession } from 'mongoose';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { appendOutbox } from '../../search/outbox.model.js';
import { User } from '../auth/user.model.js';
import { Product } from '../catalog/product.model.js';
import { Order } from '../order/order.model.js';
import { Review, type ReviewAttrs } from './review.model.js';
import { reviewerName, summariseRatings, type RatingSummary } from './review-rules.js';
import type {
  AdminReviewQuery,
  PublicReviewQuery,
  ReviewSortKey,
  WriteReviewInput,
} from './review.schema.js';

/**
 * Reviews: who may write one, what it does to the product, and what anybody else sees.
 *
 * **Every write that changes what the public can see goes through `withRatingRefresh`,**
 * which recomputes the product's `ratingAverage` and `ratingCount` from the published
 * reviews and appends a search outbox row — all in the transaction that changed the
 * review. Both figures are on the listing card and in the search index, so a review write
 * is a product write as far as the index is concerned, and it gets the same guarantee
 * every product write has: the index cannot be left believing a rating that did not
 * commit, or miss one that did.
 */

type ReviewRow = ReviewAttrs & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };

const SORTS: Record<ReviewSortKey, Record<string, 1 | -1>> = {
  newest: { createdAt: -1, _id: -1 },
  highest: { rating: -1, createdAt: -1, _id: -1 },
  lowest: { rating: 1, createdAt: -1, _id: -1 },
};

const objectId = (id: string, what: string) => {
  if (!mongoose.isValidObjectId(id)) throw notFound(`${what} not found.`);
  return new mongoose.Types.ObjectId(id);
};

/**
 * The order that lets this person review this product, or null.
 *
 * **"Reached `delivered`", read from the history rather than the status.** An order that
 * was delivered and later refunded after a return was still in the person's hands, and
 * their opinion of it is exactly the kind a shopper wants to read — so it qualifies. An
 * order refunded before it shipped never reached anyone, and its history says so.
 *
 * The earliest such order, so a review keeps pointing at the same purchase however many
 * times the person buys the thing again.
 */
export async function qualifyingOrder(userId: string, productId: mongoose.Types.ObjectId) {
  return Order.findOne({
    user: new mongoose.Types.ObjectId(userId),
    'lines.product': productId,
    'history.status': 'delivered',
  })
    .sort({ createdAt: 1, _id: 1 })
    .select('_id orderNumber lines')
    .lean();
}

/**
 * The per-star counts for one product's published reviews. Indexed on
 * `{product, status, rating}`, and bounded by one product's reviews.
 */
async function ratingCounts(productId: mongoose.Types.ObjectId, session?: ClientSession) {
  const pipeline = Review.aggregate<{ _id: number; count: number }>([
    { $match: { product: productId, status: 'published' } },
    { $group: { _id: '$rating', count: { $sum: 1 } } },
  ]);
  if (session) pipeline.session(session);
  const rows = await pipeline;
  return rows.map((row) => ({ rating: row._id, count: row.count }));
}

/**
 * Runs a review write in a transaction, then re-derives the product's rating from the
 * reviews as they now stand and tells the index — in the same transaction.
 *
 * `work` returns null when its guarded write matched nothing, and then neither the rating
 * nor the index is touched: a refused moderation action has changed nothing to refresh.
 *
 * Two reviews landing on one product at once both write the product document, so one of
 * the transactions meets a write conflict and `withTransaction` retries it — against a
 * snapshot that now includes the other review. That is what keeps the count honest under
 * concurrency without a lock; the integration suite exercises it.
 */
async function withRatingRefresh<T>(
  productId: mongoose.Types.ObjectId,
  work: (session: ClientSession) => Promise<T | null>,
): Promise<T | null> {
  const session = await mongoose.startSession();
  try {
    let result: T | null = null;
    await session.withTransaction(async () => {
      result = await work(session);
      if (result === null) return;

      const summary = summariseRatings(await ratingCounts(productId, session));
      await Product.updateOne(
        { _id: productId },
        { $set: { ratingAverage: summary.average, ratingCount: summary.count } },
        { session },
      );
      await appendOutbox(session, { kind: 'product', entityId: String(productId), op: 'upsert' });
    });
    return result;
  } finally {
    await session.endSession();
  }
}

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

/**
 * Writes this person's review of a product: creates it, or replaces the one they wrote.
 *
 * Addressed by product rather than by review id, because there is at most one review per
 * person per product and the product is the thing the person is looking at. That makes the
 * request idempotent, which is what a Save button pressed twice should be.
 *
 * Two first saves racing from two tabs both find nothing and both insert; the unique index
 * refuses the second, which is not a transient error and so is not retried by the
 * transaction. It is retried once here instead, where the retry finds the first and
 * updates it.
 */
export async function writeReview(userId: string, productIdParam: string, input: WriteReviewInput) {
  const productId = objectId(productIdParam, 'Product');
  const product = await Product.findOne({ _id: productId, status: 'active' }).select('_id').lean();
  if (!product) throw notFound('That is not something we sell.');

  const order = await qualifyingOrder(userId, productId);
  if (!order) {
    throw new AppError(
      403,
      'FORBIDDEN',
      'Reviews come from orders that have reached you. Once yours of this is delivered, you can write one.',
    );
  }

  const user = await User.findById(userId).select('name').lean();
  const line = order.lines.find((l) => String(l.product) === String(productId));
  const fields = {
    rating: input.rating,
    title: input.title || undefined,
    body: input.body || undefined,
    authorName: reviewerName(user?.name),
    purchased: (line?.axisValues ?? []).map((a) => ({ key: a.key, value: a.value })),
    // Written or rewritten, a person in the shop has not read this version yet.
    needsReview: true,
  };
  const owner = new mongoose.Types.ObjectId(userId);

  const attempt = () =>
    withRatingRefresh(productId, async (session) => {
      const existing = await Review.findOne({ product: productId, user: owner }).session(session);
      if (existing) {
        // Status is left as it is: an edit does not unhide a hidden review.
        existing.set({ ...fields, editedAt: new Date() });
        await existing.save({ session });
        return existing;
      }
      const [created] = await Review.create(
        [{ ...fields, product: productId, user: owner, order: order._id }],
        { session },
      );
      return created ?? null;
    });

  const review = await attempt().catch((err: unknown) => {
    if (isDuplicateKey(err)) return attempt();
    throw err;
  });
  if (!review) throw new Error('review write produced no document');

  return toMyReview(review.toObject(), await productFacts([productId]));
}

/** Takes a person's own review down, and their star out of the average. */
export async function deleteOwnReview(userId: string, productIdParam: string): Promise<void> {
  const productId = objectId(productIdParam, 'Product');
  const owner = new mongoose.Types.ObjectId(userId);

  const removed = await withRatingRefresh(productId, async (session) => {
    const result = await Review.deleteOne({ product: productId, user: owner }, { session });
    return result.deletedCount > 0 ? true : null;
  });
  if (!removed) throw notFound('You have not reviewed that.');
}

/* ------------------------------------------------------------------ public -- */

export type PublicReview = {
  id: string;
  rating: number;
  title?: string;
  body?: string;
  authorName: string;
  purchased: { key: string; value: string }[];
  createdAt: string;
  editedAt: string | null;
};

/**
 * What anybody may read about a review. An explicit projection, like every response in
 * this codebase: the document carries the author's user id, the order, and a moderation
 * note, and none of those is public.
 */
function toPublicReview(review: ReviewRow): PublicReview {
  return {
    id: String(review._id),
    rating: review.rating,
    ...(review.title ? { title: review.title } : {}),
    ...(review.body ? { body: review.body } : {}),
    authorName: review.authorName,
    purchased: review.purchased.map((p) => ({ key: p.key, value: p.value })),
    createdAt: review.createdAt.toISOString(),
    editedAt: review.editedAt ? review.editedAt.toISOString() : null,
  };
}

/**
 * The reviews on a product page, with the summary above them.
 *
 * The summary is derived from the same published reviews the list shows, rather than read
 * from the product's stored figures, because it also carries the per-star distribution —
 * and because a page that says "12 reviews" above a list of eleven is the kind of thing
 * people screenshot.
 */
export async function listPublicReviews(slug: string, options: PublicReviewQuery) {
  const product = await Product.findOne({ slug: slug.toLowerCase(), status: 'active' })
    .select('_id')
    .lean();
  if (!product) throw notFound('Product not found.');

  const filter = { product: product._id, status: 'published' };
  const [rows, counts] = await Promise.all([
    Review.find(filter)
      .sort(SORTS[options.sort])
      .skip((options.page - 1) * options.perPage)
      .limit(options.perPage)
      .select('rating title body authorName purchased createdAt editedAt')
      .lean<ReviewRow[]>(),
    ratingCounts(product._id),
  ]);

  const summary: RatingSummary = summariseRatings(counts);

  return {
    data: rows.map(toPublicReview),
    summary,
    page: {
      page: options.page,
      perPage: options.perPage,
      total: summary.count,
      totalPages: Math.max(Math.ceil(summary.count / options.perPage), 1),
    },
  };
}

/* ----------------------------------------------------------------- account -- */

type ProductFacts = Map<
  string,
  { id: string; title: string; slug: string; imagePublicId?: string; onSale: boolean }
>;

async function productFacts(ids: mongoose.Types.ObjectId[]): Promise<ProductFacts> {
  const products = await Product.find({ _id: { $in: ids } })
    .select('title slug status images')
    .lean();
  return new Map(
    products.map((p) => {
      const image = [...(p.images ?? [])].sort((a, b) => a.position - b.position)[0];
      return [
        String(p._id),
        {
          id: String(p._id),
          title: p.title,
          slug: p.slug,
          ...(image?.publicId ? { imagePublicId: image.publicId } : {}),
          onSale: p.status === 'active',
        },
      ];
    }),
  );
}

export type MyReview = PublicReview & {
  product: { id: string; title: string; slug: string; imagePublicId?: string; onSale: boolean };
  status: 'published' | 'hidden';
  /** The shop's note, shown to the author only while their review is hidden. */
  hiddenReason: string | null;
};

function toMyReview(review: ReviewRow, facts: ProductFacts): MyReview {
  const product = facts.get(String(review.product)) ?? {
    id: String(review.product),
    title: 'A product no longer listed',
    slug: '',
    onSale: false,
  };
  return {
    ...toPublicReview(review),
    product,
    status: review.status,
    hiddenReason: review.status === 'hidden' ? (review.moderation?.note ?? null) : null,
  };
}

export type ReviewableItem = {
  productId: string;
  title: string;
  slug: string;
  imagePublicId?: string;
  orderNumber: string;
  deliveredAt: string;
};

/**
 * The account's review page: what this person has bought and not yet reviewed, and what
 * they have written.
 *
 * This is where the "write a review" button lives, rather than on the product page. The
 * product page is cached and does not know who is looking at it, and a button shown to
 * everybody that then tells almost everybody "you can't" is the disabled-control mistake
 * this codebase keeps declining to make. Here, every item offered can actually be
 * reviewed.
 */
export async function listMyReviews(userId: string) {
  const owner = new mongoose.Types.ObjectId(userId);

  const [written, delivered] = await Promise.all([
    Review.find({ user: owner }).sort({ createdAt: -1, _id: -1 }).limit(200).lean<ReviewRow[]>(),
    Order.find({ user: owner, 'history.status': 'delivered' })
      .sort({ createdAt: -1, _id: -1 })
      .limit(100)
      .select('orderNumber lines history')
      .lean(),
  ]);

  const reviewed = new Set(written.map((r) => String(r.product)));
  const candidates = new Map<string, { orderNumber: string; deliveredAt: Date }>();
  for (const order of delivered) {
    const deliveredAt = order.history.find((h) => h.status === 'delivered')?.at;
    if (!deliveredAt) continue;
    for (const line of order.lines) {
      const key = String(line.product);
      if (reviewed.has(key) || candidates.has(key)) continue;
      candidates.set(key, { orderNumber: order.orderNumber, deliveredAt });
    }
  }

  const facts = await productFacts([
    ...written.map((r) => r.product),
    ...[...candidates.keys()].map((id) => new mongoose.Types.ObjectId(id)),
  ]);

  const toWrite: ReviewableItem[] = [...candidates.entries()]
    .flatMap(([productId, from]) => {
      const product = facts.get(productId);
      // Archived since: there is no page for the review to appear on.
      if (!product?.onSale) return [];
      return [
        {
          productId,
          title: product.title,
          slug: product.slug,
          ...(product.imagePublicId ? { imagePublicId: product.imagePublicId } : {}),
          orderNumber: from.orderNumber,
          deliveredAt: from.deliveredAt.toISOString(),
        },
      ];
    })
    .sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));

  return { toWrite, written: written.map((review) => toMyReview(review, facts)) };
}

/* ------------------------------------------------------------------- admin -- */

export async function listReviewsForAdmin(options: AdminReviewQuery) {
  const { filter, sort } =
    options.queue === 'unread'
      ? // Oldest first: it is a queue, and the one that has waited longest is next.
        { filter: { needsReview: true }, sort: { createdAt: 1, _id: 1 } as const }
      : options.queue === 'hidden'
        ? { filter: { status: 'hidden' }, sort: { createdAt: -1, _id: -1 } as const }
        : { filter: {}, sort: { createdAt: -1, _id: -1 } as const };

  const [rows, total] = await Promise.all([
    Review.find(filter)
      .sort(sort)
      .skip((options.page - 1) * options.perPage)
      .limit(options.perPage)
      .lean<ReviewRow[]>(),
    Review.countDocuments(filter),
  ]);

  return {
    data: await toAdminReviews(rows),
    page: {
      page: options.page,
      perPage: options.perPage,
      total,
      totalPages: Math.max(Math.ceil(total / options.perPage), 1),
    },
  };
}

export type AdminReview = PublicReview & {
  status: 'published' | 'hidden';
  needsReview: boolean;
  moderation: { byEmail: string | null; at: string; note: string } | null;
  product: { id: string; title: string; slug: string; onSale: boolean };
  customer: { id: string; email: string | null };
  order: { id: string; orderNumber: string | null };
};

async function toAdminReviews(rows: ReviewRow[]): Promise<AdminReview[]> {
  const userIds = rows.flatMap((r) => [r.user, ...(r.moderation ? [r.moderation.by] : [])]);
  const [facts, users, orders] = await Promise.all([
    productFacts(rows.map((r) => r.product)),
    User.find({ _id: { $in: userIds } })
      .select('email')
      .lean(),
    Order.find({ _id: { $in: rows.map((r) => r.order) } })
      .select('orderNumber')
      .lean(),
  ]);
  const emailOf = new Map(users.map((u) => [String(u._id), u.email]));
  const numberOf = new Map(orders.map((o) => [String(o._id), o.orderNumber]));

  return rows.map((review) => {
    const product = facts.get(String(review.product));
    return {
      ...toPublicReview(review),
      status: review.status,
      needsReview: review.needsReview,
      moderation: review.moderation
        ? {
            byEmail: emailOf.get(String(review.moderation.by)) ?? null,
            at: review.moderation.at.toISOString(),
            note: review.moderation.note,
          }
        : null,
      product: {
        id: String(review.product),
        title: product?.title ?? 'A product no longer listed',
        slug: product?.slug ?? '',
        onSale: product?.onSale ?? false,
      },
      customer: { id: String(review.user), email: emailOf.get(String(review.user)) ?? null },
      order: { id: String(review.order), orderNumber: numberOf.get(String(review.order)) ?? null },
    };
  });
}

/**
 * Turns a guarded moderation write's refusal into a 409 naming the review's state now —
 * the same answer an order action gives, for the same reason: another admin got there
 * first, and the console reloads rather than showing an error it cannot explain.
 */
async function refused(id: mongoose.Types.ObjectId, verb: string): Promise<never> {
  const current = await Review.findById(id).select('status needsReview').lean();
  if (!current) throw notFound('Review not found.');
  throw conflict(`This review is already ${current.status} and cannot be ${verb}.`, {
    status: current.status,
    needsReview: current.needsReview,
  });
}

async function adminReviewById(id: mongoose.Types.ObjectId): Promise<AdminReview> {
  const row = await Review.findById(id).lean<ReviewRow | null>();
  if (!row) throw notFound('Review not found.');
  const [review] = await toAdminReviews([row]);
  return review!;
}

/**
 * Read, and left as it is. Takes the review out of the queue without changing what anyone
 * sees — which is what most moderation is.
 */
export async function keepReview(idParam: string): Promise<AdminReview> {
  const id = objectId(idParam, 'Review');
  const kept = await Review.findOneAndUpdate(
    { _id: id, needsReview: true },
    { $set: { needsReview: false } },
    { new: true },
  );
  if (!kept) return refused(id, 'marked as read');
  return adminReviewById(id);
}

/**
 * Takes a review off the product page and its star out of the average.
 *
 * Hidden, never deleted: the review, the reason and who hid it stay, the author sees the
 * reason on their own review page, and it can be put back. Moderation that leaves no trace
 * is the version that gets used on reviews that are merely unflattering.
 */
export async function hideReview(
  idParam: string,
  actorId: string,
  note: string,
): Promise<AdminReview> {
  const id = objectId(idParam, 'Review');
  const found = await Review.findById(id).select('product').lean();
  if (!found) throw notFound('Review not found.');

  const hidden = await withRatingRefresh(found.product, (session) =>
    Review.findOneAndUpdate(
      { _id: id, status: 'published' },
      {
        $set: {
          status: 'hidden',
          needsReview: false,
          moderation: { by: new mongoose.Types.ObjectId(actorId), at: new Date(), note },
        },
      },
      { new: true, session },
    ),
  );
  if (!hidden) return refused(id, 'hidden');

  logger.info({ reviewId: String(id), by: actorId }, 'review: hidden');
  return adminReviewById(id);
}

export async function restoreReview(idParam: string): Promise<AdminReview> {
  const id = objectId(idParam, 'Review');
  const found = await Review.findById(id).select('product').lean();
  if (!found) throw notFound('Review not found.');

  const restored = await withRatingRefresh(found.product, (session) =>
    Review.findOneAndUpdate(
      { _id: id, status: 'hidden' },
      { $set: { status: 'published', needsReview: false, moderation: null } },
      { new: true, session },
    ),
  );
  if (!restored) return refused(id, 'restored');
  return adminReviewById(id);
}
