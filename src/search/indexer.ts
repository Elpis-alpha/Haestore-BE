import type { Job } from 'bullmq';
import { logger } from '../lib/logger.js';
import { Product } from '../modules/catalog/product.model.js';
import { AttributeDefinition } from '../modules/catalog/attribute-definition.model.js';
import { toDisplayValue } from '../modules/catalog/attribute-validator.js';
import type { EffectiveAttribute } from '../modules/catalog/effective-attributes.js';
import { canBeVariantAxis, type AttributeType } from '../modules/catalog/attribute-types.js';
import { meili, PRODUCTS_INDEX } from './meili.js';
import { toSearchDocument } from './product-document.js';
import {
  buildSearchSettings,
  loadAttributeTypes,
  loadDefinitionsForSettings,
  loadSearchableKeys,
} from './settings.js';
import { forgetFilterableFields } from './index-capabilities.js';
import type { SearchJob } from './queue.js';

/**
 * The worker that actually writes to Meilisearch.
 *
 * One rule governs every handler here: **the payload is a hint and Mongo is the truth.**
 * A job says which product changed, never what it changed to. By the time a job is
 * drained the product may have been edited twice more, archived, or deleted; rebuilding
 * from the database means the index converges on the current state no matter how stale
 * or how duplicated the job was. That is what makes the whole outbox arrangement safe
 * to retry — and retries are the normal case, not the exception.
 */

const BATCH_SIZE = 500;

/**
 * Indexes one product, or removes it.
 *
 * A product that is missing, archived or back in draft is **deleted from the index**
 * rather than indexed with a status the query filters out. Only active products are in
 * the index at all, so an unpublish takes effect even if a filter is ever built wrong.
 */
export async function indexProduct(productId: string): Promise<void> {
  const product = await Product.findById(productId).lean();
  const index = meili.index(PRODUCTS_INDEX);

  if (!product || product.status !== 'active') {
    await index.deleteDocument(productId);
    logger.debug({ productId, reason: product ? product.status : 'missing' }, 'search: removed');
    return;
  }

  const [searchableKeys, types] = await Promise.all([loadSearchableKeys(), loadAttributeTypes()]);
  await index.addDocuments([toSearchDocument(product, searchableKeys, types)], {
    primaryKey: 'id',
  });
  logger.debug({ productId }, 'search: indexed');
}

/**
 * Reindexes every product beneath a category.
 *
 * Emitted by a category rename or move, which rewrites `categoryAncestors` on every
 * product in the branch. One outbox row stands for all of them because the alternative
 * — a row per product — would add tens of thousands of inserts to a transaction that is
 * already rewriting tens of thousands of documents, and a transaction that large will
 * exceed its lifetime limit and roll the whole move back.
 */
export async function indexCategoryBranch(categoryId: string): Promise<void> {
  const [searchableKeys, types] = await Promise.all([loadSearchableKeys(), loadAttributeTypes()]);
  const index = meili.index(PRODUCTS_INDEX);

  let batch: ReturnType<typeof toSearchDocument>[] = [];
  let indexed = 0;
  const stale: string[] = [];

  // A cursor rather than a find(): a branch can hold the entire catalogue, and loading
  // it into memory to map it is how a reindex takes the API down with it.
  const cursor = Product.find({ categoryAncestors: categoryId })
    .select('+attributes')
    .lean()
    .cursor();

  for await (const product of cursor) {
    if (product.status !== 'active') {
      stale.push(String(product._id));
      continue;
    }
    batch.push(toSearchDocument(product, searchableKeys, types));
    if (batch.length >= BATCH_SIZE) {
      await index.addDocuments(batch, { primaryKey: 'id' });
      indexed += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await index.addDocuments(batch, { primaryKey: 'id' });
    indexed += batch.length;
  }
  // Products that left `active` while sitting in this branch. Deleting them here means a
  // branch reindex also repairs drift rather than only refreshing what is still live.
  if (stale.length > 0) await index.deleteDocuments(stale);

  logger.info({ categoryId, indexed, removed: stale.length }, 'search: reindexed branch');
}

/**
 * Re-derives the index settings from the attribute definitions.
 *
 * Debounced upstream (see queue.ts), because `updateSettings` triggers a partial
 * re-index of the corpus. Meilisearch compares the submitted settings with the current
 * ones and does nothing when they match, which is why `buildSearchSettings` sorts
 * everything it emits — an unstable ordering would make every sync look like a change.
 */
export async function syncSearchSettings(): Promise<void> {
  const definitions = await loadDefinitionsForSettings();
  const settings = buildSearchSettings(definitions);

  const task = await meili.index(PRODUCTS_INDEX).updateSettings(settings);
  // Waited on, so the cached capability set is dropped only once the new attributes are
  // genuinely queryable. Dropping it at enqueue time would let a request re-cache the
  // old settings while the task was still running, and the new facet would then take
  // another cache lifetime to appear.
  await meili.waitForTask(task.taskUid, { timeOutMs: 300_000 });
  forgetFilterableFields();

  logger.info(
    { taskUid: task.taskUid, filterable: settings.filterableAttributes?.length },
    'search: settings synced',
  );
}

/**
 * Re-renders one definition's denormalised display values across the catalogue.
 *
 * `displayValue` is stored on every product attribute so the specification table needs
 * no definition lookup (see product.model.ts). The price of that is this job: when an
 * admin renames the option `medium` from "Medium" to "Medium roast", every product
 * carrying it holds the old string until something rewrites it.
 *
 * Doing it here rather than inside the admin request is deliberate. The write touches an
 * unbounded number of products, and an admin editing a label should not sit through it —
 * nor should the edit fail because the catalogue is large. The reindex is folded into the
 * same job because the two are the same event: the products whose display values just
 * changed are exactly the products whose index documents are now stale.
 */
export async function backfillDefinition(defId: string): Promise<void> {
  const definition = await AttributeDefinition.findById(defId).lean();
  if (!definition) {
    logger.warn({ defId }, 'search: backfill skipped, definition is gone');
    return;
  }

  // `toDisplayValue` wants an EffectiveAttribute, and only the fields it reads matter
  // here — the rendering depends on the definition, never on the binding.
  const options = (definition.options ?? [])
    .map((o) => ({
      value: o.value,
      label: o.label,
      ...(o.swatchHex ? { swatchHex: o.swatchHex } : {}),
      order: o.order,
    }))
    .sort((a, b) => a.order - b.order);

  const rendering: EffectiveAttribute = {
    key: definition.key,
    defId: String(definition._id),
    label: definition.label,
    type: definition.type,
    ...(definition.unit ? { unit: definition.unit } : {}),
    options,
    isFilterable: definition.isFilterable,
    isSearchable: definition.isSearchable,
    isAxisEligible: definition.isVariantAxis && canBeVariantAxis(definition.type, options.length),
    filterUi: definition.filterUi,
    validation: {},
    required: false,
    order: 0,
    inheritedFrom: null,
  };

  const [searchableKeys, types] = await Promise.all([loadSearchableKeys(), loadAttributeTypes()]);
  const index = meili.index(PRODUCTS_INDEX);

  let rewritten = 0;
  let batch: ReturnType<typeof toSearchDocument>[] = [];

  const cursor = Product.find({ 'attributes.key': definition.key }).cursor();

  for await (const product of cursor) {
    let changed = false;

    for (const attribute of product.attributes) {
      if (attribute.key !== definition.key) continue;

      const stored = storedValueOf(attribute);
      if (stored === undefined) continue;

      const next = toDisplayValue(rendering, stored);
      if (next !== attribute.displayValue) {
        attribute.displayValue = next;
        changed = true;
      }
    }

    if (changed) {
      await product.save();
      rewritten += 1;
    }
    if (product.status === 'active') {
      batch.push(toSearchDocument(product.toObject(), searchableKeys, types));
      if (batch.length >= BATCH_SIZE) {
        await index.addDocuments(batch, { primaryKey: 'id' });
        batch = [];
      }
    }
  }

  if (batch.length > 0) await index.addDocuments(batch, { primaryKey: 'id' });

  logger.info({ defId, key: definition.key, rewritten }, 'search: definition backfill complete');
}

/** The stored value, back out of its typed slot. */
function storedValueOf(attribute: {
  type: string;
  valueString?: string | null;
  valueStrings?: string[] | null;
  valueNumber?: number | null;
  valueBool?: boolean | null;
  valueDim?: unknown;
}): unknown {
  switch (attribute.type as AttributeType) {
    case 'multiselect':
      return attribute.valueStrings ?? undefined;
    case 'number':
      return attribute.valueNumber ?? undefined;
    case 'boolean':
      return attribute.valueBool ?? undefined;
    case 'dimension':
      return attribute.valueDim ?? undefined;
    default:
      return attribute.valueString ?? undefined;
  }
}

/** The single entry point the worker is started with. */
export async function handleSearchJob(job: Job<SearchJob>): Promise<void> {
  switch (job.data.kind) {
    case 'product':
      return indexProduct(job.data.productId);
    case 'category-branch':
      return indexCategoryBranch(job.data.categoryId);
    case 'attribute-definition':
      return backfillDefinition(job.data.defId);
    case 'settings':
      return syncSearchSettings();
    default: {
      // Exhaustiveness: a new job kind added to the union without a handler fails to
      // compile rather than being silently dropped at runtime.
      const unreachable: never = job.data;
      throw new Error(`unknown search job: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Creates the index if it does not exist. Safe to call on every boot. */
export async function ensureProductsIndex(): Promise<void> {
  try {
    await meili.getIndex(PRODUCTS_INDEX);
  } catch {
    const task = await meili.createIndex(PRODUCTS_INDEX, { primaryKey: 'id' });
    await meili.waitForTask(task.taskUid);
    logger.info({ index: PRODUCTS_INDEX }, 'search: index created');
  }
}
