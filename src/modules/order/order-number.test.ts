import { describe, expect, it } from 'vitest';
import {
  ORDER_NUMBER_PATTERN,
  generateOrderNumber,
  isOrderNumber,
  normaliseOrderNumber,
} from './order-number.js';

describe('generateOrderNumber', () => {
  it('produces the documented shape', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOrderNumber()).toMatch(ORDER_NUMBER_PATTERN);
    }
  });

  /**
   * The alphabet's whole purpose. If a generated number could contain one of these, the
   * normaliser below would fold it onto a *different* order's number.
   */
  it('never emits an ambiguous character', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateOrderNumber()).not.toMatch(/[OILU]/);
    }
  });

  it('does not repeat itself in any practical run', () => {
    const seen = new Set(Array.from({ length: 2000 }, generateOrderNumber));
    expect(seen.size).toBe(2000);
  });
});

describe('normaliseOrderNumber', () => {
  /**
   * The defect this exists for, found by reading a rendered confirmation page: an
   * unslashed zero in a humanist face is indistinguishable from a capital O, so a
   * customer types back a number that never existed.
   */
  it('folds a mistyped O onto the zero the generator actually emitted', () => {
    expect(normaliseOrderNumber('HAE-CJORTHPK')).toBe('HAE-CJ0RTHPK');
  });

  it('folds I and L onto 1', () => {
    expect(normaliseOrderNumber('HAE-IB2LM3N4')).toBe('HAE-1B21M3N4');
  });

  it.each([
    ['hae-cj0rthpk', 'lowercase'],
    ['HAE CJ0RTHPK', 'a space instead of the hyphen'],
    ['  HAE-CJ0RTHPK  ', 'surrounding whitespace'],
    ['HAECJ0RTHPK', 'no separator at all'],
    ['CJ0RTHPK', 'the body alone, as somebody would quote it'],
    ['HAE-CJ0R THPK', 'a space in the middle, as read down a phone'],
  ])('accepts %s (%s)', (input) => {
    expect(normaliseOrderNumber(input)).toBe('HAE-CJ0RTHPK');
  });

  it('is idempotent', () => {
    const once = normaliseOrderNumber('HAE-CJORTHPK');
    expect(normaliseOrderNumber(once)).toBe(once);
  });

  it('leaves a number that needs no folding alone', () => {
    const generated = generateOrderNumber();
    expect(normaliseOrderNumber(generated)).toBe(generated);
  });

  /**
   * Round-trip over real generated numbers: every one survives being written out,
   * misread in each ambiguous direction, and normalised back.
   */
  it('recovers every generated number from its misreadable spelling', () => {
    for (let i = 0; i < 500; i += 1) {
      const number = generateOrderNumber();
      const misread = number.replace(/0/g, 'O').replace(/1/g, 'l');
      expect(normaliseOrderNumber(misread)).toBe(number);
    }
  });
});

describe('isOrderNumber', () => {
  it('accepts a misread number, because the normaliser runs first', () => {
    expect(isOrderNumber('HAE-CJORTHPK')).toBe(true);
  });

  it.each(['', 'HAE-', 'HAE-SHORT', 'HAE-TOOLONGGGG', 'NOPE-CJ0RTHPK', 'HAE-CJ0RTHP!'])(
    'refuses %s',
    (value) => {
      expect(isOrderNumber(value)).toBe(false);
    },
  );
});
