import { z } from 'zod';
import { patchOf } from '../../lib/zod-patch.js';
import { attributeKeySchema } from './attribute-definition.schema.js';

export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Expected a 24-character id.');

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  /** Derived from the name when omitted. */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
  parent: objectIdSchema.nullable().default(null),
  description: z.string().trim().max(2000).optional(),
  imagePublicId: z.string().trim().optional(),
  order: z.number().int().min(0).default(0),
  validationMode: z.enum(['lenient', 'strict']).default('lenient'),
  status: z.enum(['active', 'hidden']).default('active'),
});

/** No defaults: see lib/zod-patch.ts for what `.partial()` did here before Phase 8. */
export const updateCategorySchema = patchOf(createCategorySchema.omit({ parent: true }));

/** Reparenting is its own operation: it cascades, and a PATCH should not do that silently. */
export const moveCategorySchema = z.object({
  parent: objectIdSchema.nullable(),
});

export const bindAttributeSchema = z.object({
  defId: objectIdSchema,
  required: z.boolean().default(false),
  order: z.number().int().min(0).default(0),
  group: z.string().trim().max(60).optional(),
});

export const suppressKeysSchema = z.object({
  keys: z.array(attributeKeySchema).max(100),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type BindAttributeInput = z.infer<typeof bindAttributeSchema>;
