import { logger } from '../lib/logger.js';
import { Product } from '../modules/catalog/product.model.js';
import { meili, PRODUCTS_INDEX, PRODUCTS_REBUILD_INDEX } from './meili.js';
import { toSearchDocument, type ProductSearchDocument } from './product-document.js';
import { buildSearchSettings, loadDefinitionsForSettings, loadSearchableKeys } from './settings.js';

/**
 * Rebuilding the index from scratch.
 *
 * The naive version — `deleteAllDocuments()` then re-add — is wrong in a way that only
 * shows up in production: for however long the rebuild takes, the shop is empty. Not
 * slow, not stale. Empty. Every listing returns nothing and every category looks
 * discontinued.
 *
 * So the rebuild happens in a second index nobody is reading, and the two are swapped
 * atomically at the end. Readers see the old index until the instant they see the new
 * one, and the old index survives the swap under the rebuild alias as a free rollback.
 *
 * Two details were established against a real Meilisearch rather than assumed:
 *
 *  1. **A swap exchanges settings along with documents.** Swapping into an index whose
 *     `filterableAttributes` were never configured leaves the live index with no
 *     filterable attributes at all — every storefront filter starts returning 400. So
 *     the settings are applied to the rebuild index *before* the swap, not after.
 *  2. **The count guard runs before the swap, not after**, because after is too late.
 */

const BATCH_SIZE = 500;

/**
 * The rebuild is refused if it produced dramatically less than what is already live.
 *
 * The case this catches is a rebuild against a database that is not the one the index
 * was built from — a mistyped `MONGODB_URL`, a restore that has not finished, a mongod
 * that came up empty. All of those produce a technically successful rebuild holding
 * almost nothing, and swapping it in would empty the shop exactly as the naive rebuild
 * would have, but permanently.
 */
export const MIN_RATIO = 0.9;

/**
 * Below this many live documents, the ratio is not evidence of anything.
 *
 * A proportional guard assumes the catalogue is large enough for a percentage to mean
 * something. In a shop with four products, archiving one is a 25% drop and would refuse
 * every subsequent rebuild until someone passed `--force` — which teaches an operator
 * that `--force` is the normal way to run it, and that is precisely the habit the guard
 * exists to avoid creating.
 *
 * Catastrophic loss is still caught at any size by the separate zero check below, which
 * is the shape the failure actually takes: a rebuild against the wrong database returns
 * nothing, not 60% of something.
 */
export const GUARD_FLOOR = 50;

export type ReindexResult = {
  indexed: number;
  previous: number;
  swapped: boolean;
  reason?: string;
};

export async function reindexAll(options: { force?: boolean } = {}): Promise<ReindexResult> {
  const started = Date.now();

  // A fresh rebuild index every time. Reusing the previous one would leave documents
  // behind for products that have since been archived — the swap would put them back.
  await meili.deleteIndex(PRODUCTS_REBUILD_INDEX).catch(() => undefined);
  const created = await meili.createIndex(PRODUCTS_REBUILD_INDEX, { primaryKey: 'id' });
  await meili.waitForTask(created.taskUid, { timeOutMs: 120_000 });

  const rebuild = meili.index(PRODUCTS_REBUILD_INDEX);

  // Before the documents, so the index is queryable the instant it goes live.
  const settings = buildSearchSettings(await loadDefinitionsForSettings());
  const settingsTask = await rebuild.updateSettings(settings);
  await meili.waitForTask(settingsTask.taskUid, { timeOutMs: 300_000 });

  const searchableKeys = await loadSearchableKeys();

  let batch: ProductSearchDocument[] = [];
  let indexed = 0;
  const taskUids: number[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const task = await rebuild.addDocuments(batch, { primaryKey: 'id' });
    taskUids.push(task.taskUid);
    indexed += batch.length;
    batch = [];
  };

  // A cursor, so the whole catalogue never has to fit in memory at once.
  const cursor = Product.find({ status: 'active' }).lean().cursor();
  for await (const product of cursor) {
    batch.push(toSearchDocument(product, searchableKeys));
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  // Meilisearch accepts documents asynchronously, so "added" is not "indexed" until
  // every task has finished. Swapping before they settle would swap in a partial index.
  if (taskUids.length > 0) {
    await meili.waitForTasks(taskUids, { timeOutMs: 900_000 });
  }

  const previous = await liveDocumentCount();

  const emptied = indexed === 0 && previous > 0;
  const shrank = previous >= GUARD_FLOOR && indexed < previous * MIN_RATIO;

  if (!options.force && (emptied || shrank)) {
    const reason = emptied
      ? `refusing to swap: the rebuild found no products at all, against ${previous} live. ` +
        `This is what a rebuild pointed at the wrong database looks like. ` +
        `Re-run with --force if the catalogue really is empty.`
      : `refusing to swap: the rebuild holds ${indexed} products against ${previous} live ` +
        `(below ${MIN_RATIO * 100}%). Re-run with --force if this shrink is intended.`;
    logger.error({ indexed, previous, emptied, shrank }, 'search: rebuild rejected by the guard');
    return { indexed, previous, swapped: false, reason };
  }

  const swap = await meili.swapIndexes([{ indexes: [PRODUCTS_INDEX, PRODUCTS_REBUILD_INDEX] }]);
  await meili.waitForTask(swap.taskUid, { timeOutMs: 120_000 });

  logger.info(
    { indexed, previous, ms: Date.now() - started },
    'search: rebuild swapped in; the previous index is still available under the rebuild alias',
  );
  return { indexed, previous, swapped: true };
}

async function liveDocumentCount(): Promise<number> {
  try {
    const stats = await meili.index(PRODUCTS_INDEX).getStats();
    return stats.numberOfDocuments;
  } catch {
    // No live index yet — a first build, where there is nothing to guard against.
    return 0;
  }
}
