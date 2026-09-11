import { Product } from '../catalog/product.model.js';
import { lineKeyOf } from './line-key.js';
import type { LiveCatalogue, LiveVariant } from './cart-types.js';

/**
 * What the shop currently says about the variants in a cart.
 *
 * **One query for the whole cart, never one per line.** A cart with eight lines that
 * issued eight finds would be the 2022 listing's N+1 in a smaller costume, and the cart
 * is read on every page that shows a bag count.
 *
 * The projection is mandatory and exhaustive: a product document carries a description,
 * an attribute array and an image list, none of which a cart line needs, and the 2022
 * app's habit of returning whole documents is the thing this codebase most consistently
 * refuses. `variants` cannot be projected down to the ones we want — a positional
 * projection matches only the first — so the array comes back whole and is narrowed in
 * memory, which is a handful of subdocuments rather than a second round trip.
 */
export async function loadLiveCatalogue(lineKeys: Iterable<string>): Promise<LiveCatalogue> {
  const wanted = new Set(lineKeys);
  if (wanted.size === 0) return new Map();

  const productIds = [...wanted].map((key) => key.split('_')[0]).filter(Boolean);

  const products = await Product.find({ _id: { $in: productIds } })
    .select('title slug status variants defaultVariantId images')
    .lean();

  const live: LiveCatalogue = new Map();

  for (const product of products) {
    const sellableProduct = product.status === 'active';
    const fallbackImage = product.images?.[0]?.publicId;

    for (const variant of product.variants) {
      const lineKey = lineKeyOf(String(product._id), String(variant._id));
      if (!wanted.has(lineKey)) continue;

      const entry: LiveVariant = {
        lineKey,
        productId: String(product._id),
        variantId: String(variant._id),
        sku: variant.sku,
        title: product.title,
        slug: product.slug,
        axisValues: variant.axisValues.map((a) => ({ key: a.key, value: a.value })),
        ...imageOf(variant.imagePublicIds?.[0] ?? fallbackImage),
        price: { amount: variant.price.amount, currency: variant.price.currency },
        available: variant.stock.available,
        backorderable: variant.stock.backorderable,
        lowStockThreshold: variant.stock.lowStockThreshold,
        // Both halves, because either one alone is enough to stop a sale: a draft
        // product's active variant is not for sale, and neither is an inactive variant
        // of a live product.
        sellable: sellableProduct && variant.status === 'active',
      };

      live.set(lineKey, entry);
    }
  }

  return live;
}

/** Spread-friendly, so an absent image omits the key rather than setting it undefined. */
function imageOf(publicId: string | undefined): { imagePublicId?: string } {
  return publicId ? { imagePublicId: publicId } : {};
}
