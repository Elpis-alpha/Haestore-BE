import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { redis } from '../cache/redis.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * The indexing queue.
 *
 * BullMQ is what turns "this product changed" into "this product was reindexed, or the
 * failure was retried and then recorded". The outbox guarantees the intent survives a
 * crash; the queue guarantees the work does.
 *
 * Two job-id conventions do most of the work here, and both are load-bearing.
 *
 * They are joined with `__` rather than the obvious `:` because **BullMQ rejects a
 * custom job id containing a colon** — it namespaces its own Redis keys with one, so a
 * colon in an id would collide with its key structure. The failure is a thrown
 * `Custom Id cannot contain :` at enqueue time, which the relay catches and logs, so
 * the visible symptom is not an error but an index that silently never updates.
 *
 * **`product__<id>`** — while a job for a product is *outstanding*, re-adding it is a
 * no-op. An admin who saves the same product six times in ten seconds produces one index
 * write, and because the worker re-reads from Mongo it is the *latest* state that gets
 * indexed rather than the first. Once the job completes the id is freed, so a later edit
 * enqueues normally — see `removeOnComplete` below, which is what makes that true.
 *
 * **`settings-sync` with a delay** — a definition write enqueues a settings job 30
 * seconds out. Further writes inside that window collide with the same waiting job id
 * and are dropped. This is the debounce ADR-003 requires: `updateSettings` triggers a
 * partial re-index of the whole corpus, so six admin saves must produce one task.
 */

export const SEARCH_QUEUE = 'search-index';

export type ProductJob = { kind: 'product'; productId: string };
export type SettingsJob = { kind: 'settings' };
export type CategoryBranchJob = { kind: 'category-branch'; categoryId: string };
export type DefinitionBackfillJob = { kind: 'attribute-definition'; defId: string };
export type SearchJob = ProductJob | SettingsJob | CategoryBranchJob | DefinitionBackfillJob;

let queue: Queue<SearchJob> | null = null;

/**
 * BullMQ needs its own connection. Sharing the application's ioredis client would let a
 * blocking `BRPOPLPUSH` in the worker stall every cache read in the process, which is a
 * failure that presents as "the site is slow" rather than as anything to do with search.
 */
export function searchQueue(): Queue<SearchJob> {
  queue ??= new Queue<SearchJob>(SEARCH_QUEUE, {
    connection: redis.duplicate(),
    defaultJobOptions: {
      attempts: 5,
      // Meilisearch being briefly unavailable is the common failure, and it recovers on
      // its own; backing off gives it room rather than hammering it while it starts.
      backoff: { type: 'exponential', delay: 2_000 },
      /**
       * **Removed the instant it completes, and this is not a tidiness setting.**
       *
       * BullMQ treats a custom job id as unique across every state it retains, including
       * `completed`. Keeping the last N completed jobs therefore keeps their *ids*, and
       * `add()` with an id that already exists is a silent no-op — it returns the
       * existing job and creates nothing, without throwing.
       *
       * With ids like `product__<id>`, retaining completed jobs means the second edit of
       * a product is dropped: the outbox row is written, the relay dispatches it, `add()`
       * reports success, and the index is simply never told. Nothing fails, nothing logs,
       * and the product shows its old title until something else happens to reindex it.
       *
       * Observed on a running server: after the first settings sync completed, every
       * later one was discarded and a newly defined attribute never reached the index.
       *
       * Freeing the id on completion restores the intended meaning — an id collides only
       * while the work is still outstanding, which is exactly the debounce that is wanted
       * and none of the suppression that is not.
       */
      removeOnComplete: true,
      // Failures are kept, and are now the only job history: a failed job is the only
      // record of a product that is in Mongo and not in the index.
      removeOnFail: { count: 1_000 },
    },
  });
  return queue;
}

/** Queues one product for reindexing. Collapses with any job already waiting for it. */
export async function enqueueProduct(productId: string): Promise<void> {
  await searchQueue().add(
    'product',
    { kind: 'product', productId },
    { jobId: `product__${productId}` },
  );
}

/** Queues every product beneath a category. */
export async function enqueueCategoryBranch(categoryId: string): Promise<void> {
  await searchQueue().add(
    'category-branch',
    { kind: 'category-branch', categoryId },
    { jobId: `category-branch__${categoryId}` },
  );
}

/**
 * Queues the debounced settings sync.
 *
 * The `jobId` plus `delay` pair is the whole debounce. There is no timer to leak and no
 * state to keep in this process, which matters because the process that handles the
 * sixth admin save is not necessarily the one that handled the first.
 */
export async function enqueueSettingsSync(options: { immediate?: boolean } = {}): Promise<void> {
  const delay = options.immediate ? 0 : env.SEARCH_SETTINGS_DEBOUNCE_MS;
  await searchQueue().add(
    'settings',
    { kind: 'settings' },
    { jobId: options.immediate ? undefined : 'settings-sync', delay },
  );
}

/**
 * Queues the re-render of one definition's denormalised display values.
 *
 * Separate from the settings sync because the two do different work on different
 * schedules: settings are debounced and touch the index configuration, while this
 * rewrites `displayValue` on every product carrying the key and then reindexes them.
 */
export async function enqueueDefinitionBackfill(defId: string): Promise<void> {
  await searchQueue().add(
    'attribute-definition',
    { kind: 'attribute-definition', defId },
    { jobId: `attribute-definition__${defId}` },
  );
}

export type SearchJobHandler = (job: Job<SearchJob>) => Promise<void>;

let worker: Worker<SearchJob> | null = null;

export function startSearchWorker(handler: SearchJobHandler): Worker<SearchJob> | null {
  if (!env.SEARCH_INDEXING_ENABLED) {
    logger.info('search: indexing disabled in this process (SEARCH_INDEXING_ENABLED=false)');
    return null;
  }
  if (worker) return worker;

  worker = new Worker<SearchJob>(SEARCH_QUEUE, handler, {
    connection: redis.duplicate(),
    // Meilisearch applies document writes asynchronously anyway, so a wide concurrency
    // buys queueing inside Meilisearch rather than throughput here.
    concurrency: 4,
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
      'search: index job failed',
    );
  });
  worker.on('error', (err) => logger.error({ err: err.message }, 'search: worker error'));

  logger.info('search: index worker started');
  return worker;
}

export async function stopSearchWorker(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}

/** Exported for the reindex script, which enqueues nothing and only needs the options. */
export const oneOff: JobsOptions = { attempts: 1, removeOnComplete: true };
