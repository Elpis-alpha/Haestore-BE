import { badRequest } from '../../lib/errors.js';
import type { Money } from '../../lib/money.js';
import { slugify } from '../../lib/slug.js';
import { VARIANT_HARD_LIMIT, VARIANT_WARN_THRESHOLD } from './attribute-types.js';
import type { EffectiveAttributeSet } from './effective-attributes.js';

/**
 * Variant grids.
 *
 * The category declares which attributes *may* be axes; the product declares which it
 * actually uses, and for each of those, which values it actually sells. The cartesian
 * product of those chosen values is a **suggestion** the admin prunes, not the
 * finished variant list.
 *
 * Generating from the category's full option set instead is the mistake that gives a
 * single-origin sold only as whole bean a phantom "ground" variant, and a 250 g-only
 * tin three weights it has never had.
 */

export type AxisSelection = {
  key: string;
  /** The option values this product actually offers on this axis. */
  values: string[];
};

export type GeneratedVariant = {
  axisValues: { key: string; value: string }[];
  sku: string;
};

export type GridPlan = {
  count: number;
  /** Advisory: the admin sees the number before anything is created. */
  warn: boolean;
  variants: GeneratedVariant[];
};

/**
 * Checks the requested axes against what the category permits, and rejects anything
 * that could not produce a finite grid.
 */
export function assertAxesAreValid(axes: AxisSelection[], set: EffectiveAttributeSet): void {
  const byKey = new Map(set.attributes.map((a) => [a.key, a]));
  const seen = new Set<string>();

  for (const axis of axes) {
    if (seen.has(axis.key)) {
      throw badRequest(`"${axis.key}" is listed twice as a variant axis.`);
    }
    seen.add(axis.key);

    const attribute = byKey.get(axis.key);
    if (!attribute) {
      throw badRequest(`"${axis.key}" is not an attribute of this category.`);
    }
    if (!attribute.isAxisEligible) {
      throw badRequest(
        `"${attribute.label}" cannot be a variant axis. Only select, colour, boolean ` +
          `and enumerated number attributes can, because an axis has to have a finite ` +
          `set of values.`,
      );
    }
    if (axis.values.length === 0) {
      throw badRequest(`"${attribute.label}" is a variant axis but no values were chosen.`);
    }

    // Boolean axes are implicitly ['true','false'] and carry no option list.
    if (attribute.type !== 'boolean') {
      const allowed = new Set(attribute.options.map((o) => o.value));
      const unknown = axis.values.filter((v) => !allowed.has(v));
      if (unknown.length > 0) {
        throw badRequest(`"${attribute.label}" does not offer: ${unknown.join(', ')}.`, {
          key: axis.key,
          unknown,
        });
      }
    }
  }
}

/**
 * The cartesian product, in a stable order.
 *
 * Order is deterministic — axes in the given order, values in the given order — so
 * regenerating a grid after adding one value produces the same rows in the same
 * positions, and the diff an admin sees is only what actually changed.
 */
export function planVariantGrid(
  axes: AxisSelection[],
  skuPrefix: string,
  set: EffectiveAttributeSet,
): GridPlan {
  assertAxesAreValid(axes, set);

  const count = axes.reduce((total, axis) => total * axis.values.length, 1);

  if (count > VARIANT_HARD_LIMIT) {
    throw badRequest(
      `That would create ${count} variants, over the limit of ${VARIANT_HARD_LIMIT}. ` +
        `Reduce the number of axes or the values on them.`,
      { count, limit: VARIANT_HARD_LIMIT },
    );
  }

  let rows: { key: string; value: string }[][] = [[]];
  for (const axis of axes) {
    const next: { key: string; value: string }[][] = [];
    for (const row of rows) {
      for (const value of axis.values) {
        next.push([...row, { key: axis.key, value }]);
      }
    }
    rows = next;
  }

  return {
    count,
    warn: count >= VARIANT_WARN_THRESHOLD,
    variants: rows.map((axisValues) => ({
      axisValues,
      sku: buildSku(skuPrefix, axisValues),
    })),
  };
}

/**
 * A readable, deterministic SKU: HAE-YIRGACHEFFE-WHOLE-250.
 *
 * Deterministic so regenerating a grid does not renumber existing rows, and readable
 * because a human reads it off a shelf label during picking.
 */
export function buildSku(prefix: string, axisValues: { key: string; value: string }[]): string {
  // Truncating a slug can land on the hyphen between two words, which would put
  // SINGLE-ORIGIN-ETHIOPIAN- on a shelf label. Every cut is re-trimmed.
  const clip = (value: string, max: number) => slugify(value).slice(0, max).replace(/-+$/, '');

  return [clip(prefix, 24), ...axisValues.map((a) => clip(a.value, 12))]
    .filter(Boolean)
    .join('-')
    .toUpperCase()
    .replace(/-+/g, '-')
    .slice(0, 64)
    .replace(/-+$/, '');
}

type PricedVariant = {
  price: Money;
  status: 'active' | 'inactive';
  stock: { available: number; backorderable?: boolean };
};

/**
 * The denormalised listing fields, recomputed on every write that could change them.
 *
 * Only **active** variants count. An inactive variant priced at $2 would otherwise
 * drag the card's "from" price down to something a customer cannot actually buy.
 */
export function summariseVariants(variants: PricedVariant[]): {
  priceRange: { min: number; max: number; currency: string } | null;
  inStock: boolean;
} {
  const active = variants.filter((v) => v.status === 'active');
  if (active.length === 0) return { priceRange: null, inStock: false };

  const currencies = new Set(active.map((v) => v.price.currency.toUpperCase()));
  if (currencies.size > 1) {
    throw badRequest('All variants of a product must be priced in the same currency.', {
      currencies: [...currencies],
    });
  }

  const amounts = active.map((v) => v.price.amount);
  const currency = active[0]?.price.currency.toUpperCase() ?? 'USD';

  return {
    priceRange: { min: Math.min(...amounts), max: Math.max(...amounts), currency },
    inStock: active.some((v) => v.stock.available > 0 || v.stock.backorderable === true),
  };
}
