import { describe, expect, it } from 'vitest';
import type { FilterGroup } from './filter-expression.js';
import {
  mergeFacetDistributions,
  mergeFacetStats,
  planFacetQueries,
  presentFacets,
} from './facets.js';

const group = (
  key: string,
  expression: string,
  facet: string | null = `attr.${key}`,
): FilterGroup => ({
  key,
  facet,
  expression,
});

const status = group('status', 'status = "active"', null);

describe('planFacetQueries', () => {
  it('costs exactly one query when nothing is selected', () => {
    const plan = planFacetQueries({
      base: [status],
      selected: [],
      facets: ['attr.roast', 'attr.weight_g'],
    });
    expect(plan.disjunctive).toHaveLength(0);
    expect(plan.mainFilter).toBe('(status = "active")');
  });

  it('adds one query per selected group, each without its own filter', () => {
    const roast = group('roast', 'attr.roast IN ["dark"]');
    const weight = group('weight_g', 'attr.weight_g >= 250');

    const plan = planFacetQueries({
      base: [status],
      selected: [roast, weight],
      facets: ['attr.roast', 'attr.weight_g'],
    });

    expect(plan.mainFilter).toBe(
      '(status = "active") AND (attr.roast IN ["dark"]) AND (attr.weight_g >= 250)',
    );
    expect(plan.disjunctive).toEqual([
      // roast's own filter is gone; weight's is kept.
      { facet: 'attr.roast', filter: '(status = "active") AND (attr.weight_g >= 250)' },
      { facet: 'attr.weight_g', filter: '(status = "active") AND (attr.roast IN ["dark"])' },
    ]);
  });

  it('keeps the base filters in every corrected query, so counts stay in this category', () => {
    const category = group('category', 'categoryAncestors = "abc"', null);
    const plan = planFacetQueries({
      base: [status, category],
      selected: [group('roast', 'attr.roast IN ["dark"]')],
      facets: ['attr.roast'],
    });
    expect(plan.disjunctive[0]?.filter).toBe('(status = "active") AND (categoryAncestors = "abc")');
  });

  it('does not correct a facet the panel is not asking for', () => {
    const plan = planFacetQueries({
      base: [status],
      selected: [group('roast', 'attr.roast IN ["dark"]')],
      facets: ['attr.weight_g'],
    });
    expect(plan.disjunctive).toHaveLength(0);
  });

  it('does not correct a selected group that owns no facet', () => {
    const plan = planFacetQueries({
      base: [status],
      selected: [group('in_stock', 'inStock = true', null)],
      facets: ['attr.roast'],
    });
    expect(plan.disjunctive).toHaveLength(0);
  });
});

describe('mergeFacetDistributions', () => {
  it('replaces a collapsed facet wholesale rather than merging into it', () => {
    const merged = mergeFacetDistributions(
      // What the main query returned: roast collapsed to the one selected value.
      { 'attr.roast': { dark: 3 }, 'attr.weight_g': { '250': 3 } },
      [{ facet: 'attr.roast', distribution: { 'attr.roast': { light: 5, medium: 4, dark: 3 } } }],
    );
    expect(merged['attr.roast']).toEqual({ light: 5, medium: 4, dark: 3 });
    expect(merged['attr.weight_g']).toEqual({ '250': 3 });
  });

  it('leaves the main distribution alone when a correction came back empty', () => {
    const merged = mergeFacetDistributions({ 'attr.roast': { dark: 3 } }, [
      { facet: 'attr.roast', distribution: undefined },
    ]);
    expect(merged['attr.roast']).toEqual({ dark: 3 });
  });

  it('copes with a main response that carried no facets at all', () => {
    expect(mergeFacetDistributions(undefined, [])).toEqual({});
  });
});

describe('mergeFacetStats', () => {
  it('restores the full bounds so a slider can be widened again', () => {
    const merged = mergeFacetStats({ priceMin: { min: 2000, max: 2500 } }, [
      { facet: 'priceMin', stats: { priceMin: { min: 500, max: 9000 } } },
    ]);
    expect(merged.priceMin).toEqual({ min: 500, max: 9000 });
  });
});

describe('presentFacets', () => {
  const roast = {
    key: 'roast',
    label: 'Roast',
    type: 'select',
    filterUi: 'checkbox',
    options: [
      { value: 'light', label: 'Light', order: 0 },
      { value: 'medium', label: 'Medium', order: 1 },
      { value: 'dark', label: 'Dark', order: 2 },
    ],
  };

  it('emits a declared value the distribution omits as zero, not as missing', () => {
    const [panel] = presentFacets({
      distribution: { 'attr.roast': { dark: 3 } },
      stats: {},
      attributes: [roast],
      selected: { roast: ['dark'] },
    });

    expect(panel?.values).toEqual([
      { value: 'light', label: 'Light', count: 0, selected: false },
      { value: 'medium', label: 'Medium', count: 0, selected: false },
      { value: 'dark', label: 'Dark', count: 3, selected: true },
    ]);
  });

  it('renders a range attribute as bounds rather than values', () => {
    const [panel] = presentFacets({
      distribution: {},
      stats: { 'attr.weight_g': { min: 250, max: 1000 } },
      attributes: [
        {
          key: 'weight_g',
          label: 'Weight',
          type: 'number',
          filterUi: 'range',
          unit: 'g',
          options: [],
        },
      ],
      selected: {},
    });
    expect(panel?.range).toEqual({ min: 250, max: 1000 });
    expect(panel?.values).toEqual([]);
    expect(panel?.unit).toBe('g');
  });

  it('falls back to the distribution for an attribute with no declared options', () => {
    const [panel] = presentFacets({
      distribution: { 'attr.dishwasher_safe': { true: 4, false: 1 } },
      stats: {},
      attributes: [
        {
          key: 'dishwasher_safe',
          label: 'Dishwasher safe',
          type: 'boolean',
          filterUi: 'toggle',
          options: [],
        },
      ],
      selected: {},
    });
    expect(panel?.values.map((v) => v.value)).toEqual(['false', 'true']);
  });
});
