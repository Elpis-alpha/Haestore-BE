import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { canBeVariantAxis, hasOptions, type AttributeType } from './attribute-types.js';
import { AttributeDefinition, type AttributeDefinitionDoc } from './attribute-definition.model.js';
import { bumpDefsVersion } from './catalog-versions.js';
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

  const created = await AttributeDefinition.create(input);
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
  await definition.save();
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
  await definition.save();
  await bumpDefsVersion();
  return definition;
}

export async function restoreAttributeDefinition(id: string): Promise<AttributeDefinitionDoc> {
  const definition = await AttributeDefinition.findById(id);
  if (!definition) throw notFound('Attribute not found.');

  definition.archivedAt = undefined;
  await definition.save();
  await bumpDefsVersion();
  return definition;
}

export async function listAttributeDefinitions(options: { includeArchived?: boolean } = {}) {
  const filter = options.includeArchived ? {} : { archivedAt: { $exists: false } };
  return AttributeDefinition.find(filter).sort({ label: 1 }).lean();
}

export async function getAttributeDefinition(id: string) {
  const definition = await AttributeDefinition.findById(id).lean();
  if (!definition) throw notFound('Attribute not found.');
  return definition;
}
