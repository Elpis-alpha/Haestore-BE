import mongoose from 'mongoose';
import { conflict, notFound } from '../../lib/errors.js';
import { Product } from '../catalog/product.model.js';
import { Wishlist, WISHLIST_LIMIT } from './wishlist.model.js';
import { lineKeyOf } from '../cart/line-key.js';
import type { Money } from '../../lib/money.js';

/**
 * The wishlist, which is a list of *products* with the storefront's own facts attached
 * on read.
 *
 * Nothing about price or stock is stored on an item. A wishlist is looked at weeks
 * after it is written, so a snapshot would be wrong by definition — and the one thing a
 * shopper wants from it is "is it back in stock, is it cheaper now", which only a live
 * read can answer. That is the opposite trade-off from a cart line, which snapshots
 * precisely so a change can be *named*; here there is no previous figure the shopper is
 * holding in their head.
 */

export type WishlistEntry = {
  productId: string;
  variantId: string | null;
  /** Present so the frontend can hand it straight to the cart. */
  lineKey: string | null;
  title: string;
  slug: string;
  imagePublicId?: string;
  price: Money | null;
  priceTo: Money | null;
  inStock: boolean;
  available: boolean;
  addedAt: string;
};

export async function listWishlist(userId: string): Promise<WishlistEntry[]> {
  const wishlist = await Wishlist.findOne({ user: new mongoose.Types.ObjectId(userId) }).lean();
  if (!wishlist || wishlist.items.length === 0) return [];

  const products = await Product.find({ _id: { $in: wishlist.items.map((i) => i.product) } })
    .select('title slug status variants priceRange inStock images')
    .lean();

  const byId = new Map(products.map((p) => [String(p._id), p]));

  return wishlist.items
    .map((item): WishlistEntry | null => {
      const product = byId.get(String(item.product));
      // A product that was deleted outright rather than archived. Dropped from the view
      // rather than rendered as a blank row; the stored item is swept by `prune`.
      if (!product) return null;

      const variant = item.variantId
        ? product.variants.find((v) => String(v._id) === String(item.variantId))
        : undefined;

      const live = product.status === 'active';
      const image = variant?.imagePublicIds?.[0] ?? product.images?.[0]?.publicId;

      return {
        productId: String(product._id),
        variantId: item.variantId ? String(item.variantId) : null,
        lineKey: variant ? lineKeyOf(String(product._id), String(variant._id)) : null,
        title: product.title,
        slug: product.slug,
        ...(image ? { imagePublicId: image } : {}),
        price: variant
          ? { amount: variant.price.amount, currency: variant.price.currency }
          : product.priceRange?.min != null && product.priceRange.currency
            ? { amount: product.priceRange.min, currency: product.priceRange.currency }
            : null,
        priceTo:
          !variant && product.priceRange?.max != null && product.priceRange.currency
            ? { amount: product.priceRange.max, currency: product.priceRange.currency }
            : null,
        inStock: variant ? variant.stock.available > 0 : Boolean(product.inStock),
        // Whether it can still be bought at all, which is a different question from
        // whether it is in stock — and the one that decides if "Add to bag" is offered.
        available: live && (variant ? variant.status === 'active' : product.variants.length > 0),
        addedAt: item.addedAt.toISOString(),
      };
    })
    .filter((entry): entry is WishlistEntry => entry !== null);
}

/**
 * Idempotent by design: wishing for something twice is one wish.
 *
 * `$addToSet` will not do it — the item carries `addedAt`, so two adds are two distinct
 * subdocuments and the set would happily hold both. The guarded `$push` below refuses at
 * the query filter instead, which is atomic and needs no read-then-write.
 */
export async function addWish(
  userId: string,
  productId: string,
  variantId?: string | null,
): Promise<void> {
  const product = await Product.findOne({ _id: productId, status: 'active' })
    .select('_id variants')
    .lean();
  if (!product) throw notFound('That is not something we sell.');

  if (variantId && !product.variants.some((v) => String(v._id) === variantId)) {
    throw notFound('That option does not exist.');
  }

  const user = new mongoose.Types.ObjectId(userId);
  const item = {
    product: new mongoose.Types.ObjectId(productId),
    variantId: variantId ? new mongoose.Types.ObjectId(variantId) : null,
    addedAt: new Date(),
  };

  const existing = await Wishlist.findOne({ user }).select('items').lean();
  if (existing && existing.items.length >= WISHLIST_LIMIT) {
    throw conflict(`A wishlist holds at most ${WISHLIST_LIMIT} items.`);
  }

  const result = await Wishlist.updateOne(
    {
      user,
      // The whole idempotency check, in the filter. A second add matches nothing and
      // modifies nothing, rather than needing a read whose answer could be stale by the
      // time the write lands.
      items: {
        $not: { $elemMatch: { product: item.product, variantId: item.variantId } },
      },
    },
    { $push: { items: item }, $setOnInsert: { user } },
    { upsert: true },
  ).catch((err: unknown) => {
    // Two tabs adding the same thing at once: one upsert inserts, the other collides on
    // the unique `user` index. The wish is already recorded, so this is a success.
    if ((err as { code?: number }).code === 11000) return null;
    throw err;
  });

  void result;
}

export async function removeWish(
  userId: string,
  productId: string,
  variantId?: string | null,
): Promise<void> {
  await Wishlist.updateOne(
    { user: new mongoose.Types.ObjectId(userId) },
    {
      $pull: {
        items: {
          product: new mongoose.Types.ObjectId(productId),
          variantId: variantId ? new mongoose.Types.ObjectId(variantId) : null,
        },
      },
    },
  );
}
