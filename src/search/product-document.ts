import type { ProductAttrs } from '../modules/catalog/product.model.js';

/**
 * The shape of a product in Meilisearch.
 *
 * This is a **projection for listing**, not a copy of the product. It carries exactly
 * what a card renders plus what a filter, a sort or a facet needs, and nothing else:
 * the variant array, stock numbers, validation state and the full image list stay in
 * Mongo, which is what serves the product page.
 *
 * Two rules govern it.
 *
 * **Only `active` products are indexed at all.** A draft is not indexed as
 * `status: 'draft'` and filtered out later — it is deleted from the index the moment it
 * stops being active. `status` is still stored and still filtered on server-side,
 * because two independent reasons for a draft not to appear is the right number when
 * the failure mode is publishing an unfinished product.
 *
 * **Attribute values live under a single `attr` object**, so a runtime-defined key
 * becomes the Meilisearch filter name `attr.<key>` without colliding with anything this
 * file names. `AttributeDefinition.key` is `^[a-z][a-z0-9_]{1,39}$`, which contains no
 * dot, so `attr.<key>` is unambiguous and needs no escaping.
 */

export type SearchAttributeValue = string | string[] | number | boolean;

export type ProductSearchDocument = {
  id: string;
  title: string;
  slug: string;
  subtitle?: string;
  description?: string;

  categoryId: string;
  categoryAncestors: string[];

  status: 'active';

  /** Minor units, denormalised from the active variants. Sortable. */
  priceMin: number;
  priceMax: number;
  currency: string;
  inStock: boolean;

  ratingAverage: number;
  ratingCount: number;

  /** Epoch milliseconds. Meilisearch sorts numbers, not date strings. */
  createdAt: number;
  publishedAt: number;

  /** The card's single image. The gallery is a product-page concern. */
  image: {
    publicId: string;
    alt: string;
    width?: number;
    height?: number;
    blurDataUrl?: string;
  } | null;

  attr: Record<string, SearchAttributeValue>;
  /**
   * Rendered attribute values, joined, so a search for "dishwasher safe" or "celadon"
   * matches a product whose title never says either. Only definitions marked
   * `isSearchable` contribute; the rest would flood the ranking with boilerplate.
   */
  attrText?: string;
};

/**
 * Extracts an attribute's value into the slot its type dictates.
 *
 * `dimension` deliberately returns `undefined`: it is excluded from filtering
 * (see `isFilterableType`), and putting three numbers and a unit into a facet would
 * produce a value set no shopper could use. Its `displayValue` still reaches the index
 * through `attrText` when the definition is searchable.
 */
function attributeValue(
  attribute: ProductAttrs['attributes'][number],
): SearchAttributeValue | undefined {
  switch (attribute.type) {
    case 'multiselect':
      return attribute.valueStrings && attribute.valueStrings.length > 0
        ? [...attribute.valueStrings]
        : undefined;
    case 'number':
      return attribute.valueNumber ?? undefined;
    case 'boolean':
      return attribute.valueBool ?? undefined;
    case 'dimension':
      return undefined;
    default:
      return attribute.valueString ?? undefined;
  }
}

/**
 * The product as the index sees it.
 *
 * `searchableKeys` is the set of attribute keys whose definitions are marked
 * searchable; it is passed in rather than looked up so this stays a pure function and
 * so indexing a batch of products costs one definition query rather than one per
 * product.
 */
export function toSearchDocument(
  product: ProductAttrs & { _id: unknown },
  searchableKeys: ReadonlySet<string>,
): ProductSearchDocument {
  const attr: Record<string, SearchAttributeValue> = {};
  const searchableText: string[] = [];

  for (const attribute of product.attributes ?? []) {
    const value = attributeValue(attribute);
    if (value !== undefined) attr[attribute.key] = value;
    if (searchableKeys.has(attribute.key) && attribute.displayValue) {
      searchableText.push(attribute.displayValue);
    }
  }

  const image = (product.images ?? [])
    .slice()
    .sort((a, b) => a.position - b.position)
    .find((i) => Boolean(i.publicId));

  // A product with no active variant has no price range. It is still indexed — it is
  // active, so it is in the shop — and sorts as free rather than being dropped from
  // the listing entirely, which would be a silent disappearance no admin could explain.
  const priceMin = product.priceRange?.min ?? 0;
  const priceMax = product.priceRange?.max ?? priceMin;

  const createdAt = (product as { createdAt?: Date }).createdAt ?? new Date(0);

  return {
    id: String(product._id),
    title: product.title,
    slug: product.slug,
    ...(product.subtitle ? { subtitle: product.subtitle } : {}),
    ...(product.description ? { description: product.description } : {}),

    categoryId: String(product.category),
    categoryAncestors: (product.categoryAncestors ?? []).map(String),

    status: 'active',

    priceMin,
    priceMax,
    currency: product.priceRange?.currency ?? 'USD',
    inStock: product.inStock,

    ratingAverage: product.ratingAverage ?? 0,
    ratingCount: product.ratingCount ?? 0,

    createdAt: createdAt.getTime(),
    // Falls back to createdAt so `sort=newest` never has to cope with a null, which in
    // Meilisearch sorts to one end and would park unpublished-but-active products in a
    // block at the top or bottom of every listing.
    publishedAt: (product.publishedAt ?? createdAt).getTime(),

    image: image
      ? {
          publicId: image.publicId,
          alt: image.alt ?? '',
          ...(image.width != null ? { width: image.width } : {}),
          ...(image.height != null ? { height: image.height } : {}),
          ...(image.blurDataUrl ? { blurDataUrl: image.blurDataUrl } : {}),
        }
      : null,

    attr,
    ...(searchableText.length > 0 ? { attrText: searchableText.join(' · ') } : {}),
  };
}
