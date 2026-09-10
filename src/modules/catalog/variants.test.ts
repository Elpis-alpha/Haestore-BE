import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { buildSku, planVariantGrid, summariseVariants } from './variants.js';
import { attribute, attributeSet, options } from './test-fixtures.js';

const grind = () =>
  attribute('grind', 'select', {
    options: options(['whole', 'Whole bean'], ['filter', 'Filter'], ['espresso', 'Espresso']),
    isAxisEligible: true,
  });

const weight = () =>
  attribute('weight_g', 'number', {
    options: options(['250', '250 g'], ['1000', '1 kg']),
    isAxisEligible: true,
    unit: 'g',
  });

const story = () => attribute('story', 'text', { isAxisEligible: false });

describe('the product chooses its axes, the category only permits them', () => {
  it('generates the cartesian product of the values actually chosen', () => {
    // A product sold only as whole bean, in two sizes, gets two variants — not the six
    // the category's full option set would imply.
    const plan = planVariantGrid(
      [
        { key: 'grind', values: ['whole'] },
        { key: 'weight_g', values: ['250', '1000'] },
      ],
      'Yirgacheffe',
      attributeSet([grind(), weight()]),
    );

    expect(plan.count).toBe(2);
    expect(plan.variants.map((v) => v.sku)).toEqual([
      'YIRGACHEFFE-WHOLE-250',
      'YIRGACHEFFE-WHOLE-1000',
    ]);
  });

  it('produces a stable order, so regenerating does not reshuffle existing rows', () => {
    const set = attributeSet([grind(), weight()]);
    const axes = [
      { key: 'grind', values: ['whole', 'filter'] },
      { key: 'weight_g', values: ['250', '1000'] },
    ];
    const first = planVariantGrid(axes, 'X', set).variants.map((v) => v.sku);
    const again = planVariantGrid(axes, 'X', set).variants.map((v) => v.sku);

    expect(again).toEqual(first);
    expect(first).toEqual(['X-WHOLE-250', 'X-WHOLE-1000', 'X-FILTER-250', 'X-FILTER-1000']);
  });
});

describe('an axis has to have a finite set of values', () => {
  it('refuses a free-text attribute as an axis', () => {
    expect(() =>
      planVariantGrid([{ key: 'story', values: ['anything'] }], 'X', attributeSet([story()])),
    ).toThrowError(/cannot be a variant axis/);
  });

  it('refuses an attribute the category does not bind at all', () => {
    expect(() =>
      planVariantGrid([{ key: 'colour', values: ['red'] }], 'X', attributeSet([grind()])),
    ).toThrowError(/not an attribute of this category/);
  });

  it('refuses a value the attribute does not offer', () => {
    expect(() =>
      planVariantGrid([{ key: 'grind', values: ['turkish'] }], 'X', attributeSet([grind()])),
    ).toThrowError(/does not offer: turkish/);
  });

  it('refuses the same axis twice', () => {
    expect(() =>
      planVariantGrid(
        [
          { key: 'grind', values: ['whole'] },
          { key: 'grind', values: ['filter'] },
        ],
        'X',
        attributeSet([grind()]),
      ),
    ).toThrowError(/listed twice/);
  });

  it('refuses an axis with no values chosen', () => {
    expect(() =>
      planVariantGrid([{ key: 'grind', values: [] }], 'X', attributeSet([grind()])),
    ).toThrowError(/no values were chosen/);
  });
});

describe('the grid is bounded', () => {
  const many = (n: number) =>
    attribute(`axis_${n}`, 'select', {
      options: options(
        ...Array.from({ length: n }, (_, i) => [`v${i}`, `V${i}`] as [string, string]),
      ),
      isAxisEligible: true,
    });

  it('warns before the count becomes unmanageable', () => {
    const set = attributeSet([many(5), { ...many(5), key: 'axis_b', label: 'Axis b' }]);
    const plan = planVariantGrid(
      [
        { key: 'axis_5', values: ['v0', 'v1', 'v2', 'v3', 'v4'] },
        { key: 'axis_b', values: ['v0', 'v1', 'v2', 'v3', 'v4'] },
      ],
      'X',
      set,
    );
    expect(plan.count).toBe(25);
    expect(plan.warn).toBe(true);
  });

  it('hard-blocks past the limit, and says the number before creating anything', () => {
    const set = attributeSet([many(11), { ...many(11), key: 'axis_b', label: 'Axis b' }]);
    const values = Array.from({ length: 11 }, (_, i) => `v${i}`);
    try {
      planVariantGrid(
        [
          { key: 'axis_11', values },
          { key: 'axis_b', values },
        ],
        'X',
        set,
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details).toEqual({ count: 121, limit: 100 });
    }
  });
});

describe('the denormalised listing fields', () => {
  const variant = (amount: number, available = 5, status: 'active' | 'inactive' = 'active') => ({
    price: { amount, currency: 'USD' },
    status,
    stock: { available },
  });

  it('spans only the active variants', () => {
    // An inactive $2 variant must not drag the card's "from" price to something the
    // customer cannot buy.
    const { priceRange } = summariseVariants([
      variant(1800),
      variant(3200),
      variant(200, 5, 'inactive'),
    ]);
    expect(priceRange).toEqual({ min: 1800, max: 3200, currency: 'USD' });
  });

  it('reports out of stock when every active variant is empty', () => {
    expect(summariseVariants([variant(1800, 0), variant(3200, 0)]).inStock).toBe(false);
    expect(summariseVariants([variant(1800, 0), variant(3200, 1)]).inStock).toBe(true);
  });

  it('counts a backorderable variant as available', () => {
    const backorder = { ...variant(1800, 0), stock: { available: 0, backorderable: true } };
    expect(summariseVariants([backorder]).inStock).toBe(true);
  });

  it('has no range at all when nothing is active', () => {
    expect(summariseVariants([variant(1800, 5, 'inactive')])).toEqual({
      priceRange: null,
      inStock: false,
    });
  });

  it('refuses to summarise variants priced in different currencies', () => {
    expect(() =>
      summariseVariants([
        variant(1800),
        { ...variant(1800), price: { amount: 1800, currency: 'EUR' } },
      ]),
    ).toThrowError(/same currency/);
  });
});

describe('SKUs', () => {
  it('are readable, deterministic and safe for a shelf label', () => {
    expect(buildSku('Ethiopia, Yirgacheffe', [{ key: 'grind', value: 'whole' }])).toBe(
      'ETHIOPIA-YIRGACHEFFE-WHOLE',
    );
  });

  it('survive accents and punctuation', () => {
    expect(buildSku('Café Crème', [{ key: 'size', value: 'grande' }])).toBe('CAFE-CREME-GRANDE');
  });

  it('truncate a long title rather than producing an unreadable SKU', () => {
    // 24 characters of title, so a shelf label stays scannable — and the cut must not
    // leave a dangling hyphen where a word boundary happened to fall.
    expect(buildSku('Single Origin Ethiopian Yirgacheffe Reserve', [])).toBe(
      'SINGLE-ORIGIN-ETHIOPIAN',
    );
    expect(buildSku('Coffee', [{ key: 'g', value: 'extra-coarse-ground' }])).toBe(
      'COFFEE-EXTRA-COARSE',
    );
  });
});
