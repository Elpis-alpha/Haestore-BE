import mongoose from 'mongoose';
import { logger } from '../../lib/logger.js';
import { Category } from '../catalog/category.model.js';
import { Product } from '../catalog/product.model.js';
import { listProducts, type ListingCard } from '../../search/search.service.js';
import type { ProductRowSection, Section } from './storefront.schema.js';

/**
 * Turns a layout into what the storefront renders: every reference replaced by the thing
 * it refers to, as it stands now.
 *
 * **References are resolved at read time and fail soft.** A layout names categories and
 * products by id, and either can be hidden, archived or deleted after the layout was
 * published. The alternatives are refusing to publish a layout that might go stale — which
 * is every layout — or copying product cards into the version, which freezes a price on
 * the front page. So a missing reference is skipped when rendering and *named* in
 * `warnings`, which only the composer's preview shows.
 *
 * One section failing does not fail the page. A product row whose search call errors
 * renders empty and the rest of the front page still arrives.
 */

export type ShelfCard = { id: string; name: string; path: string; imagePublicId?: string };

export type ResolvedSection =
  | Exclude<Section, { kind: 'shelves' } | { kind: 'product-row' }>
  | (Extract<Section, { kind: 'shelves' }> & { shelves: ShelfCard[] })
  | (ProductRowSection & {
      products: ListingCard[];
      /** Where "see more" goes, for a category row. */
      category: { name: string; path: string } | null;
    });

type CategoryRow = {
  _id: mongoose.Types.ObjectId;
  name: string;
  path: string;
  depth: number;
  order: number;
  imagePublicId?: string;
  status: string;
};

const toShelf = (c: CategoryRow): ShelfCard => ({
  id: String(c._id),
  name: c.name,
  path: c.path,
  ...(c.imagePublicId ? { imagePublicId: c.imagePublicId } : {}),
});

export async function resolveSections(
  sections: Section[],
): Promise<{ sections: ResolvedSection[]; warnings: string[] }> {
  const warnings: string[] = [];

  // Every category is read once and shared by every section that needs one, the way the
  // storefront header already shares the tree.
  const needsCategories = sections.some(
    (s) => s.kind === 'shelves' || (s.kind === 'product-row' && s.source === 'category'),
  );
  const categories = needsCategories
    ? await Category.find({ status: 'active' })
        .sort({ depth: 1, order: 1, name: 1 })
        .select('name path depth order imagePublicId status')
        .lean<CategoryRow[]>()
    : [];
  const byId = new Map(categories.map((c) => [String(c._id), c]));

  const resolved = await Promise.all(
    sections.map(async (section, index): Promise<ResolvedSection> => {
      const where = `Section ${index + 1} (${section.kind})`;

      if (section.kind === 'shelves') {
        if (section.categoryIds.length === 0) {
          return { ...section, shelves: categories.filter((c) => c.depth === 0).map(toShelf) };
        }
        const shelves: ShelfCard[] = [];
        for (const id of section.categoryIds) {
          const found = byId.get(id);
          if (found) shelves.push(toShelf(found));
          else warnings.push(`${where}: a chosen shelf is hidden or no longer exists.`);
        }
        return { ...section, shelves };
      }

      if (section.kind === 'product-row') {
        try {
          return await resolveProductRow(section, byId, (message) =>
            warnings.push(`${where}: ${message}`),
          );
        } catch (err) {
          logger.error(
            { err: (err as Error).message, section: section.id },
            'storefront: a product row could not be resolved, rendering it empty',
          );
          warnings.push(`${where}: the products could not be loaded just now.`);
          return { ...section, products: [], category: null };
        }
      }

      return section;
    }),
  );

  return { sections: resolved, warnings };
}

async function resolveProductRow(
  section: ProductRowSection,
  categories: Map<string, CategoryRow>,
  warn: (message: string) => void,
): Promise<ResolvedSection> {
  if (section.source === 'handpicked') {
    const ids = section.productIds.filter((id) => mongoose.isValidObjectId(id));
    const rows = await Product.find({ _id: { $in: ids }, status: 'active' })
      .select('title slug subtitle priceRange inStock images ratingAverage ratingCount')
      .lean();
    const found = new Map(rows.map((row) => [String(row._id), row]));

    const products: ListingCard[] = [];
    for (const id of section.productIds) {
      const row = found.get(id);
      if (row) products.push(cardFrom(row));
    }
    const missing = section.productIds.length - products.length;
    if (missing > 0) {
      warn(
        `${missing} hand-picked ${missing === 1 ? 'product is' : 'products are'} not on sale and will not be shown.`,
      );
    }
    return { ...section, products, category: null };
  }

  let category: CategoryRow | null = null;
  if (section.source === 'category') {
    category = section.categoryId ? (categories.get(section.categoryId) ?? null) : null;
    if (!category) {
      warn('its shelf is hidden or no longer exists, so the row is empty.');
      return { ...section, products: [], category: null };
    }
  }

  // The same listing the shop uses, so a row degrades exactly as the shop does when
  // search is down — MongoDB answers and the cards are the same shape.
  const listing = await listProducts({
    categoryId: category ? String(category._id) : null,
    attributes: [],
    attributeParams: {},
    sort: 'newest',
    page: 1,
    perPage: section.limit,
  });

  return {
    ...section,
    products: listing.data,
    category: category ? { name: category.name, path: category.path } : null,
  };
}

type CardSource = {
  _id: mongoose.Types.ObjectId;
  title: string;
  slug: string;
  subtitle?: string | null;
  priceRange?: { min?: number | null; max?: number | null; currency?: string | null } | null;
  inStock: boolean;
  images?: {
    publicId: string;
    alt?: string | null;
    width?: number | null;
    height?: number | null;
    blurDataUrl?: string | null;
    position: number;
  }[];
  ratingAverage?: number | null;
  ratingCount?: number | null;
};

/** The listing card, built from a product document — the same shape the search path emits. */
function cardFrom(row: CardSource): ListingCard {
  const image = [...(row.images ?? [])].sort((a, b) => a.position - b.position)[0];
  const range = row.priceRange;
  return {
    id: String(row._id),
    title: row.title,
    slug: row.slug,
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    priceRange:
      range && typeof range.min === 'number'
        ? { min: range.min, max: range.max ?? range.min, currency: range.currency ?? 'USD' }
        : null,
    inStock: row.inStock,
    image: image
      ? {
          publicId: image.publicId,
          alt: image.alt ?? '',
          ...(image.width ? { width: image.width } : {}),
          ...(image.height ? { height: image.height } : {}),
          ...(image.blurDataUrl ? { blurDataUrl: image.blurDataUrl } : {}),
        }
      : null,
    ratingAverage: row.ratingAverage ?? 0,
    ratingCount: row.ratingCount ?? 0,
  };
}
