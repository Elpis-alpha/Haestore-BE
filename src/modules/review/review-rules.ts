/**
 * The arithmetic and the wording of reviews, kept pure so both can be tested without a
 * database.
 *
 * Two things live here because getting either wrong produces a page that looks right: an
 * average that drifts from the reviews it claims to summarise, and a byline that shows
 * more of a person than they chose to publish.
 */

export const RATINGS = [1, 2, 3, 4, 5] as const;
export type Rating = (typeof RATINGS)[number];

export const REVIEW_TITLE_MAX = 120;
export const REVIEW_BODY_MAX = 4000;

export type RatingSummary = {
  /** Two decimal places, and 0 when there are no reviews rather than NaN. */
  average: number;
  count: number;
  /** Every star from five down to one, including the ones nobody gave. */
  distribution: { rating: Rating; count: number }[];
};

/**
 * Summarises ratings from per-star counts.
 *
 * **Counts, not a running average.** The obvious way to maintain `ratingAverage` is to
 * fold each new review into the stored figure — `(avg × n + r) / (n + 1)` — which is
 * cheap and wrong in two ways that never announce themselves: every fold re-rounds, so the
 * figure drifts from the reviews it describes, and a hidden or deleted review has to be
 * folded back out of a number that no longer remembers it. Grouping the published
 * reviews by star and dividing once is exact, and it is bounded by one product's reviews.
 *
 * The division happens on the integer sum scaled by 100, so the rounding is of a single
 * quotient rather than of a float that has already been multiplied.
 */
export function summariseRatings(
  counts: ReadonlyArray<{ rating: number; count: number }>,
): RatingSummary {
  const byStar = new Map<Rating, number>(RATINGS.map((r) => [r, 0]));
  for (const row of counts) {
    // The schema refuses anything else; this keeps a corrupt row from bending the average.
    if (!RATINGS.includes(row.rating as Rating) || row.count <= 0) continue;
    byStar.set(row.rating as Rating, (byStar.get(row.rating as Rating) ?? 0) + row.count);
  }

  let count = 0;
  let sum = 0;
  for (const [rating, n] of byStar) {
    count += n;
    sum += rating * n;
  }

  return {
    average: count === 0 ? 0 : Math.round((sum * 100) / count) / 100,
    count,
    distribution: [...RATINGS].reverse().map((rating) => ({ rating, count: byStar.get(rating)! })),
  };
}

/**
 * The byline on a published review: a first name and an initial.
 *
 * Never the email address, and never the whole name. A review is public and permanent in
 * a way an account name is not — somebody who typed "Ada Lovelace" into the account page
 * to have their parcels addressed properly did not thereby agree to have their surname
 * printed beside an opinion about a teapot. "Ada L." is enough to read as a person.
 *
 * An account with no name reads "A customer", which is true and says nothing more.
 */
export function reviewerName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return 'A customer';

  const given = Array.from(first).slice(0, 40).join('');
  if (parts.length === 1) return given;

  const initial = Array.from(parts[parts.length - 1]!)[0]!.toLocaleUpperCase();
  return `${given} ${initial}.`;
}
