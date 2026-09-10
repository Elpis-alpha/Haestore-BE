import { logger } from '../lib/logger.js';
import { meili, PRODUCTS_INDEX } from './meili.js';

/**
 * What the index can answer *right now*.
 *
 * The catalogue and the index settings are deliberately not in lockstep. Defining a
 * filterable attribute writes to MongoDB immediately, but the matching
 * `filterableAttributes` change is debounced by 30 seconds — because `updateSettings`
 * triggers a partial re-index and six admin saves must produce one task, not six
 * (ADR-003).
 *
 * That gap has a consequence which is easy to miss and severe when it happens. The
 * filter panel is generated from the category's effective attributes, so the moment an
 * attribute is defined the listing starts asking Meilisearch to facet on `attr.<key>` —
 * and Meilisearch answers `attribute attr.<key> is not filterable`, which is a 400 for
 * the **whole request**. Not a missing facet: a failed listing, which then falls back to
 * MongoDB, which has no facets at all. One new attribute takes the entire filter panel
 * down for every shopper in that category until the debounce elapses.
 *
 * This was observed against a running server, not reasoned about in advance.
 *
 * So the listing asks the index what it currently knows and requests only that. An
 * attribute that has been defined but not yet synced simply has no facet for a few
 * seconds, which nobody notices, instead of destroying the panel, which everybody does.
 */

/** Short enough that a synced attribute appears promptly; long enough to not be a per-request fetch. */
const TTL_MS = 10_000;

let cached: { at: number; fields: Set<string> } | null = null;

export async function filterableFields(): Promise<Set<string> | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.fields;

  try {
    const fields = await meili.index(PRODUCTS_INDEX).getFilterableAttributes();
    // Meilisearch 1.12+ can return rule objects rather than plain strings; only the
    // plain form is used here, and anything else is ignored rather than guessed at.
    const names = new Set(fields.filter((f): f is string => typeof f === 'string'));
    cached = { at: Date.now(), fields: names };
    return names;
  } catch (error) {
    // Null means "unknown", and every caller treats unknown as permissive: the search
    // itself is about to fail and degrade anyway, and guessing an empty set here would
    // strip the panel for a reason unrelated to what actually went wrong.
    logger.warn(
      { err: (error as Error).message },
      'search: could not read the index settings; not restricting facets',
    );
    return null;
  }
}

/** Called after a settings sync, so the next request sees the new attribute at once. */
export function forgetFilterableFields(): void {
  cached = null;
}
