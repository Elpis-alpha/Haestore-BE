import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { connectRedis, disconnectRedis } from './cache/redis.js';
import { connectMeili } from './search/meili.js';

async function main(): Promise<void> {
  // Connect before listening, so the process never accepts traffic it cannot serve.
  await connectMongo();
  await connectRedis();
  await connectMeili().catch((err: Error) => {
    // Search is a derived store: the catalogue is still readable from Mongo without
    // it, so a cold Meilisearch degrades the shop rather than preventing boot.
    logger.warn({ err: err.message }, 'meilisearch: unavailable at startup, continuing degraded');
  });

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
