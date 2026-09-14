import { z } from 'zod';
import { objectIdSchema } from '../catalog/category.schema.js';

/**
 * The storefront composer's vocabulary.
 *
 * The same shape of decision as the attribute types: an admin composes pages freely, but
 * not the *kinds* of section, because each kind needs a renderer, a data source and a
 * form, and those cannot be invented at runtime. Four kinds cover the front of a small
 * shop; a fifth is a code change, which is the right cost for one.
 */

export const STOREFRONT_HANDLES = ['home'] as const;
export type StorefrontHandle = (typeof STOREFRONT_HANDLES)[number];

export const SECTION_KINDS = ['hero', 'shelves', 'product-row', 'note'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export const MAX_SECTIONS = 12;
export const PRODUCT_ROW_SOURCES = ['newest', 'category', 'handpicked'] as const;

/**
 * Whether a string an admin typed is a path on this site, and nothing else.
 *
 * A published layout puts its links on the front page of the shop, in front of every
 * visitor, so a link field is an open-redirect and script-injection surface with an admin
 * session as the only thing standing in front of it. Allowing only same-site paths closes
 * both: `javascript:` and `https://` fail the leading slash, and the two spellings that
 * start with one and still leave the site are refused by name —
 *
 * - `//evil.test` is protocol-relative: a browser resolves it to another origin.
 * - `/\evil.test` is the same thing, because browsers treat a backslash as a slash in
 *   the scheme-relative position. So is `/<tab>/evil.test`, because the URL parser strips
 *   tabs and newlines before it resolves anything.
 *
 * The final check resolves the path against a placeholder origin and requires the origin
 * to survive, which catches whatever spelling the first three did not think of.
 */
export function isInternalPath(value: string): boolean {
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  // Backslashes, whitespace and control characters have no business in a path an admin
  // types, and each of them is a way to make "/" mean something else to a browser.
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    return new URL(value, 'https://haestore.invalid').origin === 'https://haestore.invalid';
  } catch {
    return false;
  }
}

export const internalHrefSchema = z.string().trim().min(1).max(200).refine(isInternalPath, {
  message: 'Links on the storefront go to pages in this shop — start with "/", like /shop.',
});

const sectionIdSchema = z
  .string()
  .regex(/^[a-z0-9-]{4,40}$/, 'A section id is 4–40 lowercase letters, digits or hyphens.');

const linkSchema = z.object({
  label: z.string().trim().min(1).max(40),
  href: internalHrefSchema,
});

export const heroSectionSchema = z.object({
  id: sectionIdSchema,
  kind: z.literal('hero'),
  heading: z.string().trim().min(1).max(120),
  body: z.string().trim().max(400).default(''),
  primary: linkSchema,
  secondary: linkSchema.optional(),
});

export const shelvesSectionSchema = z.object({
  id: sectionIdSchema,
  kind: z.literal('shelves'),
  title: z.string().trim().min(1).max(80),
  note: z.string().trim().max(160).default(''),
  /** Empty means every top-level shelf, in the tree's own order. */
  categoryIds: z.array(objectIdSchema).max(12).default([]),
});

export const productRowSectionSchema = z.object({
  id: sectionIdSchema,
  kind: z.literal('product-row'),
  title: z.string().trim().min(1).max(80),
  note: z.string().trim().max(160).default(''),
  source: z.enum(PRODUCT_ROW_SOURCES),
  /** Required when `source` is `category`. */
  categoryId: objectIdSchema.optional(),
  /** Required when `source` is `handpicked`, and rendered in this order. */
  productIds: z.array(objectIdSchema).max(12).default([]),
  limit: z.number().int().min(3).max(12).default(6),
});

export const noteSectionSchema = z.object({
  id: sectionIdSchema,
  kind: z.literal('note'),
  heading: z.string().trim().max(80).default(''),
  body: z.string().trim().min(1).max(1000),
});

export const sectionSchema = z.discriminatedUnion('kind', [
  heroSectionSchema,
  shelvesSectionSchema,
  productRowSectionSchema,
  noteSectionSchema,
]);

export type Section = z.infer<typeof sectionSchema>;
export type ProductRowSection = z.infer<typeof productRowSectionSchema>;

/**
 * The layout as a whole.
 *
 * The cross-field rules live here rather than on each section schema so the discriminated
 * union stays a union of plain objects, which is what both Zod and the OpenAPI generator
 * handle without surprises.
 */
export const sectionsSchema = z
  .array(sectionSchema)
  .max(MAX_SECTIONS)
  .superRefine((sections, ctx) => {
    const seen = new Set<string>();
    sections.forEach((section, index) => {
      if (seen.has(section.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Two sections share an id.',
        });
      }
      seen.add(section.id);

      if (section.kind !== 'product-row') return;
      if (section.source === 'category' && !section.categoryId) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'categoryId'],
          message: 'Choose the shelf this row draws from.',
        });
      }
      if (section.source === 'handpicked' && section.productIds.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'productIds'],
          message: 'Pick at least one product for a hand-picked row.',
        });
      }
    });
  });

export const handleParamSchema = z.enum(STOREFRONT_HANDLES);

export const saveDraftSchema = z.object({
  sections: sectionsSchema,
  note: z.string().trim().max(200).default(''),
  /**
   * The draft revision this edit was made against. Two admins editing one draft is the
   * lost-update problem, and a revision in the filter turns the second save into a 409
   * instead of a silent overwrite of the first person's work.
   */
  revision: z.number().int().min(0),
});

export const publishDraftSchema = z.object({ revision: z.number().int().min(0) });

export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
