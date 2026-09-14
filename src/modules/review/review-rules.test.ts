import { describe, expect, it } from 'vitest';
import { reviewerName, summariseRatings } from './review-rules.js';

describe('summariseRatings', () => {
  it('is zero, not NaN, with nothing to summarise', () => {
    expect(summariseRatings([])).toEqual({
      average: 0,
      count: 0,
      distribution: [
        { rating: 5, count: 0 },
        { rating: 4, count: 0 },
        { rating: 3, count: 0 },
        { rating: 2, count: 0 },
        { rating: 1, count: 0 },
      ],
    });
  });

  it('divides once and rounds to two places', () => {
    const summary = summariseRatings([
      { rating: 5, count: 1 },
      { rating: 4, count: 2 },
    ]);
    expect(summary.average).toBe(4.33);
    expect(summary.count).toBe(3);
  });

  it('lists every star from five down, including the empty ones', () => {
    const summary = summariseRatings([{ rating: 2, count: 3 }]);
    expect(summary.distribution.map((row) => row.rating)).toEqual([5, 4, 3, 2, 1]);
    expect(summary.distribution.find((row) => row.rating === 2)?.count).toBe(3);
  });

  it('is exact where a running average would have drifted', () => {
    // Folding 1,000 alternating fives and fours into a re-rounded running figure lands
    // somewhere near 4.5; the grouped form is 4.5 exactly.
    const summary = summariseRatings([
      { rating: 5, count: 500 },
      { rating: 4, count: 500 },
    ]);
    expect(summary.average).toBe(4.5);
  });

  it('ignores a star the schema would never have stored', () => {
    const summary = summariseRatings([
      { rating: 5, count: 2 },
      { rating: 9, count: 40 },
      { rating: 0, count: 40 },
    ]);
    expect(summary).toMatchObject({ average: 5, count: 2 });
  });

  it('merges two rows for the same star', () => {
    expect(
      summariseRatings([
        { rating: 3, count: 1 },
        { rating: 3, count: 1 },
      ]).count,
    ).toBe(2);
  });
});

describe('reviewerName', () => {
  it('prints a first name and an initial, never the surname', () => {
    expect(reviewerName('Ada Lovelace')).toBe('Ada L.');
    expect(reviewerName('  María   José  García ')).toBe('María G.');
    expect(reviewerName('Jean-Luc Picard')).toBe('Jean-Luc P.');
  });

  it('keeps a single name as it is', () => {
    expect(reviewerName('Prince')).toBe('Prince');
  });

  it('upper-cases the initial only', () => {
    expect(reviewerName('bell hooks')).toBe('bell H.');
  });

  it('says "A customer" when there is no name to print', () => {
    expect(reviewerName(undefined)).toBe('A customer');
    expect(reviewerName(null)).toBe('A customer');
    expect(reviewerName('   ')).toBe('A customer');
  });

  it('does not split a character that is more than one code unit', () => {
    expect(reviewerName('Zoë 𝒜ndersen')).toBe('Zoë 𝒜.');
  });
});
