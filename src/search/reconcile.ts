import { logger } from '../lib/logger.js';
import { Product } from '../modules/catalog/product.model.js';
import { meili, PRODUCTS_INDEX } from './meili.js';
import { enqueueProduct } from './queue.js';
import { env } from '../config/env.js';

/**
 * The hourly check that the index still matches the database.
 *
 * The outbox plus the sweep make divergence very unlikely, and this exists because
 * "very unlikely" is not a monitoring strategy. Divergence is silent by nature — a
 * product missing from the index looks exactly like a product that does not exist — so
 * something has to go and look.
 *
 * It is deliberately cheap and deliberately not a repair-everything routine: it compares
 * counts, and it re-pushes anything modified since the last run. A real rebuild is
 * `npm run search:reindex`, which an operator runs knowingly, because a rebuild that
 * triggers itself at 3 a.m. on a bad count is how a small problem becomes an outage.
 */

const WATERMARK_KEY = 'search:reconcile:watermark';
const RECONCILE_INTERVAL_MS = 3_600_000;
/** Re-push a window slightly wider than the interval, so nothing falls between runs. */
const OVERLAP_MS = 300_000;
const MAX_REPUSH = 2_000;

let timer: NodeJS.Timeout | null = null;

export type ReconcileReport = {
  mongoCount: number;
  meiliCount: number;
  drift: number;
  repushed: number;
};

export async function reconcileOnce(): Promise<ReconcileReport> {
  const { redis } = await import('../cache/redis.js');

  const since = await redis.get(WATERMARK_KEY);
  const from = since ? new Date(Number(since) - OVERLAP_MS) : new Date(0);
  const now = Date.now();

  const [mongoCount, stats] = await Promise.all([
    Product.countDocuments({ status: 'active' }),
    meili.index(PRODUCTS_INDEX).getStats(),
  ]);
  const meiliCount = stats.numberOfDocuments;
  const drift = mongoCount - meiliCount;

  // Everything touched since the last run, re-pushed. This repairs the ordinary case —
  // a job that failed all its attempts while Meilisearch was down — without needing to
  // know which one it was.
  const changed = await Product.find({ updatedAt: { $gte: from } })
    .select('_id')
    .limit(MAX_REPUSH)
    .lean();

  for (const product of changed) {
    await enqueueProduct(String(product._id));
  }

  await redis.set(WATERMARK_KEY, String(now));

  const report = { mongoCount, meiliCount, drift, repushed: changed.length };

  if (drift !== 0) {
    // Warn rather than self-heal. A non-zero drift is nearly always explained by tasks
    // still settling inside Meilisearch, and a routine that reacted to it by rebuilding
    // would rebuild constantly under normal load.
    logger.warn(
      report,
      'search: index and database disagree on document count; run npm run search:reindex if it persists',
    );
  } else {
    logger.info(report, 'search: reconciliation clean');
  }

  return report;
}

export function startReconciliation(): void {
  if (!env.SEARCH_INDEXING_ENABLED || timer) return;
  timer = setInterval(() => {
    void reconcileOnce().catch((error: Error) =>
      logger.error({ err: error.message }, 'search: reconciliation failed'),
    );
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
  logger.info({ everyMs: RECONCILE_INTERVAL_MS }, 'search: reconciliation scheduled');
}

export function stopReconciliation(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
