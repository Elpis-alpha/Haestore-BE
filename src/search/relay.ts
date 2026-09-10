import type { ChangeStream, ChangeStreamInsertDocument, ResumeToken } from 'mongodb';
import { redis } from '../cache/redis.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { SearchOutbox, type SearchOutboxAttrs } from './outbox.model.js';
import {
  enqueueCategoryBranch,
  enqueueDefinitionBackfill,
  enqueueProduct,
  enqueueSettingsSync,
} from './queue.js';

/**
 * Draining the outbox into the queue.
 *
 * A change stream on `search_outbox` is the fast path: an insert reaches this within
 * milliseconds of the transaction committing, without polling. Change streams are also
 * why the local stack insists on a replica set — a standalone `mongod` has none, which
 * is verified in scripts/probe-infra.mjs rather than assumed.
 *
 * Underneath it sits a **sweep**, and the sweep is what makes the design honest. The
 * stream can miss work in ways that are invisible from inside it: the process was down
 * when the row was written and the resume token has since fallen off the oplog, the
 * stream errored between receiving an event and enqueuing it, the enqueue itself failed.
 * So every row is also picked up by a periodic query for anything unprocessed and older
 * than a grace period. The stream makes indexing fast; the sweep makes it certain.
 *
 * Re-delivery is expected and harmless: the worker rebuilds each document from Mongo,
 * so indexing a product twice produces the same index either way.
 */

const RESUME_TOKEN_KEY = 'search:outbox:resumeToken';
const LEASE_KEY = 'search:outbox:relay-leader';
const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
/** How long a row may sit unprocessed before the sweep assumes the stream missed it. */
const SWEEP_GRACE_MS = 30_000;
const SWEEP_BATCH = 500;

let stream: ChangeStream | null = null;
let leaseTimer: NodeJS.Timeout | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let leaseToken: string | null = null;
let stopped = false;

/**
 * A single-holder lease.
 *
 * Two relays draining the same outbox is not a correctness problem — the queue collapses
 * duplicate job ids and the worker is idempotent — but it is wasted work that scales
 * with the number of API replicas. The lease keeps it to one, and expires on its own if
 * the holder dies, so nothing has to notice a crash and hand over.
 */
async function acquireLease(): Promise<boolean> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const won = await redis.set(LEASE_KEY, token, 'PX', LEASE_TTL_MS, 'NX');
  if (won) {
    leaseToken = token;
    return true;
  }
  return false;
}

/**
 * Renews only if we still hold it.
 *
 * The compare-and-set matters: a process that stalled past its TTL has already lost the
 * lease to someone else, and renewing unconditionally would give it back — leaving two
 * holders, which is the one state the lease exists to prevent.
 */
const RENEW_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

async function renewLease(): Promise<boolean> {
  if (!leaseToken) return false;
  const held = await redis.eval(RENEW_SCRIPT, 1, LEASE_KEY, leaseToken, String(LEASE_TTL_MS));
  return held === 1;
}

async function releaseLease(): Promise<void> {
  if (!leaseToken) return;
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end
  `;
  await redis.eval(script, 1, LEASE_KEY, leaseToken).catch(() => 0);
  leaseToken = null;
}

/** Routes one outbox row to the queue. */
async function dispatch(row: Pick<SearchOutboxAttrs, 'kind' | 'entityId' | 'op'>): Promise<void> {
  switch (row.kind) {
    case 'product':
      if (row.entityId) await enqueueProduct(row.entityId);
      return;
    case 'category-branch':
      if (row.entityId) await enqueueCategoryBranch(row.entityId);
      return;
    case 'attribute-definition':
      if (row.entityId) await enqueueDefinitionBackfill(row.entityId);
      return;
    case 'settings':
      await enqueueSettingsSync();
      return;
    default:
      logger.warn({ kind: row.kind }, 'search: unknown outbox kind, skipping');
  }
}

async function markProcessed(ids: unknown[]): Promise<void> {
  if (ids.length === 0) return;
  await SearchOutbox.updateMany(
    { _id: { $in: ids } },
    { $set: { processedAt: new Date() }, $inc: { attempts: 1 } },
  );
}

/**
 * The safety net: anything unprocessed and older than the grace period.
 *
 * Also runs once at startup, which is the case that matters most — every row written
 * while this process was down is invisible to a change stream that starts now.
 */
export async function sweepOutboxOnce(options: { graceMs?: number } = {}): Promise<number> {
  const cutoff = new Date(Date.now() - (options.graceMs ?? SWEEP_GRACE_MS));
  const rows = await SearchOutbox.find({ processedAt: null, createdAt: { $lte: cutoff } })
    .sort({ createdAt: 1 })
    .limit(SWEEP_BATCH)
    .lean();

  if (rows.length === 0) return 0;

  const done: unknown[] = [];
  for (const row of rows) {
    try {
      await dispatch(row);
      done.push(row._id);
    } catch (error) {
      // Left unprocessed on purpose: the next sweep retries it, and `attempts` is only
      // incremented on success so a stuck row is visible by its age rather than hidden
      // behind a counter that keeps climbing.
      logger.error({ err: (error as Error).message, id: String(row._id) }, 'search: sweep failed');
    }
  }
  await markProcessed(done);
  logger.info({ swept: done.length }, 'search: outbox sweep drained rows the stream missed');
  return done.length;
}

/** The scheduled form, which swallows its own failures so the interval survives them. */
async function sweep(): Promise<void> {
  await sweepOutboxOnce();
}

// `ResumeToken` is `unknown` in the driver's types, so it already covers "no token".
async function readResumeToken(): Promise<ResumeToken> {
  try {
    const raw = await redis.get(RESUME_TOKEN_KEY);
    return raw ? (JSON.parse(raw) as ResumeToken) : undefined;
  } catch {
    return undefined;
  }
}

async function openStream(): Promise<void> {
  if (stopped) return;

  const resumeAfter = await readResumeToken();

  stream = SearchOutbox.watch([{ $match: { operationType: 'insert' } }], {
    ...(resumeAfter ? { resumeAfter } : {}),
    // The document is needed to know what to enqueue, and an insert carries it anyway.
    fullDocument: 'updateLookup',
  });

  stream.on('change', (event) => {
    void (async () => {
      const insert = event as ChangeStreamInsertDocument<SearchOutboxAttrs & { _id: unknown }>;
      const row = insert.fullDocument;
      if (!row) return;
      try {
        await dispatch(row);
        await markProcessed([row._id]);
        // The token is stored only *after* the work is enqueued. Storing it first would
        // let a crash in between skip the row permanently — the stream would resume past
        // an event that was never acted on, and only the sweep would ever catch it.
        await redis.set(RESUME_TOKEN_KEY, JSON.stringify(insert._id));
      } catch (error) {
        logger.error({ err: (error as Error).message }, 'search: relay dispatch failed');
      }
    })();
  });

  stream.on('error', (error: Error) => {
    logger.error({ err: error.message }, 'search: change stream error, reopening');
    void reopen();
  });

  stream.on('close', () => {
    if (!stopped) void reopen();
  });

  logger.info({ resumed: Boolean(resumeAfter) }, 'search: outbox change stream open');
}

async function reopen(): Promise<void> {
  if (stopped) return;
  const current = stream;
  stream = null;
  await current?.close().catch(() => undefined);

  // An invalid or too-old resume token cannot be recovered from by retrying with it, so
  // it is dropped and the sweep is relied on to backfill whatever the gap contained.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  try {
    await openStream();
  } catch (error) {
    logger.error({ err: (error as Error).message }, 'search: reopen failed, dropping resume token');
    await redis.del(RESUME_TOKEN_KEY).catch(() => 0);
    setTimeout(() => void openStream(), 5_000);
  }
}

/**
 * Starts the relay if this process wins the lease.
 *
 * Losing the lease is not an error and not a retry loop — the winner renews every ten
 * seconds and only ever loses it by dying, at which point the key expires and the next
 * caller of this function takes over.
 */
export async function startOutboxRelay(): Promise<void> {
  if (!env.SEARCH_INDEXING_ENABLED) return;
  stopped = false;

  // The sweep runs whether or not this process holds the lease for the stream: it is
  // cheap, idempotent, and the one thing that must not depend on leader election
  // working.
  await sweep().catch((error: Error) =>
    logger.error({ err: error.message }, 'search: startup sweep failed'),
  );
  sweepTimer = setInterval(() => {
    void sweep().catch((error: Error) =>
      logger.error({ err: error.message }, 'search: sweep failed'),
    );
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // The lease is contested on a timer rather than once at startup, and that is not a
  // detail. A holder that dies leaves its key to expire on its own, so whoever is next
  // has to come back and ask again — trying only at boot means a crashed leader takes
  // the fast path down with it until someone restarts a process, and the shop quietly
  // falls back to a 60-second sweep with nothing reporting that it has.
  //
  // Observed rather than reasoned about: a process that crashed seconds after taking the
  // lease left the next one logging "another process holds the relay lease" and never
  // opening a stream at all.
  leaseTimer = setInterval(() => {
    void tick();
  }, LEASE_RENEW_MS);
  leaseTimer.unref();

  await tick();
}

/**
 * One turn of leader election: keep the lease if we have it, take it if we can.
 *
 * Renewal failing means the lease has already gone to someone else — a process that
 * stalled past its own TTL — so the stream is closed rather than left running alongside
 * the new holder's.
 */
async function tick(): Promise<void> {
  if (stopped) return;

  if (leaseToken) {
    if (await renewLease()) return;
    logger.warn('search: lost the relay lease, closing the change stream');
    leaseToken = null;
    const current = stream;
    stream = null;
    await current?.close().catch(() => undefined);
    return;
  }

  if (!(await acquireLease())) return;

  logger.info('search: took the relay lease');
  await openStream().catch((error: Error) => {
    logger.error({ err: error.message }, 'search: failed to open the change stream');
  });
}

export async function stopOutboxRelay(): Promise<void> {
  stopped = true;
  if (leaseTimer) clearInterval(leaseTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  leaseTimer = null;
  sweepTimer = null;
  await stream?.close().catch(() => undefined);
  stream = null;
  await releaseLease();
}
