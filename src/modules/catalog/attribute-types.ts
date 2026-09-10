/**
 * The vocabulary of the adaptable catalogue.
 *
 * Everything downstream — the Mongoose schemas, the runtime validator compiled per
 * category, the variant grid, the Meilisearch settings and the storefront filter UI —
 * agrees on the types named here. It is deliberately a small closed set: an admin
 * composes categories and attributes freely, but not the *kinds* of attribute, because
 * each kind has to have a storage slot, an index shape, a filter widget and a
 * validation rule, and those cannot be invented at runtime.
 */

export const ATTRIBUTE_TYPES = [
  'select',
  'multiselect',
  'text',
  'number',
  'boolean',
  'color',
  'dimension',
] as const;

export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export const FILTER_UIS = ['checkbox', 'swatch', 'range', 'toggle', 'select'] as const;
export type FilterUi = (typeof FILTER_UIS)[number];

/**
 * Attribute keys that would collide with a listing query parameter.
 *
 * A filterable attribute's key becomes a public URL parameter verbatim
 * (`?roast=medium`). If an admin created an attribute keyed `sort`, the storefront
 * could never tell a filter from a sort again. Rejecting at creation makes the
 * collision impossible by construction rather than something to detect later.
 */
export const RESERVED_ATTRIBUTE_KEYS = new Set([
  'q',
  'sort',
  'page',
  'per_page',
  'price',
  'in_stock',
  'view',
  'cursor',
  'category',
  'id',
  'slug',
]);

/**
 * Which types may serve as a variant axis.
 *
 * The rule is finite enumerability. A variant grid is the cartesian product of its
 * axes' values, so an axis whose value set is unbounded — free text, an arbitrary
 * number, a set of dimensions — cannot produce a grid at all. `multiselect` is
 * excluded for a different reason: a single variant cannot hold two values on one
 * axis, so the concept is incoherent rather than merely large.
 *
 * `number` is conditional: it qualifies only when the definition enumerates its
 * options (250 g / 500 g / 1 kg), which is exactly the case where it is really a
 * select whose labels happen to be numeric.
 */
export const AXIS_ELIGIBLE_TYPES = new Set<AttributeType>(['select', 'color', 'boolean', 'number']);

export function canBeVariantAxis(type: AttributeType, optionCount: number): boolean {
  if (!AXIS_ELIGIBLE_TYPES.has(type)) return false;
  if (type === 'boolean') return true;
  return optionCount > 0;
}

/** Types whose values come from a fixed option list. */
export function hasOptions(type: AttributeType): boolean {
  return type === 'select' || type === 'multiselect' || type === 'color';
}

/**
 * Where a value of each type is stored on `product.attributes[]`.
 *
 * The array is typed rather than a `Map` or a `{key, value}` pair, so this mapping is
 * total and every value lands in a field with a single BSON type — which is what makes
 * "weight between 250 and 1000 g" answerable by an index. See ADR-008.
 */
export const VALUE_FIELD: Record<AttributeType, string> = {
  select: 'valueString',
  color: 'valueString',
  text: 'valueString',
  multiselect: 'valueStrings',
  number: 'valueNumber',
  boolean: 'valueBool',
  dimension: 'valueDim',
};

/** Variant limits. */
export const VARIANT_WARN_THRESHOLD = 24;
export const VARIANT_HARD_LIMIT = 100;

/**
 * Which types can back a storefront filter.
 *
 * `isFilterable` on a definition is the admin's *intent*; this is whether the intent is
 * satisfiable. Both excluded types fail for the same underlying reason — no finite,
 * comparable value set — but they fail differently enough to be worth naming:
 *
 * `text` is free-form, so a checkbox group over it would list one value per product and
 * a range over it means nothing. `dimension` is three numbers and a unit, which has no
 * single ordering to range over and no equality that a shopper would recognise
 * (20×10×5 and 10×20×5 are the same box).
 *
 * This guard is applied in two places that must agree: the Meilisearch
 * `filterableAttributes` derivation and the generated filter panel. If only the panel
 * applied it, an admin could publish a filter the index refuses to answer; if only the
 * settings applied it, the panel would render a control whose every click 400s.
 */
export const FILTERABLE_TYPES = new Set<AttributeType>([
  'select',
  'multiselect',
  'color',
  'number',
  'boolean',
]);

export function isFilterableType(type: AttributeType): boolean {
  return FILTERABLE_TYPES.has(type);
}

/** Types whose filter is a numeric range rather than a set of discrete values. */
export function isRangeType(type: AttributeType): boolean {
  return type === 'number';
}
