import type { EffectiveAttribute } from '../modules/catalog/effective-attributes.js';
import { isFilterableType } from '../modules/catalog/attribute-types.js';

/**
 * Turning query parameters into a Meilisearch filter expression.
 *
 * **This is the trust boundary.** Everything above it is a string a stranger typed into
 * a URL; everything below it is a filter DSL that Meilisearch will execute. The
 * frontend never talks to Meilisearch directly for exactly this reason (ADR-003).
 *
 * The attack it exists to stop is concrete, and was reproduced against the real server
 * before this was written. Interpolating a value raw:
 *
 *     attr.glaze = "celadon" OR status = "draft"
 *
 * returns the drafts. Escaping the same hostile value:
 *
 *     attr.glaze = "celadon\" OR status = \"draft"
 *
 * returns nothing, because it is now one string that no product has. Both behaviours
 * are asserted in filter-expression.test.ts, so the escape cannot be quietly removed.
 *
 * Three defences stack, and each would be sufficient on its own — which is the point,
 * because the consequence of the last one failing is publishing unfinished products:
 *
 *  1. A parameter must name an attribute the *category* actually binds and that is
 *     filterable. Anything else never reaches the DSL at all.
 *  2. Discrete values must appear in the definition's own option list; numbers must
 *     parse as finite. Nothing is interpolated that did not come from our database or
 *     survive `Number()`.
 *  3. Values are escaped and quoted, and `status = "active"` is appended server-side.
 */

/** Attribute keys are `^[a-z][a-z0-9_]{1,39}$`, re-asserted here rather than trusted. */
const SAFE_KEY = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * More than this many narrowing groups and the disjunctive facet pass costs one extra
 * search each (see facets.ts). Twelve is far past any real filter panel and well inside
 * what one `/multi-search` handles.
 */
export const MAX_SELECTED_GROUPS = 12;

/**
 * Escapes a value for interpolation inside a double-quoted Meilisearch filter literal.
 *
 * Backslash first, then quote — the other order would double-escape the backslashes
 * this function itself introduces.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** A value as a quoted, escaped filter literal. */
export function quoteFilterValue(value: string): string {
  return `"${escapeFilterValue(value)}"`;
}

export type FilterGroup = {
  /** The public parameter name: an attribute key, or `price` / `in_stock`. */
  key: string;
  /**
   * The Meilisearch facet this group constrains, when recomputing its counts without
   * its own filter is meaningful. Null when the group has no facet of its own.
   */
  facet: string | null;
  expression: string;
};

export type ParsedFilters = {
  groups: FilterGroup[];
  /**
   * Parameters that were dropped, and why.
   *
   * A bookmarked filter URL outlives the attribute it names: an admin archives
   * "Roast", and every link anyone saved now carries a key that no longer resolves.
   * Rejecting the request would turn that into a 400 on a page the shopper reached
   * from their own history. Dropping silently would show them different results with
   * no explanation. So it is dropped *and reported*, and the storefront says which
   * filters no longer apply.
   */
  ignored: { key: string; reason: string }[];
};

export type FilterInput = Record<string, string | string[] | undefined>;

/** `?roast=medium,dark` and `?roast=medium&roast=dark` mean the same thing. */
function valueList(raw: string | string[] | undefined): string[] {
  const parts = Array.isArray(raw) ? raw : [raw ?? ''];
  return parts
    .flatMap((p) => String(p).split(','))
    .map((p) => p.trim())
    .filter(Boolean);
}

/** `250-1000`, `250-`, `-1000`. Returns null when neither end parses. */
function parseRange(raw: string): { min?: number; max?: number } | null {
  const match = /^(-?\d+(?:\.\d+)?)?\s*(?:\.\.|-)\s*(-?\d+(?:\.\d+)?)?$/.exec(raw.trim());
  if (!match) {
    // A bare number is a range of one, which is what a shopper clicking "250 g" on a
    // slider-backed attribute means.
    const single = Number(raw.trim());
    if (raw.trim() !== '' && Number.isFinite(single)) return { min: single, max: single };
    return null;
  }
  const min = match[1] === undefined ? undefined : Number(match[1]);
  const max = match[2] === undefined ? undefined : Number(match[2]);
  if (min === undefined && max === undefined) return null;
  if (
    (min !== undefined && !Number.isFinite(min)) ||
    (max !== undefined && !Number.isFinite(max))
  ) {
    return null;
  }
  // Swapped bounds are a typo, not an empty result set.
  if (min !== undefined && max !== undefined && min > max) return { min: max, max: min };
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function rangeExpression(field: string, range: { min?: number; max?: number }): string {
  const clauses: string[] = [];
  if (range.min !== undefined) clauses.push(`${field} >= ${range.min}`);
  if (range.max !== undefined) clauses.push(`${field} <= ${range.max}`);
  return clauses.join(' AND ');
}

/**
 * Builds the attribute filter groups for one listing request.
 *
 * `attributes` is the category's *effective* set — resolved through the ancestry, with
 * suppressions applied. Using the effective set rather than every definition in the
 * shop is what stops `?roast=medium` filtering the ceramics listing by an attribute
 * ceramics does not bind.
 */
export function buildAttributeFilters(
  params: FilterInput,
  attributes: EffectiveAttribute[],
  /**
   * The fields the index can currently filter on, or null when that is unknown.
   *
   * An attribute defined moments ago is in MongoDB but not yet in the index settings,
   * which are debounced. Sending it anyway makes Meilisearch reject the entire request
   * rather than skip the filter — see index-capabilities.ts.
   */
  indexFields: ReadonlySet<string> | null = null,
): ParsedFilters {
  const byKey = new Map(attributes.map((a) => [a.key, a]));
  const groups: FilterGroup[] = [];
  const ignored: ParsedFilters['ignored'] = [];

  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined) continue;

    const attribute = byKey.get(key);
    if (!attribute) {
      ignored.push({ key, reason: 'This category does not use that attribute.' });
      continue;
    }
    if (!attribute.isFilterable || !isFilterableType(attribute.type)) {
      ignored.push({ key, reason: 'That attribute is not filterable.' });
      continue;
    }
    // The key came from our own database, so this can only fail if a definition was
    // written by something that bypassed the model's own pattern. It is still checked,
    // because the key is about to be concatenated into an expression.
    if (!SAFE_KEY.test(key)) {
      ignored.push({ key, reason: 'That attribute key is not usable as a filter.' });
      continue;
    }

    const field = `attr.${key}`;
    if (indexFields && !indexFields.has(field)) {
      ignored.push({ key, reason: 'That filter is not ready yet. Try again in a moment.' });
      continue;
    }

    const values = valueList(raw);
    if (values.length === 0) continue;

    if (attribute.type === 'number') {
      // `filterUi` is the admin's declared control. A number attribute rendered as a
      // slider filters by range; one rendered as checkboxes over enumerated options
      // (250 g / 500 g / 1 kg) filters by exact membership, and treating that as a
      // range would quietly include a 400 g bag nobody ticked.
      if (attribute.filterUi === 'range') {
        const range = parseRange(values.join(','));
        if (!range) {
          ignored.push({ key, reason: 'That is not a valid range.' });
          continue;
        }
        // Clamped to the definition's own bounds, so a hand-edited URL cannot widen
        // the range past what the admin declared.
        const min = attribute.validation.min;
        const max = attribute.validation.max;
        const clamped = {
          ...(range.min !== undefined
            ? { min: min !== undefined ? Math.max(range.min, min) : range.min }
            : {}),
          ...(range.max !== undefined
            ? { max: max !== undefined ? Math.min(range.max, max) : range.max }
            : {}),
        };
        groups.push({ key, facet: field, expression: rangeExpression(field, clamped) });
        continue;
      }

      const numbers = values.map(Number).filter((n) => Number.isFinite(n));
      if (numbers.length === 0) {
        ignored.push({ key, reason: 'None of those values are numbers.' });
        continue;
      }
      groups.push({
        key,
        facet: field,
        expression: `${field} IN [${numbers.join(', ')}]`,
      });
      continue;
    }

    if (attribute.type === 'boolean') {
      const wanted = values[0]?.toLowerCase();
      if (wanted !== 'true' && wanted !== 'false') {
        ignored.push({ key, reason: 'That value is not true or false.' });
        continue;
      }
      groups.push({ key, facet: field, expression: `${field} = ${wanted}` });
      continue;
    }

    // select, multiselect, color — membership of the definition's own option list.
    // This is the check that makes escaping a second line of defence rather than the
    // only one: a value that is not an option never reaches the expression.
    const allowed = new Set(attribute.options.map((o) => o.value));
    const accepted = values.filter((v) => allowed.has(v));
    if (accepted.length === 0) {
      ignored.push({ key, reason: 'No recognised values for that attribute.' });
      continue;
    }
    groups.push({
      key,
      facet: field,
      expression: `${field} IN [${accepted.map(quoteFilterValue).join(', ')}]`,
    });
  }

  return { groups: groups.slice(0, MAX_SELECTED_GROUPS), ignored };
}

/**
 * The clauses every storefront query carries, whatever the shopper asked for.
 *
 * `status = "active"` is appended here and nowhere else. It is not a default a caller
 * can override, and it is not a parameter — there is no code path from an HTTP request
 * to a listing that omits it.
 */
export function baseFilters(options: {
  categoryId?: string | null;
  inStock?: boolean;
  price?: { min?: number; max?: number } | null;
}): FilterGroup[] {
  const groups: FilterGroup[] = [{ key: 'status', facet: null, expression: 'status = "active"' }];

  if (options.categoryId) {
    if (!/^[0-9a-fA-F]{24}$/.test(options.categoryId)) {
      throw new Error(`refusing to filter on a non-id category: ${options.categoryId}`);
    }
    // One equality against the materialised ancestry covers the whole branch, and the
    // ancestry includes self, so a leaf category matches its own products too.
    groups.push({
      key: 'category',
      facet: null,
      expression: `categoryAncestors = ${quoteFilterValue(options.categoryId)}`,
    });
  }

  if (options.inStock) {
    groups.push({ key: 'in_stock', facet: null, expression: 'inStock = true' });
  }

  if (options.price && (options.price.min !== undefined || options.price.max !== undefined)) {
    // Overlap, not containment: a product sold from $15 to $32 belongs in a "$20–$25"
    // listing, because there is something in it you can buy for that. Containment would
    // hide every multi-variant product from every price filter.
    const clauses: string[] = [];
    if (options.price.max !== undefined) clauses.push(`priceMin <= ${options.price.max}`);
    if (options.price.min !== undefined) clauses.push(`priceMax >= ${options.price.min}`);
    groups.push({ key: 'price', facet: 'priceMin', expression: clauses.join(' AND ') });
  }

  return groups;
}

/** Combines groups into one expression. Empty groups produce an empty filter, not `()`. */
export function combineFilters(groups: FilterGroup[]): string {
  return groups
    .filter((g) => g.expression.length > 0)
    .map((g) => `(${g.expression})`)
    .join(' AND ');
}

/** The price range parameter, parsed. Exported so the route can report an unusable one. */
export function parsePriceRange(raw: string | string[] | undefined): {
  min?: number;
  max?: number;
} | null {
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const range = parseRange(value);
  if (!range) return null;
  // Prices are minor units: negative is meaningless and non-integers are a rounding
  // bug waiting to be blamed on the search index.
  const min = range.min === undefined ? undefined : Math.max(0, Math.floor(range.min));
  const max = range.max === undefined ? undefined : Math.max(0, Math.floor(range.max));
  return { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}
