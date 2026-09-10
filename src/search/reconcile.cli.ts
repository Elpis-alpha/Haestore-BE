/**
 * `npm run search:reconcile`
 *
 * Runs one reconciliation pass by hand: compares the document counts MongoDB and
 * Meilisearch each believe in, and re-pushes everything modified since the last pass.
 *
 * The API runs this hourly on its own. Running it manually is for answering "is the
 * index actually current?" without waiting for the next tick, and for seeing the drift
 * figure before deciding whether a full `search:reindex` is warranted.
 */
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { connectRedis, disconnectRedis } from '../cache/redis.js';
import { connectMeili } from './meili.js';
import { logger } from '../lib/logger.js';
import { reconcileOnce } from './reconcile.js';
import { stopSearchWorker } from './queue.js';

async function main(): Promise<void> {
  await connectMongo();
  await connectRedis();
  await connectMeili();

  const report = await reconcileOnce();

  // A drift is not a failure to exit non-zero over — tasks still settling inside
  // Meilisearch produce one routinely — but it is worth being visible in a CI log.
  logger.info(report, report.drift === 0 ? 'search: in sync' : 'search: drift detected');

  await stopSearchWorker();
  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'search: reconciliation failed');
  process.exit(1);
});
