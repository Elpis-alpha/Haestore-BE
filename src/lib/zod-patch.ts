import { z } from 'zod';

/**
 * The PATCH form of a create schema: every field optional, **and no defaults**.
 *
 * `createSchema.partial()` looks like this and is not. In Zod 4 a field's `.default()`
 * still fires inside `.optional()`, so a partial of a create schema fills every omitted
 * field back in with its create-time default — and a PATCH that means "change the title"
 * arrives at the service as "change the title, set status to draft, and replace the
 * attributes, variants and images with nothing". Nothing throws; the product is quietly
 * unpublished and emptied.
 *
 * That shipped in Phase 2 on all three catalogue update schemas and went unnoticed because
 * nothing sent a partial body until the admin console did. The first Phase 8 test that
 * PATCHed an attribute's label found it, as a 400: the reset options list failed the
 * "a select needs options" check. On a product the same bug would have succeeded.
 *
 * Removing the defaults at the top level is enough. A nested object that *is* supplied is
 * replaced whole, so its inner defaults describe the object being sent, which is right.
 */

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner extends z.ZodType> ? Inner : T;

export type PatchShape<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<WithoutDefault<T[K]> & z.ZodType>;
};

export function patchOf<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): z.ZodObject<PatchShape<T>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const bare =
      field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : (field as z.ZodType);
    shape[key] = bare.optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<T>>;
}
