import type { Types } from 'mongoose';
import { redis } from '../../cache/redis.js';
import { logger } from '../../lib/logger.js';
import { notFound } from '../../lib/errors.js';
import { AttributeDefinition } from './attribute-definition.model.js';
import { Category } from './category.model.js';
import { canBeVariantAxis, type AttributeType, type FilterUi } from './attribute-types.js';
import { currentVersions } from './catalog-versions.js';

/**
 * Resolving which attributes apply to a category.
 *
 * This is the read side of the adaptable catalogue, and everything downstream depends
 * on it: the admin product form renders from it, the runtime validator is compiled
 * from it, the PDP specification table is ordered by it, and Meilisearch's filterable
 * attributes are derived from the filterable subset of it.
 *
 * Bindings are inherited down the ancestry, nearest ancestor winning. At each node the
 * node's `suppressedKeys` are applied *before* its own bindings are merged, so a
 * branch can both drop an inherited attribute and rebind it with different settings —
 * "Ceramics inherits Care Instructions from Home, but ours is required and lives in a
 * different group."
 */

export type EffectiveAttributeOption = {
  value: string;
  label: string;
  swatchHex?: string;
  order: number;
};

export type EffectiveAttribute = {
  key: string;
  defId: string;
  label: string;
  description?: string;
  type: AttributeType;
  unit?: string;
  options: EffectiveAttributeOption[];
  isFilterable: boolean;
  isSearchable: boolean;
  /** The definition allows this to be an axis, *and* its shape supports one. */
  isAxisEligible: boolean;
  filterUi: FilterUi;
  validation: {
    min?: number;
    max?: number;
    step?: number;
    maxLength?: number;
  };
  /** Resolved from the binding, which overrides the definition's default. */
  required: boolean;
  order: number;
  group?: string;
  /** Which category in the ancestry contributed this binding. For the admin UI. */
  inheritedFrom: { id: string; name: string } | null;
};

export type EffectiveAttributeSet = {
  categoryId: string;
  categoryPath: string;
  validationMode: 'lenient' | 'strict';
  attributes: EffectiveAttribute[];
};

const CACHE_TTL_SECONDS = 3600;

function cacheKey(categoryId: string, tree: number, defs: number): string {
  return `catalog:effattrs:${tree}:${defs}:${categoryId}`;
}

export async function resolveEffectiveAttributes(
  categoryId: string | Types.ObjectId,
): Promise<EffectiveAttributeSet> {
  const id = String(categoryId);
  const versions = await currentVersions();
  const key = cacheKey(id, versions.tree, versions.defs);

  // A cache read must never be able to fail the request: a Redis outage should make
  // the catalogue slow, not broken.
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as EffectiveAttributeSet;
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'effective-attributes: cache read failed');
  }

  const resolved = await computeEffectiveAttributes(id);

  try {
    await redis.set(key, JSON.stringify(resolved), 'EX', CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'effective-attributes: cache write failed');
  }

  return resolved;
}

async function computeEffectiveAttributes(categoryId: string): Promise<EffectiveAttributeSet> {
  const category = await Category.findById(categoryId).lean();
  if (!category) throw notFound('Category not found.');

  // `ancestors` includes self, so this is the whole chain in one query. Sorting by
  // depth gives root-first order regardless of what the array happens to hold.
  const chain = await Category.find({ _id: { $in: category.ancestors } })
    .select('name path depth attributeBindings suppressedKeys')
    .sort({ depth: 1 })
    .lean();

  type Merged = {
    defId: string;
    required: boolean;
    order: number;
    group?: string;
    from: { id: string; name: string };
  };
  const merged = new Map<string, Merged>();

  for (const node of chain) {
    // Suppression first: a node drops what it does not want from above, then says
    // what it does want. Doing this in the other order would make rebinding a
    // suppressed key impossible.
    for (const key of node.suppressedKeys ?? []) merged.delete(key);

    for (const binding of node.attributeBindings ?? []) {
      merged.set(binding.key, {
        defId: String(binding.defId),
        required: binding.required,
        order: binding.order,
        group: binding.group ?? undefined,
        from: { id: String(node._id), name: node.name },
      });
    }
  }

  const defs = await AttributeDefinition.find({
    _id: { $in: [...merged.values()].map((m) => m.defId) },
    archivedAt: { $exists: false },
  }).lean();

  const byId = new Map(defs.map((d) => [String(d._id), d]));
  const attributes: EffectiveAttribute[] = [];

  for (const [key, binding] of merged) {
    const def = byId.get(binding.defId);
    // A binding whose definition was archived simply stops applying. The products that
    // already carry values for it keep them; they are just no longer offered or asked
    // for, which is the point of archiving rather than deleting.
    if (!def) continue;

    const options = (def.options ?? [])
      .map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.swatchHex ? { swatchHex: o.swatchHex } : {}),
        order: o.order,
      }))
      .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

    attributes.push({
      key,
      defId: binding.defId,
      label: def.label,
      ...(def.description ? { description: def.description } : {}),
      type: def.type,
      ...(def.unit ? { unit: def.unit } : {}),
      options,
      isFilterable: def.isFilterable,
      isSearchable: def.isSearchable,
      isAxisEligible: def.isVariantAxis && canBeVariantAxis(def.type, options.length),
      filterUi: def.filterUi,
      validation: {
        ...(def.validation?.min != null ? { min: def.validation.min } : {}),
        ...(def.validation?.max != null ? { max: def.validation.max } : {}),
        ...(def.validation?.step != null ? { step: def.validation.step } : {}),
        ...(def.validation?.maxLength != null ? { maxLength: def.validation.maxLength } : {}),
      },
      required: binding.required,
      order: binding.order,
      ...(binding.group ? { group: binding.group } : {}),
      inheritedFrom:
        binding.from.id === String(category._id)
          ? null
          : { id: binding.from.id, name: binding.from.name },
    });
  }

  attributes.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  return {
    categoryId: String(category._id),
    categoryPath: category.path,
    validationMode: category.validationMode,
    attributes,
  };
}
