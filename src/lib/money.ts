/**
 * Money is an integer count of minor units plus a currency.
 *
 * Never a float, and never a formatted string that has to be parsed back. The 2022
 * cart stored each line's *extended total* in a field called `price` and recovered the
 * unit price by dividing by quantity, so three items at $9.99 round-tripped correctly
 * only by luck. Keeping the smallest unit as an integer makes that unrepresentable.
 *
 * This mirrors front-end/src/lib/money.ts. The duplication is deliberate: the two
 * repos build independently (ADR-001), and a shared package would stop the frontend
 * building standalone on Cloudflare.
 */

export type Money = {
  /** Minor units: 1999 is $19.99, and 1999 is also ¥1999. */
  amount: number;
  /** ISO 4217, uppercase. */
  currency: string;
};

const exponents = new Map<string, number>();

/**
 * Minor units per major unit — 2 for USD, 0 for JPY, 3 for KWD. Read from Intl rather
 * than hardcoded, because the exceptions are the whole problem and a hand-written
 * table is a list of the ones you remembered.
 */
export function minorUnitExponent(currency: string): number {
  const key = currency.toUpperCase();
  const cached = exponents.get(key);
  if (cached !== undefined) return cached;

  const resolved =
    new Intl.NumberFormat('en', { style: 'currency', currency: key }).resolvedOptions()
      .maximumFractionDigits ?? 2;

  exponents.set(key, resolved);
  return resolved;
}

export function isSameCurrency(a: Money, b: Money): boolean {
  return a.currency.toUpperCase() === b.currency.toUpperCase();
}

export function addMoney(a: Money, b: Money): Money {
  if (!isSameCurrency(a, b)) {
    throw new Error(`Cannot add ${a.currency} to ${b.currency}`);
  }
  return { amount: a.amount + b.amount, currency: a.currency.toUpperCase() };
}

export function multiplyMoney(money: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) throw new Error('Quantity must be an integer');
  return { amount: money.amount * quantity, currency: money.currency.toUpperCase() };
}

export function formatMoney(money: Money, locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency.toUpperCase(),
  }).format(money.amount / 10 ** minorUnitExponent(money.currency));
}
