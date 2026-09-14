import mongoose from 'mongoose';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { canBeVariantAxis, hasOptions, type AttributeType } from './attribute-types.js';
import { AttributeDefinition, type AttributeDefinitionDoc } from './attribute-definition.model.js';
import { Category } from './category.model.js';
import { Product } from './product.model.js';
import { bumpDefsVersion } from './catalog-versions.js';
import { appendOutbox, type OutboxEntry } from '../../search/outbox.model.js';
import type {
  CreateAttributeDefinitionInput,
  UpdateAttributeDefinitionInput,
} from './attribute-definition.schema.js';

/**
 * Rules a definition must satisfy whatever route it arrived through.
 *
 * These are not in the Zod schema because they are cross-field: whether options are
 * required depends on the type, and whether an axis is allowed depends on both.
 */
function assertCoherent(
  type: AttributeType,
  options: { value: string }[],
  isVariantAxis: boolean,
): void {
  if (hasOptions(type) && options.length === 0) {
    throw badRequest(`A ${type} attribute needs at least one option.`);
  }

  const values = options.map((o) => o.value.toLowerCase());
  const duplicate = values.find((v, i) => values.indexOf(v) !== i);
  if (duplicate) {
    throw badRequest(`Option value "${duplicate}" is listed twice.`);
  }

  if (isVariantAxis && !canBeVariantAxis(type, options.length)) {
    throw badRequest(
      `A ${type} attribute cannot be a variant axis. An axis needs a finite set of ` +
        `values, so only select, colour, boolean and enumerated number attributes qualify.`,
    );
  }
}

/**
 * Runs a definition write and records what search has to do about it, atomically.
 *
 * A definition write reaches the index in two different ways and both matter. The
 * *settings* change, because `filterableAttributes` is derived from these documents —
 * a new filterable attribute that never reaches the index is a filter the panel offers
 * and the search server rejects. And in the case of an edit, the denormalised
 * `displayValue` on every product carrying the key becomes stale, which is what the
 * backfill job repairs.
 *
 * Both intents are appended in the same transaction as the definition itself, for the
 * same reason product writes are: an enqueue after the save has a crash window, and a
 * crash in that window leaves the shop's filter panel permanently disagreeing with its
 * search index.
 */
async function inDefinitionTransaction<T>(
  work: (session: mongoose.ClientSession) => Promise<T>,
  entries: OutboxEntry[],
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    let assigned = false;
    await session.withTransaction(async () => {
      result = await work(session);
      assigned = true;
      await appendOutbox(session, entries);
    });
    if (!assigned) throw new Error('definition write transaction produced no result');
    return result as T;
  } finally {
    await session.endSession();
  }
}

export async function createAttributeDefinition(
  input: CreateAttributeDefinitionInput,
): Promise<AttributeDefinitionDoc> {
  assertCoherent(input.type, input.options, input.isVariantAxis);

  const existing = await AttributeDefinition.findOne({ key: input.key }).lean();
  if (existing) {
    throw conflict(
      `An attribute with the key "${input.key}" already exists. Keys are permanent, so ` +
        `pick a different one.`,
    );
  }

  const created = await inDefinitionTransaction(
    async (session) => {
      const [doc] = await AttributeDefinition.create([input], { session });
      if (!doc) throw new Error('attribute definition create returned nothing');
      return doc;
    },
    // A brand-new definition has no products carrying it, so there is nothing to
    // backfill — only the index settings need to learn the new filterable attribute.
    [{ kind: 'settings', op: 'sync' }],
  );

  await bumpDefsVersion();
  return created;
}

export async function updateAttributeDefinition(
  id: string,
  input: UpdateAttributeDefinitionInput,
): Promise<AttributeDefinitionDoc> {
  const definition = await AttributeDefinition.findById(id);
  if (!definition) throw notFound('Attribute not found.');

  const type = definition.type;
  const options = input.options ?? definition.options;
  const isVariantAxis = input.isVariantAxis ?? definition.isVariantAxis;
  assertCoherent(type, options, isVariantAxis);

  // Removing an option that products already use would leave those values orphaned —
  // stored, unrenderable, and unmatched by any filter. Archiving the whole definition
  // is the supported way to retire something.
  definition.set(input);

  await inDefinitionTransaction(
    async (session) => {
      await definition.save({ session });
      return definition;
    },
    [
      { kind: 'settings', op: 'sync' },
      // An edit can change option labels, and those are denormalised onto every product
      // holding this key. The backfill re-renders them and reindexes what it touched.
      { kind: 'attribute-definition', entityId: String(definition._id), op: 'upsert' },
    ],
  );

  await bumpDefsVersion();
  return definition;
}

/**
 * Archive rather than delete.
 *
 * Products keep values keyed by definitions that are no longer offered. Deleting the
 * definition would leave those values without a type or a label, so an archived
 * definition simply stops appearing in forms and filters while existing data stays
 * renderable.
 */
export async function archiveAttributeDefinition(id: string): Promise<AttributeDefinitionDoc> {
  const definition = await AttributeDefinition.findById(id);
  if (!definition) throw notFound('Attribute not found.');

  definition.archivedAt = new Date();

  // Settings only: archiving retires the filter but leaves every stored value and its
  // rendered label exactly as it was, which is the whole point of archiving.
  await inDefinitionTransaction(
    async (session) => {
      await definition.save({ session });
      return definition;
    },
    [{ kind: 'settings', op: 'sync' }],
  );

  await bumpDefsVersion();
  return definition;
}

export async function restoreAttributeDefinition(id: string): Promise<AttributeDefinitionDoc> {
  const definition = await AttributeDefinition.findById(id);
  if (!definition) throw notFound('Attribute not found.');

  definition.archivedAt = undefined;

  await inDefinitionTransaction(
    async (session) => {
      await definition.save({ session });
      return definition;
    },
    [{ kind: 'settings', op: 'sync' }],
  );

  await bumpDefsVersion();
  return definition;
}

export async function listAttributeDefinitions(options: { includeArchived?: boolean } = {}) {
  const filter = options.includeArchived ? {} : { archivedAt: { $exists: false } };
  return AttributeDefinition.find(filter).sort({ label: 1 }).lean();
}

/**
 * How widely each attribute is used, keyed by attribute key.
 *
 * What the attribute builder shows beside every definition, because it is what an admin
 * needs to know before touching one: archiving an attribute bound to four categories and
 * carried by forty products is a different decision from archiving one nobody uses. Two
 * aggregations over the whole catalogue, which is a price this page can pay and the
 * storefront never does.
 */
export async function attributeUsage(): Promise<
  Record<string, { categories: number; products: number }>
> {
  const [bindings, values] = await Promise.all([
    Category.aggregate<{ _id: string; count: number }>([
      { $unwind: '$attributeBindings' },
      { $group: { _id: '$attributeBindings.key', count: { $sum: 1 } } },
    ]),
    Product.aggregate<{ _id: string; count: number }>([
      { $unwind: '$attributes' },
      { $group: { _id: '$attributes.key', count: { $sum: 1 } } },
    ]),
  ]);

  const usage: Record<string, { categories: number; products: number }> = {};
  for (const row of bindings) usage[row._id] = { categories: row.count, products: 0 };
  for (const row of values) {
    usage[row._id] = { categories: usage[row._id]?.categories ?? 0, products: row.count };
  }
  return usage;
}

export async function getAttributeDefinition(id: string) {
  const definition = await AttributeDefinition.findById(id).lean();
  if (!definition) throw notFound('Attribute not found.');
  return definition;
}
