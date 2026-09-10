/**
 * `npm run search:reindex [-- --force]`
 *
 * Rebuilds the whole search index from MongoDB and swaps it in atomically. Safe to run
 * against a live shop: readers keep seeing the current index until the swap, and the
 * previous index survives under the rebuild alias as a rollback.
 *
 * Reach for it when the index and the database have genuinely diverged — after a
 * restore, after a long Meilisearch outage, or when the hourly reconciliation keeps
 * warning about a drift that does not settle. Ordinary changes need none of this: they
 * arrive through the outbox.
 *
 * `--force` skips the guard that refuses a rebuild holding less than 90% of what is
 * currently live. That guard exists to catch a rebuild pointed at the wrong database,
 * so overriding it should be a decision, not a habit.
 */
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { connectRedis, disconnectRedis } from '../cache/redis.js';
import { connectMeili } from './meili.js';
import { logger } from '../lib/logger.js';
import { reindexAll } from './reindex.js';

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  await connectMongo();
  await connectRedis();
  await connectMeili();

  const result = await reindexAll({ force });

  if (!result.swapped) {
    logger.error({ result }, `search: reindex did not swap — ${result.reason ?? 'unknown reason'}`);
    process.exitCode = 1;
  } else {
    logger.info(
      { indexed: result.indexed, previous: result.previous },
      'search: reindex complete and swapped in',
    );
  }

  await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'search: reindex failed');
  process.exit(1);
});
