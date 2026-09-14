import { z } from 'zod';
import { patchOf } from '../../lib/zod-patch.js';
import { ATTRIBUTE_TYPES, FILTER_UIS, RESERVED_ATTRIBUTE_KEYS } from './attribute-types.js';

/**
 * Request shapes for the attribute builder.
 *
 * `key` is validated hard here rather than in the service, because every downstream
 * consumer treats it as already safe: it becomes a URL parameter, a Meilisearch
 * attribute name and a JSON key. Anything that would need escaping later is refused
 * now.
 */

export const attributeKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z][a-z0-9_]{1,39}$/,
    'Use 2–40 characters: a letter first, then lowercase letters, digits or underscores.',
  )
  .refine((key) => !RESERVED_ATTRIBUTE_KEYS.has(key), {
    message:
      'That key is reserved by the storefront listing (q, sort, page, per_page, price, ' +
      'in_stock, view, cursor, category, id, slug). Filters appear in the URL by key, so ' +
      'this one could never be told apart from the built-in parameter.',
  });

export const attributeOptionSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9_-]*$/i, 'Option values appear in URLs, so keep them slug-shaped.'),
  label: z.string().trim().min(1).max(120),
  swatchHex: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  order: z.number().int().min(0).default(0),
});

const validationSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    maxLength: z.number().int().positive().max(5000).optional(),
    requiredByDefault: z.boolean().default(false),
  })
  .refine((v) => v.min == null || v.max == null || v.min <= v.max, {
    message: 'min must not be greater than max.',
  });

export const createAttributeDefinitionSchema = z.object({
  key: attributeKeySchema,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  type: z.enum(ATTRIBUTE_TYPES),
  unit: z.string().trim().max(16).optional(),
  options: z.array(attributeOptionSchema).max(200).default([]),
  isFilterable: z.boolean().default(true),
  isSearchable: z.boolean().default(false),
  isVariantAxis: z.boolean().default(false),
  filterUi: z.enum(FILTER_UIS).default('checkbox'),
  validation: validationSchema.default({ requiredByDefault: false }),
});

/**
 * `key` and `type` are absent by construction, not merely optional.
 *
 * Making them omittable-but-present would leave a route free to accept them and a
 * service free to forget the check. Leaving them out of the type means a rename is not
 * expressible in the API at all, which is the actual policy.
 */
export const updateAttributeDefinitionSchema = patchOf(
  createAttributeDefinitionSchema.omit({ key: true, type: true }),
);

export type CreateAttributeDefinitionInput = z.infer<typeof createAttributeDefinitionSchema>;
export type UpdateAttributeDefinitionInput = z.infer<typeof updateAttributeDefinitionSchema>;
