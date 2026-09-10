import { MeiliSearch } from 'meilisearch';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Meilisearch is the storefront read model: listing, filtering, sorting, faceting and
 * search all come from here, while Mongo keeps the product detail page, cart, checkout
 * and admin. See docs/decisions/ADR-003 for why this is not solvable with indexes.
 *
 * It is a derived store. Losing it entirely is recoverable with `npm run search:reindex`,
 * so nothing here is a source of truth.
 */

export const PRODUCTS_INDEX = 'products';
/** Reindexing builds here and then atomically swaps, so readers never see a half-built index. */
export const PRODUCTS_REBUILD_INDEX = 'products_rebuild';

export const meili = new MeiliSearch({
  host: env.MEILISEARCH_HOST,
  apiKey: env.MEILISEARCH_API_KEY,
});

let ready = false;

export async function connectMeili(): Promise<void> {
  const health = await meili.health();
  ready = health.status === 'available';
  if (!ready) throw new Error(`meilisearch: unhealthy (${health.status})`);
  logger.info({ host: env.MEILISEARCH_HOST }, 'meilisearch: connected');
}

export const meiliReady = (): boolean => ready;
