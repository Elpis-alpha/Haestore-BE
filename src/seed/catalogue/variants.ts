import type { SeedVariant } from './types.js';

/** Dollars to minor units, so the data reads as prices rather than as integers. */
export const usd = (dollars: number): number => Math.round(dollars * 100);

type Axis = Record<string, string>;

/**
 * One variant per combination of the given axes, in the order given — the same cartesian
 * order the console's grid builder produces.
 */
export function grid(
  axes: Record<string, string[]>,
  price: (axis: Axis) => number,
  onHand: number | ((axis: Axis) => number),
): SeedVariant[] {
  let rows: Axis[] = [{}];
  for (const [key, values] of Object.entries(axes)) {
    rows = rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
  }
  return rows.map((axis) => ({
    axis,
    price: price(axis),
    onHand: typeof onHand === 'function' ? onHand(axis) : onHand,
  }));
}

/** A product sold one way only. */
export function single(price: number, onHand: number, compareAt?: number): SeedVariant[] {
  return [{ price, onHand, ...(compareAt ? { compareAt } : {}) }];
}
