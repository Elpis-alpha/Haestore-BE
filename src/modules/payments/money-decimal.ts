import { minorUnitExponent, type Money } from '../../lib/money.js';

/**
 * The PayPal boundary: integer minor units on our side, decimal strings on theirs.
 *
 * Stripe takes an integer and gives an integer back, so it needs none of this. PayPal's
 * Orders API speaks `{ currency_code: 'USD', value: '19.99' }` in both directions, and
 * that string is the single most dangerous type conversion in the checkout — it is the
 * value the five-point capture check compares against, so a converter that is wrong by
 * one minor unit either rejects every legitimate payment or, far worse, accepts one for
 * the wrong amount.
 *
 * **Both directions are string arithmetic, and the reason is strictness, not rounding.**
 *
 * The rounding argument is the one you expect to find here, and it does not hold up.
 * `Math.round(parseFloat(s) * 100)` and `(minor / 100).toFixed(2)` were both checked
 * across every minor-unit value from 0 to 2,000,000, in 2- and 3-decimal currencies,
 * and neither is ever wrong. (The *unrounded* `parseFloat(s) * 100` is wrong for about
 * 13% of values — `0.07 * 100` is `7.000000000000001` — so the naive version everyone
 * writes first is genuinely broken, but `Math.round` rescues it.)
 *
 * What does not hold up is `parseFloat` as a parser of somebody else's money. It is
 * lenient in exactly the way a money parser must not be, and every one of these
 * produces a plausible wrong number rather than an error:
 *
 *     parseFloat('1,999.99')   // 1        — stops at the comma
 *     parseFloat('19.99 USD')  // 19.99    — ignores the trailing code
 *     parseFloat('1.9e3')      // 1900     — accepts an exponent as a price
 *     parseFloat('')           // NaN      — then Math.round(NaN * 100) is NaN
 *
 * And the sharp one, which is a real bug and not a hypothetical: `'19.999'` in a USD
 * order. `Math.round(19.999 * 100)` is `2000`, so a lenient parser silently rounds an
 * over-precise amount **up by a cent** and hands it to the equality check as though it
 * were exact. Refusing it is the only correct answer, and refusing requires knowing
 * the currency's exponent — which a hardcoded `100` does not.
 *
 * So the string implementation is not here to beat IEEE-754. It is here because it
 * cannot accept a shape it was not designed for, and because it is correct for JPY and
 * KWD by construction rather than by a second code path someone has to remember.
 *
 * The exponent comes from `Intl` via `minorUnitExponent`, so JPY (0 decimals) and KWD
 * (3) are handled by the same code rather than by a hardcoded 100.
 */

/** `{ amount: 1999, currency: 'USD' }` → `'19.99'`. `¥1999` → `'1999'`. */
export function toDecimalString(money: Money): string {
  if (!Number.isInteger(money.amount)) {
    throw new Error(`Money amount must be an integer minor-unit count, got ${money.amount}`);
  }

  const exponent = minorUnitExponent(money.currency);
  const negative = money.amount < 0;
  const digits = String(Math.abs(money.amount)).padStart(exponent + 1, '0');

  const major = digits.slice(0, digits.length - exponent);
  const minor = digits.slice(digits.length - exponent);

  const body = exponent === 0 ? major : `${major}.${minor}`;
  return negative ? `-${body}` : body;
}

/**
 * `'19.99'` → `{ amount: 1999, currency: 'USD' }`.
 *
 * **Strict, because it parses somebody else's output.** A value with too many decimal
 * places for its currency, a thousands separator, an exponent, or anything that is not
 * a plain decimal number is refused rather than coerced — if PayPal ever sends a shape
 * this does not recognise, the right outcome is a capture that fails loudly and is
 * reconciled by hand, not one that silently rounds a customer's money.
 */
export function fromDecimalString(value: string, currency: string): Money {
  const trimmed = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Not a plain decimal amount: ${JSON.stringify(value)}`);
  }

  const [, sign, major, minor = ''] = match;
  const exponent = minorUnitExponent(currency);

  if (minor.length > exponent) {
    throw new Error(
      `${JSON.stringify(value)} has ${minor.length} decimal places, but ${currency.toUpperCase()} has ${exponent}`,
    );
  }

  const digits = `${major}${minor.padEnd(exponent, '0')}`;
  const amount = Number(digits);

  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Amount out of safe integer range: ${JSON.stringify(value)}`);
  }

  return { amount: sign === '-' ? -amount : amount, currency: currency.toUpperCase() };
}

/**
 * Whether a provider's reported amount is *exactly* ours.
 *
 * There is no tolerance and there is deliberately no "close enough" branch. This is one
 * of the five checks that repair the 2022 app's worst defect, where
 * `POST /api/order/add-paypal` stored whatever the browser posted without ever asking
 * PayPal what had actually been captured.
 */
export function isExactAmount(ours: Money, theirs: Money): boolean {
  return (
    ours.amount === theirs.amount && ours.currency.toUpperCase() === theirs.currency.toUpperCase()
  );
}
