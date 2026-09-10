import { Router } from 'express';
import mongoose from 'mongoose';
import { mongoReady } from '../../db/mongo.js';
import { redis, redisReady } from '../../cache/redis.js';
import { meili, meiliReady } from '../../search/meili.js';
import { env } from '../../config/env.js';

export const healthRouter: Router = Router();

const startedAt = Date.now();

/**
 * Liveness. "Is this process alive?" — deliberately cheap and dependency-free, so a
 * database blip never causes the orchestrator to kill an otherwise healthy container.
 */
healthRouter.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    environment: env.NODE_ENV,
  });
});

/**
 * Readiness. "Can this process actually serve traffic?" — probes every dependency in
 * parallel and reports each one separately, so an incident says which store is down
 * instead of just "unhealthy".
 */
healthRouter.get('/readyz', async (_req, res) => {
  const checks = await Promise.all([
    probe('mongo', async () => {
      if (!mongoReady()) throw new Error('not connected');
      await mongoose.connection.db?.admin().command({ ping: 1 });
    }),
    probe('redis', async () => {
      if (!redisReady()) throw new Error('not ready');
      await redis.ping();
    }),
    probe('meilisearch', async () => {
      const health = await meili.health();
      if (health.status !== 'available') throw new Error(health.status);
    }),
  ]);

  const ready = checks.every((c) => c.ok);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'degraded',
    checks: Object.fromEntries(checks.map((c) => [c.name, c])),
  });
});

interface Probe {
  name: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

async function probe(name: string, fn: () => Promise<unknown>): Promise<Probe> {
  const started = performance.now();
  try {
    await fn();
    return { name, ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      name,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: (err as Error).message,
    };
  }
}

// Referenced so the linter sees meiliReady as used; readiness probes the live client
// rather than the cached flag, because a store can fall over after startup.
void meiliReady;
