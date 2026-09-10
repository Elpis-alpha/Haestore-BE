import { describe, expect, it } from 'vitest';
import {
  BASE_FILTERABLE,
  buildSearchSettings,
  SORTABLE,
  type DefinitionForSettings,
} from './settings.js';

/**
 * The derivation that makes admin-defined attributes reach a search server which
 * insists its filterable fields are declared in advance.
 */

const def = (over: Partial<DefinitionForSettings> = {}): DefinitionForSettings => ({
  key: 'roast',
  type: 'select',
  isFilterable: true,
  isSearchable: false,
  ...over,
});

describe('buildSearchSettings', () => {
  it('derives a filterable field from every filterable definition', () => {
    const settings = buildSearchSettings([def(), def({ key: 'glaze' })]);
    expect(settings.filterableAttributes).toContain('attr.roast');
    expect(settings.filterableAttributes).toContain('attr.glaze');
  });

  it('always declares the fields a listing needs regardless of the catalogue', () => {
    const settings = buildSearchSettings([]);
    for (const field of BASE_FILTERABLE) {
      expect(settings.filterableAttributes).toContain(field);
    }
    expect(settings.sortableAttributes).toEqual([...SORTABLE]);
  });

  it('omits a definition the admin did not mark filterable', () => {
    const settings = buildSearchSettings([def({ key: 'buyer_note', isFilterable: false })]);
    expect(settings.filterableAttributes).not.toContain('attr.buyer_note');
  });

  it('omits a type that cannot back a filter, whatever the admin asked for', () => {
    const settings = buildSearchSettings([
      def({ key: 'care', type: 'text' }),
      def({ key: 'size', type: 'dimension' }),
    ]);
    expect(settings.filterableAttributes).not.toContain('attr.care');
    expect(settings.filterableAttributes).not.toContain('attr.size');
  });

  it('accepts every type that can', () => {
    const settings = buildSearchSettings([
      def({ key: 'a', type: 'select' }),
      def({ key: 'b', type: 'multiselect' }),
      def({ key: 'c', type: 'color' }),
      def({ key: 'd', type: 'number' }),
      def({ key: 'e', type: 'boolean' }),
    ]);
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      expect(settings.filterableAttributes).toContain(`attr.${key}`);
    }
  });

  /**
   * `updateSettings` triggers a partial re-index, and Meilisearch compares the submitted
   * settings against the current ones to decide whether anything changed. An unstable
   * ordering would therefore make every sync look like a change and re-index the corpus
   * on a schedule.
   */
  it('emits a stable ordering, so an unchanged catalogue produces an unchanged payload', () => {
    const a = buildSearchSettings([def({ key: 'zebra' }), def({ key: 'apple' })]);
    const b = buildSearchSettings([def({ key: 'apple' }), def({ key: 'zebra' })]);
    expect(a).toEqual(b);
    expect(a.filterableAttributes).toEqual([...(a.filterableAttributes ?? [])].sort());
  });

  it('bounds pagination depth, which the MongoDB fallback also honours', () => {
    expect(buildSearchSettings([]).pagination).toEqual({ maxTotalHits: 1000 });
  });

  it('does not put internal fields in the displayed projection', () => {
    const displayed = buildSearchSettings([]).displayedAttributes ?? [];
    // The index is a listing projection, never a second copy of the catalogue.
    expect(displayed).not.toContain('validationIssues');
    expect(displayed).not.toContain('needsAttention');
    expect(displayed).not.toContain('variants');
    expect(displayed).toContain('attr');
  });
});
