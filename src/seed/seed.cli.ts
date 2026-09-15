/**
 * `npm run seed [-- --reset] [--orders=240] [--no-photos] [--no-reindex]`
 *
 * Builds the demo shop. See seed.ts for what it builds and docs/SEEDING.md for how to run it.
 *
 * - `--reset` replaces everything in the database. Without it, a database that already has
 *   a shop in it is refused, so the command cannot be run into someone's work by accident.
 * - `--orders=N` invents N orders on top of the few the demo depends on.
 * - `--no-photos` leaves the products unphotographed.
 * - `--no-reindex` skips the search rebuild; so does Meilisearch not answering. Either way
 *   the API's relay indexes the catalogue from the outbox when it next runs.
 */
import { connectRedis, disconnectRedis } from '../cache/redis.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { logger } from '../lib/logger.js';
import { connectMeili } from '../search/meili.js';
import { runSeed, SeedRefused } from './seed.js';

const flag = (name: string) => process.argv.includes(`--${name}`);
const value = (name: string) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<void> {
  await connectMongo();
  await connectRedis();

  let reindex = !flag('no-reindex');
  if (reindex) {
    await connectMeili().catch((err: Error) => {
      logger.warn(
        { err: err.message },
        'seed: Meilisearch is not answering, so the search index is not rebuilt. The API ' +
          'indexes the catalogue from the outbox when both are up.',
      );
      reindex = false;
    });
  }

  const orders = value('orders');
  const started = Date.now();
  const report = await runSeed({
    reset: flag('reset'),
    ...(orders ? { orders: Number(orders) } : {}),
    photos: !flag('no-photos'),
    reindex,
    allowProduction: flag('allow-production'),
  });

  logger.info(
    { ...report, seconds: Math.round((Date.now() - started) / 1000) },
    'seed: the shop is open',
  );
  if (report.downloads && report.downloads.owed > 0) {
    logger.warn(
      { owed: report.downloads.owed },
      'seed: some downloads are still owed to Unsplash — run `npm run seed:photos` within the hour',
    );
  }
}

main()
  .catch((err: unknown) => {
    if (err instanceof SeedRefused) {
      logger.error(err.message);
      process.exitCode = 2;
      return;
    }
    logger.fatal({ err }, 'seed: failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([disconnectMongo(), disconnectRedis()]);
    process.exit(process.exitCode ?? 0);
  });
