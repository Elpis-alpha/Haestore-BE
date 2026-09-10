import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import type { AttributeType } from './attribute-types.js';
import type { EffectiveAttribute, EffectiveAttributeSet } from './effective-attributes.js';

/**
 * Permissive schema, strict service.
 *
 * The Mongoose schema has typed slots but no enums and no required-ness, because the
 * policy it would encode is not knowable at model-definition time — it is whatever an
 * admin defined this morning. Policy lives here instead, as a Zod schema compiled at
 * runtime from the category's effective attribute set.
 *
 * The admin sends a flat DTO — `{ roast: 'medium', weight_g: 250 }` — because that is
 * what a form produces. This module validates it and projects it into the normalised
 * typed array the model stores. The two responsibilities are separate on purpose: the
 * projection cannot run on values that have not been validated, and validation has no
 * business knowing about storage layout.
 */

export type AttributeInput = Record<string, unknown>;

export type ValidationIssue = {
  key: string;
  code: 'missing_required' | 'invalid_value' | 'unknown_attribute';
  message: string;
};

export type ProjectedAttribute = {
  key: string;
  defId: Types.ObjectId;
  type: AttributeType;
  valueString?: string;
  valueStrings?: string[];
  valueNumber?: number;
  valueBool?: boolean;
  valueDim?: { length: number; width: number; height: number; unit: string };
  unit?: string;
  displayValue: string;
  order: number;
  group?: string;
};

const dimensionSchema = z.object({
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  unit: z.string().trim().min(1).max(16),
});

/** The Zod type for one attribute, before required-ness is applied. */
function valueSchema(attribute: EffectiveAttribute): z.ZodTypeAny {
  const values = attribute.options.map((o) => o.value);
  const { min, max, maxLength } = attribute.validation;

  switch (attribute.type) {
    case 'select':
    case 'color': {
      // An options-less select is a definition an admin has not finished. Accepting any
      // string here would silently let the unfinished state into the catalogue, so it
      // is rejected as an invalid value instead.
      if (values.length === 0) return z.never();
      return z.enum(values as [string, ...string[]]);
    }

    case 'multiselect': {
      if (values.length === 0) return z.never();
      return z.array(z.enum(values as [string, ...string[]])).min(1);
    }

    case 'text': {
      return z
        .string()
        .trim()
        .min(1)
        .max(maxLength ?? 500);
    }

    case 'number': {
      // An enumerated number is a select whose labels happen to be numeric, so the
      // stored value stays a number and membership is checked rather than range.
      if (values.length > 0) {
        const allowed = new Set(values.map(Number));
        return z.number().refine((n) => allowed.has(n), {
          message: `Must be one of: ${values.join(', ')}`,
        });
      }
      let schema = z.number();
      if (min != null) schema = schema.min(min);
      if (max != null) schema = schema.max(max);
      return schema;
    }

    case 'boolean':
      return z.boolean();

    case 'dimension':
      return dimensionSchema;

    default: {
      // Exhaustiveness: adding an AttributeType without handling it here fails to
      // compile rather than falling through to something permissive.
      const never: never = attribute.type;
      throw new Error(`Unhandled attribute type: ${String(never)}`);
    }
  }
}

/**
 * Compiles the whole set into one object schema.
 *
 * `z.strictObject` is the important part: unknown keys are rejected, so an admin
 * cannot invent an attribute by adding a field to a request. Every key that reaches
 * storage was defined and bound first.
 *
 * In `lenient` mode nothing is required at parse time — a missing required value comes
 * back as an issue on the product rather than a rejected write. That is what allows a
 * new required attribute to be added to a category holding forty existing products
 * without breaking any of them. See Category.validationMode.
 */
export function buildAttributeValidator(set: EffectiveAttributeSet): z.ZodType<AttributeInput> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const strict = set.validationMode === 'strict';

  for (const attribute of set.attributes) {
    const schema = valueSchema(attribute);
    shape[attribute.key] = strict && attribute.required ? schema : schema.optional();
  }

  return z.strictObject(shape);
}

/**
 * Compiled validators, cached in process.
 *
 * Zod schemas are closures and cannot be serialised into Redis alongside the effective
 * set, so this is a second, smaller cache with the same key. It is bounded rather than
 * unbounded because the key includes both version counters — every admin edit produces
 * a fresh generation of keys, and without a bound the old generations would accumulate
 * for the life of the process.
 */
const MAX_CACHED_VALIDATORS = 200;
const validatorCache = new Map<string, z.ZodType<AttributeInput>>();

export function cachedValidator(
  cacheKey: string,
  set: EffectiveAttributeSet,
): z.ZodType<AttributeInput> {
  const hit = validatorCache.get(cacheKey);
  if (hit) {
    // Re-inserting moves the key to the end, so the eviction below is least-recently-used.
    validatorCache.delete(cacheKey);
    validatorCache.set(cacheKey, hit);
    return hit;
  }

  const built = buildAttributeValidator(set);
  validatorCache.set(cacheKey, built);

  if (validatorCache.size > MAX_CACHED_VALIDATORS) {
    const oldest = validatorCache.keys().next().value;
    if (oldest !== undefined) validatorCache.delete(oldest);
  }
  return built;
}

/** Exposed for tests; nothing in the request path should need it. */
export function clearValidatorCache(): void {
  validatorCache.clear();
}

/** How a stored value is rendered, computed once at write time. */
function toDisplayValue(attribute: EffectiveAttribute, value: unknown): string {
  const labelOf = (v: string) => attribute.options.find((o) => o.value === v)?.label ?? v;

  switch (attribute.type) {
    case 'select':
    case 'color':
      return labelOf(String(value));
    case 'multiselect':
      return (value as string[]).map(labelOf).join(', ');
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'number': {
      const enumerated = attribute.options.find((o) => Number(o.value) === value);
      if (enumerated) return enumerated.label;
      return attribute.unit ? `${String(value)} ${attribute.unit}` : String(value);
    }
    case 'dimension': {
      const d = value as { length: number; width: number; height: number; unit: string };
      return `${d.length} × ${d.width} × ${d.height} ${d.unit}`;
    }
    default:
      return String(value);
  }
}

/**
 * Validates a flat DTO against the category's effective set and projects it into the
 * stored shape, reporting anything wrong that lenient mode tolerates.
 *
 * Throws only for things no mode should accept — an unknown key, or a value of the
 * wrong shape. A missing *required* value is an issue in lenient mode and a parse
 * failure in strict mode, which is decided by the compiled schema rather than here.
 */
export function validateAndProject(
  input: AttributeInput,
  set: EffectiveAttributeSet,
  validator: z.ZodType<AttributeInput>,
): { attributes: ProjectedAttribute[]; issues: ValidationIssue[] } {
  const parsed = validator.safeParse(input);

  if (!parsed.success) {
    throw badRequest(
      'One or more attributes are not valid for this category.',
      parsed.error.issues.map((issue) => ({
        key: issue.path.join('.') || '(root)',
        code: issue.code,
        message: issue.message,
      })),
    );
  }

  const values = parsed.data;
  const attributes: ProjectedAttribute[] = [];
  const issues: ValidationIssue[] = [];

  for (const attribute of set.attributes) {
    const value = values[attribute.key];

    if (value === undefined || value === null || value === '') {
      if (attribute.required) {
        issues.push({
          key: attribute.key,
          code: 'missing_required',
          message: `${attribute.label} is required for this category.`,
        });
      }
      continue;
    }

    attributes.push({
      key: attribute.key,
      defId: new Types.ObjectId(attribute.defId),
      type: attribute.type,
      ...valueSlot(attribute.type, value),
      ...(attribute.unit ? { unit: attribute.unit } : {}),
      displayValue: toDisplayValue(attribute, value),
      order: attribute.order,
      ...(attribute.group ? { group: attribute.group } : {}),
    });
  }

  return { attributes, issues };
}

/** Routes a validated value into its typed slot. See VALUE_FIELD in attribute-types.ts. */
function valueSlot(type: AttributeType, value: unknown): Partial<ProjectedAttribute> {
  switch (type) {
    case 'select':
    case 'color':
    case 'text':
      return { valueString: String(value) };
    case 'multiselect':
      return { valueStrings: value as string[] };
    case 'number':
      return { valueNumber: value as number };
    case 'boolean':
      return { valueBool: value as boolean };
    case 'dimension':
      return { valueDim: value as ProjectedAttribute['valueDim'] };
    default: {
      const never: never = type;
      throw new Error(`Unhandled attribute type: ${String(never)}`);
    }
  }
}
