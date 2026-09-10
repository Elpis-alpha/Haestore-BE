import { combineFilters, type FilterGroup } from './filter-expression.js';

/**
 * Disjunctive facet counts.
 *
 * The problem, stated once so it is not rediscovered: checkboxes *within* one attribute
 * are OR'd. Tick "Dark" under Roast and you expect the panel to keep offering Light and
 * Medium, with the counts you would get by ticking them as well. But the query that
 * produced the results already has `attr.roast IN ["dark"]` in its filter, so the facet
 * distribution it returns is computed over dark products only — and Light and Medium do
 * not read `0`, they **vanish from the response entirely**. The panel appears to lose
 * its own options the moment you use it.
 *
 * Verified against Meilisearch 1.11 before this was written:
 *
 *     filter: status = "active"                          -> {dark: 1, light: 1, medium: 1}
 *     filter: status = "active" AND attr.roast IN [light] -> {light: 1}
 *
 * The fix is one extra search per *selected* group, each computing that one group's
 * distribution with that group's own filter removed and every other filter kept, at
 * `hitsPerPage: 0` so it returns counts and no documents. Unselected groups need no
 * extra query — their counts are already correct in the main response, because nothing
 * filtered them.
 *
 * So an unfiltered listing is one request, and the cost grows only with how far the
 * shopper has narrowed. All of them go in one `/multi-search`, so it stays one round
 * trip regardless.
 */

export type FacetDistribution = Record<string, Record<string, number>>;
export type FacetStats = Record<string, { min: number; max: number }>;

export type FacetQueryPlan = {
  /** The main query's filter: everything, including every selected group. */
  mainFilter: string;
  /** All facets to request on the main query. */
  facets: string[];
  /**
   * One entry per selected group that owns a facet. Each carries the filter with that
   * group removed, and the single facet whose counts it exists to correct.
   */
  disjunctive: { facet: string; filter: string }[];
};

/**
 * Works out the queries one listing request needs.
 *
 * Pure and separately tested, because the failure it prevents is subtle in exactly the
 * way that survives manual testing: the counts are *plausible* when they are wrong.
 */
export function planFacetQueries(options: {
  base: FilterGroup[];
  selected: FilterGroup[];
  /** Every facet the panel wants counts for, whether selected or not. */
  facets: string[];
}): FacetQueryPlan {
  const all = [...options.base, ...options.selected];

  const disjunctive = options.selected
    .filter((group) => group.facet !== null && options.facets.includes(group.facet))
    .map((group) => ({
      facet: group.facet as string,
      // Every other filter survives. Dropping the whole selection instead would give
      // counts for a shop the shopper is not looking at.
      filter: combineFilters(all.filter((g) => g !== group)),
    }));

  return {
    mainFilter: combineFilters(all),
    facets: options.facets,
    disjunctive,
  };
}

/**
 * Overlays each disjunctive result onto the main distribution.
 *
 * The overlay **replaces** a facet's counts rather than merging value by value: the
 * corrected query is authoritative for that facet, and a merge would leave the
 * collapsed values from the main query sitting alongside the correct ones.
 */
export function mergeFacetDistributions(
  main: FacetDistribution | undefined,
  corrections: { facet: string; distribution: FacetDistribution | undefined }[],
): FacetDistribution {
  const merged: FacetDistribution = { ...(main ?? {}) };
  for (const correction of corrections) {
    const corrected = correction.distribution?.[correction.facet];
    if (corrected) merged[correction.facet] = corrected;
  }
  return merged;
}

/**
 * The same overlay for numeric facet bounds.
 *
 * A price or weight slider needs the bounds of what is *available*, not of what is
 * already selected — otherwise dragging the handle to 250–500 g redraws the slider as
 * 250–500 g and the shopper can never widen it again.
 */
export function mergeFacetStats(
  main: FacetStats | undefined,
  corrections: { facet: string; stats: FacetStats | undefined }[],
): FacetStats {
  const merged: FacetStats = { ...(main ?? {}) };
  for (const correction of corrections) {
    const corrected = correction.stats?.[correction.facet];
    if (corrected) merged[correction.facet] = corrected;
  }
  return merged;
}

/**
 * Turns Meilisearch's `attr.<key>` facet names back into the public parameter names,
 * and folds in the labels and ordering the panel renders from.
 *
 * A value present in the definition but absent from the distribution is emitted with a
 * count of zero rather than dropped. That is the whole point of the disjunctive pass:
 * the shopper needs to see that "Light" exists and currently matches nothing, not to
 * watch it disappear.
 */
export function presentFacets(options: {
  distribution: FacetDistribution;
  stats: FacetStats;
  attributes: {
    key: string;
    label: string;
    type: string;
    filterUi: string;
    unit?: string;
    options: { value: string; label: string; swatchHex?: string; order: number }[];
  }[];
  selected: Record<string, string[]>;
}) {
  return options.attributes.map((attribute) => {
    const facet = `attr.${attribute.key}`;
    const counts = options.distribution[facet] ?? {};
    const chosen = new Set(options.selected[attribute.key] ?? []);

    // A range control does not have per-value counts; it has bounds.
    if (attribute.filterUi === 'range') {
      const bounds = options.stats[facet];
      return {
        key: attribute.key,
        label: attribute.label,
        type: attribute.type,
        filterUi: attribute.filterUi,
        ...(attribute.unit ? { unit: attribute.unit } : {}),
        range: bounds ? { min: bounds.min, max: bounds.max } : null,
        values: [],
      };
    }

    const declared = attribute.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.swatchHex ? { swatchHex: option.swatchHex } : {}),
      count: counts[option.value] ?? 0,
      selected: chosen.has(option.value),
    }));

    // A boolean has no option list, so its two values come from the distribution.
    const values =
      declared.length > 0
        ? declared
        : Object.entries(counts)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([value, count]) => ({
              value,
              label: value,
              count,
              selected: chosen.has(value),
            }));

    return {
      key: attribute.key,
      label: attribute.label,
      type: attribute.type,
      filterUi: attribute.filterUi,
      ...(attribute.unit ? { unit: attribute.unit } : {}),
      range: null,
      values,
    };
  });
}
