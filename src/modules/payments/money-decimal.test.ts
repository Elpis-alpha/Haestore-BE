import { describe, expect, it } from 'vitest';
import { fromDecimalString, isExactAmount, toDecimalString } from './money-decimal.js';

/**
 * The plan names `0.10`, `1999.99` and `0.07` specifically. All three are values where
 * the float implementation is either wrong or right only by luck, which is the point:
 * the test exists to fail against `parseFloat(x) * 100`, not merely to pass here.
 */

describe('the three values the plan names', () => {
  it.each([
    ['0.10', 10],
    ['1999.99', 199999],
    ['0.07', 7],
  ])('round-trips %s as %i minor units', (decimal, minor) => {
    expect(fromDecimalString(decimal, 'USD')).toEqual({ amount: minor, currency: 'USD' });
    expect(toDecimalString({ amount: minor, currency: 'USD' })).toBe(decimal);
  });

  /**
   * The hazards the string implementation exists to avoid, asserted rather than
   * described — so that if someone later "simplifies" this file back to parseFloat,
   * these fail and say why.
   */
  it('is not reproducible by multiplying a float without rounding', () => {
    expect(0.07 * 100).not.toBe(7);
    expect(parseFloat('0.07') * 100).not.toBe(7);
  });

  it('refuses the over-precise amount that parseFloat would round up by a cent', () => {
    // The real bug: Math.round(19.999 * 100) is 2000, so a lenient parser turns an
    // amount we should have rejected into one that passes the exact-amount check.
    expect(Math.round(19.999 * 100)).toBe(2000);
    expect(() => fromDecimalString('19.999', 'USD')).toThrow();
  });

  it('refuses the shapes parseFloat silently turns into a plausible number', () => {
    expect(parseFloat('1,999.99')).toBe(1);
    expect(parseFloat('19.99 USD')).toBe(19.99);
    expect(parseFloat('1.9e3')).toBe(1900);

    expect(() => fromDecimalString('1,999.99', 'USD')).toThrow();
    expect(() => fromDecimalString('19.99 USD', 'USD')).toThrow();
    expect(() => fromDecimalString('1.9e3', 'USD')).toThrow();
  });
});

describe('toDecimalString', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [7, '0.07'],
    [10, '0.10'],
    [99, '0.99'],
    [100, '1.00'],
    [1999, '19.99'],
    [199999, '1999.99'],
    [100000000, '1000000.00'],
  ])('renders %i as %s', (amount, expected) => {
    expect(toDecimalString({ amount, currency: 'USD' })).toBe(expected);
  });

  it('always pads to the currency exponent, so PayPal never sees "19.9"', () => {
    expect(toDecimalString({ amount: 1990, currency: 'USD' })).toBe('19.90');
    expect(toDecimalString({ amount: 1900, currency: 'USD' })).toBe('19.00');
  });

  it('handles a currency with no minor unit', () => {
    expect(toDecimalString({ amount: 1999, currency: 'JPY' })).toBe('1999');
    expect(toDecimalString({ amount: 0, currency: 'JPY' })).toBe('0');
  });

  it('handles a three-decimal currency', () => {
    expect(toDecimalString({ amount: 1999, currency: 'KWD' })).toBe('1.999');
    expect(toDecimalString({ amount: 7, currency: 'KWD' })).toBe('0.007');
  });

  it('refuses a non-integer amount rather than rounding one', () => {
    expect(() => toDecimalString({ amount: 19.99, currency: 'USD' })).toThrow(/integer/i);
  });

  it('carries a sign through, for a refund', () => {
    expect(toDecimalString({ amount: -1999, currency: 'USD' })).toBe('-19.99');
  });
});

describe('fromDecimalString', () => {
  it.each([
    ['19.99', 1999],
    ['19.9', 1990],
    ['19', 1900],
    ['0', 0],
    ['0.00', 0],
    ['  19.99  ', 1999],
  ])('parses %s as %i minor units', (value, expected) => {
    expect(fromDecimalString(value, 'USD').amount).toBe(expected);
  });

  it('uppercases the currency it was told', () => {
    expect(fromDecimalString('19.99', 'usd')).toEqual({ amount: 1999, currency: 'USD' });
  });

  /**
   * Everything below is somebody else's output arriving in a shape we did not expect.
   * Each is refused, because the alternative to a loud failure here is a quiet one at
   * the amount comparison.
   */
  it.each([
    ['19.999', 'too many decimals for USD'],
    ['1,999.99', 'a thousands separator'],
    ['1.9e3', 'an exponent'],
    ['', 'empty'],
    ['abc', 'not a number'],
    ['19.99 USD', 'a trailing currency code'],
    ['.99', 'no major part'],
    ['19.', 'a trailing point'],
    ['+19.99', 'an explicit plus'],
  ])('refuses %s (%s)', (value) => {
    expect(() => fromDecimalString(value, 'USD')).toThrow();
  });

  it('accepts three decimals only where the currency has three', () => {
    expect(() => fromDecimalString('1.999', 'USD')).toThrow(/decimal places/);
    expect(fromDecimalString('1.999', 'KWD').amount).toBe(1999);
  });

  it('refuses an amount beyond safe integer range', () => {
    expect(() => fromDecimalString('999999999999999999.99', 'USD')).toThrow(/safe integer/);
  });
});

describe('the round trip', () => {
  it('is lossless across every minor unit from 0 to 10000', () => {
    for (let amount = 0; amount <= 10_000; amount += 1) {
      const money = { amount, currency: 'USD' };
      expect(fromDecimalString(toDecimalString(money), 'USD')).toEqual(money);
    }
  });
});

describe('isExactAmount', () => {
  it('accepts only an exact match', () => {
    expect(
      isExactAmount({ amount: 1999, currency: 'USD' }, { amount: 1999, currency: 'USD' }),
    ).toBe(true);
    expect(
      isExactAmount({ amount: 1999, currency: 'USD' }, { amount: 1998, currency: 'USD' }),
    ).toBe(false);
  });

  it('rejects the right amount in the wrong currency', () => {
    expect(
      isExactAmount({ amount: 1999, currency: 'USD' }, { amount: 1999, currency: 'EUR' }),
    ).toBe(false);
  });

  it('compares currency case-insensitively', () => {
    expect(
      isExactAmount({ amount: 1999, currency: 'USD' }, { amount: 1999, currency: 'usd' }),
    ).toBe(true);
  });
});
