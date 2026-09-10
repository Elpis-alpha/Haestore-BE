import { z } from 'zod';
import { objectIdSchema } from './category.schema.js';

const moneySchema = z.object({
  /** Minor units, always an integer. A float here is the bug this shape exists to stop. */
  amount: z.number().int().min(0),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3)
    .regex(/^[A-Z]{3}$/),
});

export const variantInputSchema = z.object({
  /** Omitted on create, when it is generated from the title and the axis values. */
  sku: z.string().trim().max(64).optional(),
  axisValues: z
    .array(z.object({ key: z.string().trim().toLowerCase(), value: z.string().trim() }))
    .default([]),
  price: moneySchema,
  compareAtPrice: moneySchema.optional(),
  stock: z
    .object({
      onHand: z.number().int().min(0).default(0),
      lowStockThreshold: z.number().int().min(0).default(3),
      backorderable: z.boolean().default(false),
    })
    .default({ onHand: 0, lowStockThreshold: 3, backorderable: false }),
  weightGrams: z.number().min(0).optional(),
  imagePublicIds: z.array(z.string().trim()).default([]),
  status: z.enum(['active', 'inactive']).default('active'),
  position: z.number().int().min(0).default(0),
});

export const productImageSchema = z.object({
  publicId: z.string().trim().min(1),
  alt: z.string().trim().max(200).default(''),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  blurDataUrl: z.string().optional(),
  position: z.number().int().min(0).default(0),
});

export const createProductSchema = z.object({
  title: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80)
    .optional(),
  subtitle: z.string().trim().max(300).optional(),
  description: z.string().trim().max(20000).optional(),
  categoryId: objectIdSchema,
  status: z.enum(['draft', 'active', 'archived']).default('draft'),

  /**
   * The flat shape a form produces — `{ roast: 'medium', weight_g: 250 }`. It is
   * validated against the category's effective attribute set at runtime and projected
   * into the stored typed array; `z.unknown()` here is not laxness, it is the correct
   * static type for something whose schema is not known until the category is read.
   */
  attributes: z.record(z.string(), z.unknown()).default({}),

  variantAxes: z.array(z.string().trim().toLowerCase()).max(4).default([]),
  variants: z.array(variantInputSchema).max(100).default([]),
  images: z.array(productImageSchema).max(24).default([]),
});

export const updateProductSchema = createProductSchema.partial().omit({ categoryId: true });

/** Recategorising re-validates every attribute, so it is its own operation. */
export const recategoriseProductSchema = z.object({ categoryId: objectIdSchema });

export const generateVariantsSchema = z.object({
  axes: z
    .array(
      z.object({
        key: z.string().trim().toLowerCase(),
        values: z.array(z.string().trim()).min(1),
      }),
    )
    .min(1)
    .max(4),
  /** Preview the count without writing anything. */
  dryRun: z.boolean().default(false),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type VariantInput = z.infer<typeof variantInputSchema>;
