import type { Settings } from 'meilisearch';
import { AttributeDefinition } from '../modules/catalog/attribute-definition.model.js';
import { isFilterableType, type AttributeType } from '../modules/catalog/attribute-types.js';

/**
 * Index settings, derived from the catalogue rather than authored.
 *
 * Meilisearch requires `filterableAttributes` to be declared up front, which looks like
 * a flat contradiction of admin-defined attributes: you cannot list what does not exist
 * yet. It is not a contradiction, because the list is **computed** — every definition
 * marked filterable becomes `attr.<key>`, and defining a new attribute is therefore a
 * settings change like any other rather than a deploy. See ADR-003.
 *
 * The cost is that `updateSettings` triggers a partial re-index, so this must never be
 * called once per admin save. The debounced job in `queue.ts` is what enforces that.
 */

/** Fields every listing needs regardless of what any admin has defined. */
export const BASE_FILTERABLE = [
  'status',
  'categoryId',
  'categoryAncestors',
  'priceMin',
  'priceMax',
  'currency',
  'inStock',
  'ratingAverage',
] as const;

/**
 * Sorts are a whitelist, and this is it. A client sends `sort=price_asc`, never a
 * Meilisearch sort expression — an attacker who could name the sort field could order
 * by anything in the document and read it out through pagination.
 */
export const SORTABLE = [
  'priceMin',
  'priceMax',
  'createdAt',
  'publishedAt',
  'ratingAverage',
  'ratingCount',
] as const;

export const BASE_SEARCHABLE = ['title', 'subtitle', 'attrText', 'description'] as const;

/**
 * `maxTotalHits` bounds how deep pagination can go, and 1000 is Meilisearch's default.
 * It is left alone deliberately: it is also what makes the Mongo fallback's `.skip()`
 * affordable, since the two paths must agree on how deep a page number can be before
 * one of them starts refusing pages the other serves.
 */
export const MAX_TOTAL_HITS = 1000;

export type DefinitionForSettings = {
  key: string;
  type: AttributeType;
  isFilterable: boolean;
  isSearchable: boolean;
};

/**
 * Pure, so the derivation is testable without a database or a search server — which
 * matters because getting it wrong is invisible until a filter silently returns
 * everything.
 */
export function buildSearchSettings(definitions: DefinitionForSettings[]): Settings {
  const filterable = new Set<string>(BASE_FILTERABLE);
  const searchable: string[] = [...BASE_SEARCHABLE];

  // Sorted so the settings object is stable across calls. Meilisearch compares the
  // submitted settings against the current ones, and an unstable ordering would make
  // every sync look like a change and trigger a needless partial re-index.
  const sorted = [...definitions].sort((a, b) => a.key.localeCompare(b.key));

  for (const definition of sorted) {
    // Admin intent, then whether the intent is satisfiable. A `text` attribute marked
    // filterable is not an error to report — it is a control that cannot work, and the
    // filter panel drops it by the same rule.
    if (definition.isFilterable && isFilterableType(definition.type)) {
      filterable.add(`attr.${definition.key}`);
    }
  }

  return {
    filterableAttributes: [...filterable].sort(),
    sortableAttributes: [...SORTABLE],
    searchableAttributes: searchable,
    // Everything the card needs, and nothing more: the index should never be a second
    // copy of the catalogue that can drift into being authoritative.
    displayedAttributes: [
      'id',
      'title',
      'slug',
      'subtitle',
      'categoryId',
      'categoryAncestors',
      'priceMin',
      'priceMax',
      'currency',
      'inStock',
      'ratingAverage',
      'ratingCount',
      'createdAt',
      'publishedAt',
      'image',
      'attr',
    ],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    pagination: { maxTotalHits: MAX_TOTAL_HITS },
    faceting: {
      // A colour or a size attribute can legitimately have well over the default 100
      // values, and a facet that silently truncates is worse than one that is slow:
      // the missing values look like "no products match" rather than "not shown".
      maxValuesPerFacet: 300,
    },
    typoTolerance: {
      enabled: true,
      // Product names are short and often proper nouns ("Hario", "Kinto"), where a
      // one-character typo allowance turns one brand into another.
      minWordSizeForTypos: { oneTypo: 5, twoTypos: 9 },
    },
  };
}

/** Reads the definitions the settings are derived from. */
export async function loadDefinitionsForSettings(): Promise<DefinitionForSettings[]> {
  const definitions = await AttributeDefinition.find({ archivedAt: { $exists: false } })
    .select('key type isFilterable isSearchable')
    .lean();

  return definitions.map((d) => ({
    key: d.key,
    type: d.type,
    isFilterable: d.isFilterable,
    isSearchable: d.isSearchable,
  }));
}

/** The attribute keys whose display values are worth putting in the search text. */
export async function loadSearchableKeys(): Promise<Set<string>> {
  const definitions = await AttributeDefinition.find({
    isSearchable: true,
    archivedAt: { $exists: false },
  })
    .select('key')
    .lean();
  return new Set(definitions.map((d) => d.key));
}
