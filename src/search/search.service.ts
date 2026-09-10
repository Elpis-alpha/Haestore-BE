import { logger } from '../lib/logger.js';
import { Product } from '../modules/catalog/product.model.js';
import { isFilterableType } from '../modules/catalog/attribute-types.js';
import type { EffectiveAttribute } from '../modules/catalog/effective-attributes.js';
import { meili, PRODUCTS_INDEX } from './meili.js';
import {
  baseFilters,
  buildAttributeFilters,
  type FilterInput,
  type ParsedFilters,
} from './filter-expression.js';
import {
  mergeFacetDistributions,
  mergeFacetStats,
  planFacetQueries,
  presentFacets,
  type FacetDistribution,
  type FacetStats,
} from './facets.js';
import { MAX_TOTAL_HITS } from './settings.js';
import { filterableFields } from './index-capabilities.js';

/**
 * The storefront listing.
 *
 * One endpoint serves it, and `page.degraded` says which engine answered. That is a
 * deliberate choice over exposing two URLs: the storefront should not have to know
 * whether the search cluster is healthy in order to render a shop, and a fallback that
 * lives behind a different URL is a fallback nobody has ever tested.
 *
 * What degrades is faceting, not the catalogue. Meilisearch computes hits and facet
 * counts from an inverted index in one request; MongoDB cannot answer the same question
 * at all without a `$facet` stacked on a blocking in-memory sort (ADR-003). So when
 * search is down the shop stays open, sortable and paginated, with `facets: null` and
 * the filter panel hidden rather than lying.
 */

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;

/** Sorts are a closed set, mapped here. A client never names an index field. */
const SORTS = {
  newest: ['publishedAt:desc'],
  oldest: ['publishedAt:asc'],
  // Both directions sort on `priceMin` — the "from" price is the number on the card, so
  // sorting by anything else produces an order the shopper cannot see the logic of.
  price_asc: ['priceMin:asc'],
  price_desc: ['priceMin:desc'],
  rating: ['ratingAverage:desc', 'ratingCount:desc'],
  /** No sort clause at all: Meilisearch's own ranking. Only meaningful with a query. */
  relevance: [] as string[],
} as const;

export type SortKey = keyof typeof SORTS;
export const SORT_KEYS = Object.keys(SORTS) as SortKey[];

export type ListingRequest = {
  q?: string;
  categoryId?: string | null;
  /** The category's effective attributes, which say what may be filtered and faceted. */
  attributes: EffectiveAttribute[];
  /** Every query parameter that is not reserved — candidate attribute filters. */
  attributeParams: FilterInput;
  price?: { min?: number; max?: number } | null;
  inStock?: boolean;
  sort: SortKey;
  page: number;
  perPage: number;
};

export type ListingCard = {
  id: string;
  title: string;
  slug: string;
  subtitle?: string;
  priceRange: { min: number; max: number; currency: string } | null;
  inStock: boolean;
  image: unknown;
  ratingAverage: number;
  ratingCount: number;
};

export type ListingResult = {
  data: ListingCard[];
  page: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
    /** True when MongoDB answered. Facets are null and filters were not applied. */
    degraded: boolean;
  };
  facets: ReturnType<typeof presentFacets> | null;
  ignoredFilters: ParsedFilters['ignored'];
};

/** The attributes that get a facet: filterable in intent and satisfiable in type. */
function facetableAttributes(attributes: EffectiveAttribute[]): EffectiveAttribute[] {
  return attributes.filter((a) => a.isFilterable && isFilterableType(a.type));
}

export async function listProducts(request: ListingRequest): Promise<ListingResult> {
  try {
    return await searchProducts(request);
  } catch (error) {
    // Any Meilisearch failure degrades rather than 500s. A shop that cannot be filtered
    // still sells; a shop that returns an error page does not.
    logger.error(
      { err: (error as Error).message },
      'search: listing failed, falling back to MongoDB',
    );
    return degradedListing(request);
  }
}

async function searchProducts(request: ListingRequest): Promise<ListingResult> {
  // Only what the index can answer today. An attribute defined in the last few seconds
  // is in the effective set but not yet in the index settings, and asking for it would
  // fail the whole request rather than skip one facet.
  const indexFields = await filterableFields();
  const facetable = facetableAttributes(request.attributes).filter(
    (a) => !indexFields || indexFields.has(`attr.${a.key}`),
  );
  const parsed = buildAttributeFilters(request.attributeParams, request.attributes, indexFields);

  const base = baseFilters({
    categoryId: request.categoryId ?? null,
    ...(request.inStock ? { inStock: true } : {}),
    price: request.price ?? null,
  });

  // `price` is a base filter but owns a facet: its bounds must be computed without
  // itself, or the slider collapses to the range already chosen and cannot be widened.
  const selected = [...base.filter((g) => g.key === 'price'), ...parsed.groups];
  const baseWithoutPrice = base.filter((g) => g.key !== 'price');

  const facets = [...facetable.map((a) => `attr.${a.key}`), 'priceMin'];

  const plan = planFacetQueries({ base: baseWithoutPrice, selected, facets });

  const sort = [...SORTS[request.sort]];
  const queries = [
    {
      indexUid: PRODUCTS_INDEX,
      q: request.q ?? '',
      filter: plan.mainFilter,
      facets: plan.facets,
      page: request.page,
      hitsPerPage: request.perPage,
      ...(sort.length > 0 ? { sort } : {}),
    },
    // One `hitsPerPage: 0` query per selected group. These return counts and no
    // documents, so the extra cost is the facet computation and not a second page of
    // hits. An unfiltered listing has none of them and stays a single query.
    ...plan.disjunctive.map((d) => ({
      indexUid: PRODUCTS_INDEX,
      q: request.q ?? '',
      filter: d.filter,
      facets: [d.facet],
      hitsPerPage: 0,
      page: 1,
    })),
  ];

  const { results } = await meili.multiSearch({ queries });
  const [main, ...corrections] = results as unknown as SearchResponse[];

  if (!main) throw new Error('multi-search returned no results');

  const distribution = mergeFacetDistributions(
    main.facetDistribution,
    plan.disjunctive.map((d, i) => ({
      facet: d.facet,
      distribution: corrections[i]?.facetDistribution,
    })),
  );
  const stats = mergeFacetStats(
    main.facetStats,
    plan.disjunctive.map((d, i) => ({ facet: d.facet, stats: corrections[i]?.facetStats })),
  );

  const selectedValues: Record<string, string[]> = {};
  for (const group of parsed.groups) {
    const raw = request.attributeParams[group.key];
    selectedValues[group.key] = (Array.isArray(raw) ? raw : [raw ?? ''])
      .flatMap((v) => String(v).split(','))
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return {
    data: main.hits.map(toCard),
    page: {
      page: request.page,
      perPage: request.perPage,
      total: main.totalHits ?? 0,
      totalPages: main.totalPages ?? 0,
      degraded: false,
    },
    facets: presentFacets({
      distribution,
      stats,
      attributes: facetable.map((a) => ({
        key: a.key,
        label: a.label,
        type: a.type,
        filterUi: a.filterUi,
        ...(a.unit ? { unit: a.unit } : {}),
        options: a.options,
      })),
      selected: selectedValues,
    }),
    ignoredFilters: parsed.ignored,
  };
}

/**
 * A hit, as this code is willing to read it.
 *
 * The client types hits as `Record<string, any>`, which would let a typo in a field name
 * through to the response as `undefined`. Naming the projection here means the card
 * mapping is checked against the document `displayedAttributes` actually returns.
 */
type SearchHit = {
  id: string;
  title?: string;
  slug?: string;
  subtitle?: string;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
  inStock?: boolean;
  image?: unknown;
  ratingAverage?: number;
  ratingCount?: number;
};

type SearchResponse = {
  hits: SearchHit[];
  facetDistribution?: FacetDistribution;
  facetStats?: FacetStats;
  totalHits?: number;
  totalPages?: number;
};

function toCard(hit: SearchHit): ListingCard {
  return {
    id: String(hit.id),
    title: hit.title ?? '',
    slug: hit.slug ?? '',
    ...(hit.subtitle ? { subtitle: hit.subtitle } : {}),
    priceRange:
      hit.priceMin === undefined
        ? null
        : {
            min: hit.priceMin,
            max: hit.priceMax ?? hit.priceMin,
            currency: hit.currency ?? 'USD',
          },
    inStock: Boolean(hit.inStock),
    image: hit.image ?? null,
    ratingAverage: hit.ratingAverage ?? 0,
    ratingCount: hit.ratingCount ?? 0,
  };
}

/**
 * The MongoDB fallback.
 *
 * **Attribute filters are not applied here, and that is reported rather than hidden.**
 * Answering them would need the multikey intersection plus blocking sort that ADR-003
 * exists to avoid; a fallback that got slower the more the shopper filtered would turn
 * a search outage into a database outage. Every attribute parameter comes back in
 * `ignoredFilters` with a reason, so the storefront can say the panel is unavailable
 * instead of silently showing unfiltered results as though they were filtered.
 *
 * Category, stock, price and sort *are* honoured — they are covered by the compound
 * index Phase 2 built for exactly this path.
 */
async function degradedListing(request: ListingRequest): Promise<ListingResult> {
  const filter: Record<string, unknown> = { status: 'active' };
  if (request.categoryId) filter.categoryAncestors = request.categoryId;
  if (request.inStock) filter.inStock = true;
  if (request.price) {
    // The same overlap semantics as the search path, so the two engines agree on what a
    // price filter means.
    const clauses: Record<string, unknown> = {};
    if (request.price.max !== undefined) clauses['priceRange.min'] = { $lte: request.price.max };
    if (request.price.min !== undefined) clauses['priceRange.max'] = { $gte: request.price.min };
    Object.assign(filter, clauses);
  }

  const sorts: Record<SortKey, Record<string, 1 | -1>> = {
    newest: { publishedAt: -1, _id: -1 },
    oldest: { publishedAt: 1, _id: 1 },
    price_asc: { 'priceRange.min': 1, _id: 1 },
    price_desc: { 'priceRange.min': -1, _id: -1 },
    rating: { ratingAverage: -1, _id: -1 },
    relevance: { publishedAt: -1, _id: -1 },
  };

  // Bounded to the same depth Meilisearch allows, which is what makes `.skip()`
  // affordable here: the deepest reachable page skips at most MAX_TOTAL_HITS documents,
  // and the two engines refuse the same pages rather than one serving what the other
  // will not.
  const maxPage = Math.max(1, Math.floor(MAX_TOTAL_HITS / request.perPage));
  const page = Math.min(request.page, maxPage);

  const [rows, total] = await Promise.all([
    Product.find(filter)
      .select('title slug subtitle priceRange inStock images ratingAverage ratingCount')
      .sort(sorts[request.sort])
      .skip((page - 1) * request.perPage)
      .limit(request.perPage)
      .lean(),
    Product.countDocuments(filter),
  ]);

  const ignored = Object.keys(request.attributeParams).map((key) => ({
    key,
    reason: 'Search is unavailable, so attribute filters are not being applied.',
  }));

  return {
    data: rows.map((row) => {
      const image = [...(row.images ?? [])].sort((a, b) => a.position - b.position)[0];
      return {
        id: String(row._id),
        title: row.title,
        slug: row.slug,
        ...(row.subtitle ? { subtitle: row.subtitle } : {}),
        priceRange:
          row.priceRange?.min == null
            ? null
            : {
                min: row.priceRange.min,
                max: row.priceRange.max ?? row.priceRange.min,
                currency: row.priceRange.currency ?? 'USD',
              },
        inStock: row.inStock,
        image: image
          ? {
              publicId: image.publicId,
              alt: image.alt ?? '',
              ...(image.width != null ? { width: image.width } : {}),
              ...(image.height != null ? { height: image.height } : {}),
              ...(image.blurDataUrl ? { blurDataUrl: image.blurDataUrl } : {}),
            }
          : null,
        ratingAverage: row.ratingAverage ?? 0,
        ratingCount: row.ratingCount ?? 0,
      };
    }),
    page: {
      page,
      perPage: request.perPage,
      total: Math.min(total, MAX_TOTAL_HITS),
      totalPages: Math.min(Math.ceil(total / request.perPage), maxPage),
      degraded: true,
    },
    facets: null,
    ignoredFilters: ignored,
  };
}
