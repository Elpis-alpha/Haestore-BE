import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * A real MongoDB replica set, in process, for the integration suite.
 *
 * A replica set rather than a standalone because this design needs transactions and
 * change streams, and a standalone `mongod` has neither. Testing against a standalone
 * would pass locally and then fail on the first `withTransaction` in production, which
 * is the failure this whole arrangement exists to prevent.
 *
 * The env has to be set before anything imports config/env.ts, which parses
 * process.env at module load. Vitest runs setup files before the test module graph, so
 * this is the one place it can happen.
 */

process.env.NODE_ENV = 'test';
process.env.OTP_PEPPER ??= 'integration_pepper_long_enough_for_the_schema_check';
process.env.GUEST_COOKIE_SECRET ??= 'integration_guest_secret_long_enough_for_schema';
process.env.ALLOWED_ORIGINS ??= 'http://localhost:3000';
// Database 15, so a run can never disturb the development cache on database 0.
process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:6380/15';

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  process.env.MONGODB_URL = replSet.getUri('haestore_test');
  await mongoose.connect(process.env.MONGODB_URL, { directConnection: true });

  const { connectRedis, redis } = await import('../cache/redis.js');
  await connectRedis();
  await redis.flushdb();
}, 120_000);

/**
 * Wiped between tests rather than between files.
 *
 * Ordering dependencies between tests are the reason integration suites become
 * unmaintainable, and they only appear once state survives a test. The Redis flush
 * matters as much as the Mongo one: the effective-attribute cache is keyed by version
 * counters, and a counter surviving into the next test would serve a previous test's
 * attribute set.
 */
afterEach(async () => {
  const { db } = mongoose.connection;
  if (db) {
    const collections = await db.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  }
  const { redis } = await import('../cache/redis.js');
  await redis.flushdb();

  const { clearValidatorCache } = await import('../modules/catalog/attribute-validator.js');
  clearValidatorCache();
});

afterAll(async () => {
  const { disconnectRedis } = await import('../cache/redis.js');
  await disconnectRedis();
  await mongoose.disconnect();
  await replSet?.stop();
}, 30_000);
