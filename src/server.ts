import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { connectRedis, disconnectRedis } from './cache/redis.js';
import { connectMeili } from './search/meili.js';
import { ensureProductsIndex, handleSearchJob } from './search/indexer.js';
import { startSearchWorker, stopSearchWorker, enqueueSettingsSync } from './search/queue.js';
import { startOutboxRelay, stopOutboxRelay } from './search/relay.js';
import { startReconciliation, stopReconciliation } from './search/reconcile.js';

async function main(): Promise<void> {
  // Connect before listening, so the process never accepts traffic it cannot serve.
  await connectMongo();
  await connectRedis();
  const searchUp = await connectMeili()
    .then(() => true)
    .catch((err: Error) => {
      // Search is a derived store: the catalogue is still readable from Mongo without
      // it, so a cold Meilisearch degrades the shop rather than preventing boot.
      logger.warn({ err: err.message }, 'meilisearch: unavailable at startup, continuing degraded');
      return false;
    });

  if (searchUp) {
    // The index and its derived settings are established on every boot rather than by a
    // migration someone has to remember. Both are idempotent: Meilisearch does nothing
    // when the submitted settings already match, which is why buildSearchSettings emits
    // a stable ordering.
    await ensureProductsIndex().catch((err: Error) =>
      logger.error({ err: err.message }, 'search: could not ensure the index exists'),
    );
    await enqueueSettingsSync({ immediate: true }).catch((err: Error) =>
      logger.error({ err: err.message }, 'search: could not enqueue the boot settings sync'),
    );
  }

  // These start regardless of whether Meilisearch answered just now. The outbox keeps
  // accumulating while search is down, and the relay plus the queue's retries are what
  // drain it when search comes back — refusing to start them would turn a brief search
  // outage into a permanently stale index.
  startSearchWorker(handleSearchJob);
  await startOutboxRelay().catch((err: Error) =>
    logger.error({ err: err.message }, 'search: outbox relay failed to start'),
  );
  startReconciliation();

  const server = createServer(createApp());

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, `Hæstore API listening on :${env.PORT}`);
  });

  // Graceful shutdown, which the 2022 app had none of: stop accepting connections,
  // let in-flight requests finish, then close the stores. Without this, a deploy can
  // interrupt a checkout mid-transaction.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'shutting down');

      const forced = setTimeout(() => {
        logger.error('shutdown timed out after 10s, forcing exit');
        process.exit(1);
      }, 10_000);
      forced.unref();

      // Stop accepting new connections, then wait for in-flight requests to finish.
      // closeIdleConnections releases keep-alive sockets that would otherwise hold
      // close() open for the full timeout.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      // Search first: the relay holds a change stream and the worker holds jobs, and
      // both need Mongo and Redis alive to shut down cleanly.
      stopReconciliation();
      await Promise.allSettled([stopOutboxRelay(), stopSearchWorker()]);
      await Promise.allSettled([disconnectMongo(), disconnectRedis()]);

      clearTimeout(forced);
      logger.info('shutdown complete');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception, exiting');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
