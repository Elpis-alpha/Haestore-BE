import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Redis holds OTP challenges, sessions, rate-limit counters, caches and BullMQ queues.
 *
 * The governing rule, from docs/ARCHITECTURE.md: Redis must be safe to flush at 3 a.m.
 * Nothing whose loss is a lost sale lives here — carts are in Mongo for exactly that
 * reason. What does live here needs native TTL semantics, and OTP expiry in particular
 * must be enforced on read rather than by a background sweeper.
 */

export const redis = new Redis(env.REDIS_URL, {
  // BullMQ requires this to be null; it also stops commands queueing forever during
  // an outage, so failures surface instead of hanging the request.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

redis.on('error', (err: Error) => logger.error({ err: err.message }, 'redis: error'));
redis.on('ready', () => logger.info('redis: ready'));
redis.on('reconnecting', () => logger.warn('redis: reconnecting'));

export async function connectRedis(): Promise<void> {
  if (redis.status === 'ready' || redis.status === 'connecting') return;
  await redis.connect();
  await redis.ping();
}

export async function disconnectRedis(): Promise<void> {
  if (redis.status === 'end') return;
  await redis.quit();
  logger.info('redis: disconnected cleanly');
}

export const redisReady = (): boolean => redis.status === 'ready';
