import mongoose from 'mongoose';
import { env, isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * MongoDB connection.
 *
 * Two departures from the 2022 version, which connected as an import side effect
 * inside an infinite `while (true)` retry loop with no way to fail:
 *
 *   1. Connecting is an explicit awaited call, so startup order is visible and a
 *      failure to connect is a failure to boot rather than a server that listens and
 *      500s every request.
 *   2. It gives up. Retrying forever in production hides an outage behind a healthy
 *      looking process; the orchestrator should restart us instead.
 */

let connected = false;

export async function connectMongo(): Promise<void> {
  if (connected) return;

  // Reject queries against paths not in the schema rather than silently dropping them.
  mongoose.set('strictQuery', true);
  if (!isProduction) mongoose.set('debug', env.LOG_LEVEL === 'trace');

  mongoose.connection.on('disconnected', () => logger.warn('mongo: disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo: reconnected'));
  mongoose.connection.on('error', (err: Error) => logger.error({ err }, 'mongo: connection error'));

  const maxAttempts = isProduction ? 5 : 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await mongoose.connect(env.MONGODB_URL, {
        serverSelectionTimeoutMS: 8000,
        maxPoolSize: 20,
        minPoolSize: 2,
        retryWrites: true,
      });
      connected = true;
      logger.info({ db: mongoose.connection.name }, 'mongo: connected');
      await assertReplicaSet();
      return;
    } catch (err) {
      const last = attempt === maxAttempts;
      logger.warn(
        { attempt, maxAttempts, err: (err as Error).message },
        last ? 'mongo: giving up' : 'mongo: connection failed, retrying in 2s',
      );
      if (last) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/**
 * Fails loudly if the server is a standalone mongod.
 *
 * Without a replica set there are no multi-document transactions and no change
 * streams, so checkout would silently degrade to a sequence of independent writes and
 * the search outbox would never drain. Discovering that at first checkout is far worse
 * than refusing to start. See docs/decisions/ADR-002.
 */
async function assertReplicaSet(): Promise<void> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('mongo: no admin interface available');

  const info = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
  if (!info.setName) {
    throw new Error(
      'mongo: connected to a standalone server, but this application requires a replica set ' +
        'for transactions and change streams.\n' +
        '  Local fix:  docker compose up -d  (mongod runs with --replSet rs0)\n' +
        '  Then check: MONGODB_URL includes ?replicaSet=rs0&directConnection=true\n' +
        '  Background: docs/decisions/ADR-002-mongodb-replica-set.md',
    );
  }
  logger.info({ replicaSet: info.setName }, 'mongo: replica set confirmed');
}

export async function disconnectMongo(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
  logger.info('mongo: disconnected cleanly');
}

export const mongoReady = (): boolean =>
  mongoose.connection.readyState === mongoose.ConnectionStates.connected;
