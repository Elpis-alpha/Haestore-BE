import { describe, expect, it } from 'vitest';
import type { EffectiveAttribute } from '../modules/catalog/effective-attributes.js';
import {
  baseFilters,
  buildAttributeFilters,
  combineFilters,
  escapeFilterValue,
  MAX_SELECTED_GROUPS,
  parsePriceRange,
  quoteFilterValue,
} from './filter-expression.js';

/**
 * The filter builder is the trust boundary between a URL a stranger typed and a query
 * language the search server executes, so these tests are mostly about what does *not*
 * come out of it.
 */

const attribute = (over: Partial<EffectiveAttribute> = {}): EffectiveAttribute => ({
  key: 'roast',
  defId: 'def1',
  label: 'Roast',
  type: 'select',
  options: [
    { value: 'light', label: 'Light', order: 0 },
    { value: 'medium', label: 'Medium', order: 1 },
    { value: 'dark', label: 'Dark', order: 2 },
  ],
  isFilterable: true,
  isSearchable: false,
  isAxisEligible: true,
  filterUi: 'checkbox',
  validation: {},
  required: false,
  order: 0,
  inheritedFrom: null,
  ...over,
});

describe('escapeFilterValue', () => {
  it('escapes backslashes before quotes, so its own escapes are not re-escaped', () => {
    expect(escapeFilterValue('a\\b')).toBe('a\\\\b');
    expect(escapeFilterValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeFilterValue('c:\\path "x"')).toBe('c:\\\\path \\"x\\"');
  });

  it('leaves an apostrophe alone — the literal is double-quoted', () => {
    expect(quoteFilterValue("o'brien")).toBe('"o\'brien"');
  });
});

describe('buildAttributeFilters — the injection this exists to stop', () => {
  /**
   * Verified against a real Meilisearch before this code was written: interpolating
   * `celadon" OR status = "draft` unescaped returns the drafts, and escaping it returns
   * nothing. The value never gets that far here — it is not an option — but both gates
   * are asserted so removing either one fails a test.
   */
  const hostile = 'celadon" OR status = "draft';

  it('drops a hostile value outright, because it is not one of the options', () => {
    const result = buildAttributeFilters({ roast: hostile }, [attribute()]);
    expect(result.groups).toHaveLength(0);
    expect(result.ignored[0]?.key).toBe('roast');
  });

  it('escapes a hostile value that IS an option, so it cannot close the literal', () => {
    const withHostileOption = attribute({
      options: [{ value: hostile, label: 'Odd', order: 0 }],
    });
    const result = buildAttributeFilters({ roast: hostile }, [withHostileOption]);

    expect(result.groups[0]?.expression).toBe('attr.roast IN ["celadon\\" OR status = \\"draft"]');
    // The telling part: the escaped form contains no unescaped quote that could end
    // the literal early, so `status` never appears as a bare field.
    expect(result.groups[0]?.expression).not.toMatch(/[^\\]" OR status/);
  });
});

describe('buildAttributeFilters — what reaches the DSL', () => {
  it('accepts known option values and quotes them', () => {
    const result = buildAttributeFilters({ roast: 'medium,dark' }, [attribute()]);
    expect(result.groups).toEqual([
      { key: 'roast', facet: 'attr.roast', expression: 'attr.roast IN ["medium", "dark"]' },
    ]);
  });

  it('treats repeated params and a comma list identically', () => {
    const a = buildAttributeFilters({ roast: ['medium', 'dark'] }, [attribute()]);
    const b = buildAttributeFilters({ roast: 'medium,dark' }, [attribute()]);
    expect(a.groups).toEqual(b.groups);
  });

  it('keeps only the recognised values out of a mixed list', () => {
    const result = buildAttributeFilters({ roast: 'medium,chartreuse' }, [attribute()]);
    expect(result.groups[0]?.expression).toBe('attr.roast IN ["medium"]');
  });

  it('ignores an attribute this category does not bind, and says so', () => {
    const result = buildAttributeFilters({ glaze: 'celadon' }, [attribute()]);
    expect(result.groups).toHaveLength(0);
    expect(result.ignored).toEqual([
      { key: 'glaze', reason: 'This category does not use that attribute.' },
    ]);
  });

  it('ignores a bound attribute whose type cannot back a filter', () => {
    const text = attribute({ key: 'care', type: 'text', options: [] });
    const result = buildAttributeFilters({ care: 'hand wash' }, [text]);
    expect(result.groups).toHaveLength(0);
    expect(result.ignored[0]?.reason).toBe('That attribute is not filterable.');
  });

  it('ignores an attribute the admin marked unfilterable', () => {
    const result = buildAttributeFilters({ roast: 'dark' }, [attribute({ isFilterable: false })]);
    expect(result.groups).toHaveLength(0);
  });

  it('caps the number of groups', () => {
    const many = Array.from({ length: MAX_SELECTED_GROUPS + 5 }, (_, i) =>
      attribute({ key: `a${i}`, options: [{ value: 'x', label: 'X', order: 0 }] }),
    );
    const params = Object.fromEntries(many.map((a) => [a.key, 'x']));
    expect(buildAttributeFilters(params, many).groups).toHaveLength(MAX_SELECTED_GROUPS);
  });
});

describe('buildAttributeFilters — numbers', () => {
  const range = attribute({
    key: 'weight_g',
    type: 'number',
    filterUi: 'range',
    options: [],
    validation: { min: 100, max: 2000 },
  });

  it('builds a range with both bounds', () => {
    const result = buildAttributeFilters({ weight_g: '250-1000' }, [range]);
    expect(result.groups[0]?.expression).toBe('attr.weight_g >= 250 AND attr.weight_g <= 1000');
  });

  it('accepts an open-ended range', () => {
    expect(buildAttributeFilters({ weight_g: '500-' }, [range]).groups[0]?.expression).toBe(
      'attr.weight_g >= 500',
    );
    expect(buildAttributeFilters({ weight_g: '-500' }, [range]).groups[0]?.expression).toBe(
      'attr.weight_g <= 500',
    );
  });

  it('clamps to the definition, so a hand-edited URL cannot widen the range', () => {
    const result = buildAttributeFilters({ weight_g: '0-99999' }, [range]);
    expect(result.groups[0]?.expression).toBe('attr.weight_g >= 100 AND attr.weight_g <= 2000');
  });

  it('corrects swapped bounds rather than returning nothing', () => {
    expect(buildAttributeFilters({ weight_g: '1000-250' }, [range]).groups[0]?.expression).toBe(
      'attr.weight_g >= 250 AND attr.weight_g <= 1000',
    );
  });

  it('never interpolates a non-number', () => {
    const result = buildAttributeFilters({ weight_g: '1 OR 1=1' }, [range]);
    expect(result.groups).toHaveLength(0);
    expect(result.ignored[0]?.reason).toBe('That is not a valid range.');
  });

  it('filters an enumerated number by membership, not by range', () => {
    const enumerated = attribute({
      key: 'weight_g',
      type: 'number',
      filterUi: 'checkbox',
      options: [
        { value: '250', label: '250 g', order: 0 },
        { value: '1000', label: '1 kg', order: 1 },
      ],
    });
    expect(
      buildAttributeFilters({ weight_g: '250,1000' }, [enumerated]).groups[0]?.expression,
    ).toBe('attr.weight_g IN [250, 1000]');
  });
});

describe('buildAttributeFilters — booleans', () => {
  const flag = attribute({
    key: 'dishwasher_safe',
    type: 'boolean',
    filterUi: 'toggle',
    options: [],
  });

  it('accepts true and false unquoted', () => {
    expect(buildAttributeFilters({ dishwasher_safe: 'true' }, [flag]).groups[0]?.expression).toBe(
      'attr.dishwasher_safe = true',
    );
  });

  it('refuses anything else', () => {
    expect(buildAttributeFilters({ dishwasher_safe: 'yes' }, [flag]).groups).toHaveLength(0);
  });
});

describe('baseFilters', () => {
  it('always constrains status, and does not take it from the caller', () => {
    expect(baseFilters({}).map((g) => g.expression)).toEqual(['status = "active"']);
  });

  it('filters a whole branch through the materialised ancestry', () => {
    const groups = baseFilters({ categoryId: '507f1f77bcf86cd799439011' });
    expect(groups[1]?.expression).toBe('categoryAncestors = "507f1f77bcf86cd799439011"');
  });

  it('refuses a category that is not an id, rather than interpolating it', () => {
    expect(() => baseFilters({ categoryId: 'x" OR status = "draft' })).toThrow(/non-id category/);
  });

  it('treats a price filter as an overlap, so multi-variant products are not hidden', () => {
    const groups = baseFilters({ price: { min: 2000, max: 2500 } });
    expect(groups.at(-1)?.expression).toBe('priceMin <= 2500 AND priceMax >= 2000');
  });
});

describe('combineFilters', () => {
  it('parenthesises each group and ANDs them', () => {
    expect(
      combineFilters([
        { key: 'status', facet: null, expression: 'status = "active"' },
        { key: 'roast', facet: 'attr.roast', expression: 'attr.roast IN ["dark"]' },
      ]),
    ).toBe('(status = "active") AND (attr.roast IN ["dark"])');
  });

  it('produces an empty string rather than stray parentheses', () => {
    expect(combineFilters([])).toBe('');
    expect(combineFilters([{ key: 'x', facet: null, expression: '' }])).toBe('');
  });
});

describe('parsePriceRange', () => {
  it('floors to integer minor units and refuses negatives', () => {
    expect(parsePriceRange('1500-4000')).toEqual({ min: 1500, max: 4000 });
    expect(parsePriceRange('-500')).toEqual({ max: 500 });
    expect(parsePriceRange('abc')).toBeNull();
    expect(parsePriceRange(undefined)).toBeNull();
  });
});
