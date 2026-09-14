import { describe, expect, it } from 'vitest';
import { updateAttributeDefinitionSchema } from '../modules/catalog/attribute-definition.schema.js';
import { updateCategorySchema } from '../modules/catalog/category.schema.js';
import { updateProductSchema } from '../modules/catalog/product.schema.js';

/**
 * A PATCH carries what it names and nothing else.
 *
 * Before Phase 8 each of these parsed a one-field body into a body with every create-time
 * default filled in — `{ title }` became `{ title, status: 'draft', attributes: {},
 * variants: [], images: [] }`. See lib/zod-patch.ts.
 */
describe('update schemas', () => {
  it('leave an omitted product field omitted, rather than resetting it', () => {
    expect(updateProductSchema.parse({ title: 'Renamed' })).toEqual({ title: 'Renamed' });
  });

  it('leave an omitted category field omitted', () => {
    expect(updateCategorySchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('leave an omitted attribute field omitted', () => {
    expect(updateAttributeDefinitionSchema.parse({ label: 'Renamed' })).toEqual({
      label: 'Renamed',
    });
  });

  it('still validate what is sent, and still refuse the permanent fields', () => {
    expect(updateProductSchema.safeParse({ status: 'published' }).success).toBe(false);
    expect(updateAttributeDefinitionSchema.parse({ key: 'renamed', label: 'x' })).toEqual({
      label: 'x',
    });
    expect(updateCategorySchema.parse({ parent: null, name: 'x' })).toEqual({ name: 'x' });
  });
});
