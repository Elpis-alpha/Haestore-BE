import mongoose from 'mongoose';
import { z } from 'zod';
import { escapeRegExp } from '../../lib/regex.js';
import { Category } from './category.model.js';
import { objectIdSchema } from './category.schema.js';
import { Product } from './product.model.js';

export const adminProductListQuerySchema = z.strictObject({
  status: z.enum(['draft', 'active', 'archived']).optional(),
  /** A branch, not a node: everything under the category, via the materialised ancestry. */
  categoryId: objectIdSchema.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  // Not z.coerce.boolean(), which reads the string "false" as true.
  needsAttention: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

export type AdminProductListQuery = z.infer<typeof adminProductListQuerySchema>;

/**
 * The admin product list, from MongoDB.
 *
 * Not from Meilisearch, and not only because the index holds active products alone: the
 * admin needs drafts, archived products and the validation flags, none of which are the
 * storefront's business. `q` matches a title fragment or an exact SKU — the title match is
 * an unanchored, escaped regex and therefore a scan, which is an acceptable price on a
 * list only admins read, over a catalogue measured in hundreds.
 */
export async function listProductsForAdmin(options: AdminProductListQuery) {
  const filter: Record<string, unknown> = {};
  if (options.status) filter.status = options.status;
  if (options.categoryId) {
    filter.categoryAncestors = new mongoose.Types.ObjectId(options.categoryId);
  }
  if (options.needsAttention) filter.needsAttention = true;
  if (options.q) {
    filter.$or = [
      { title: { $regex: escapeRegExp(options.q), $options: 'i' } },
      { 'variants.sku': options.q.toUpperCase() },
    ];
  }

  const [rows, total] = await Promise.all([
    Product.find(filter)
      .sort({ updatedAt: -1 })
      .skip((options.page - 1) * options.perPage)
      .limit(options.perPage)
      .select(
        'title slug status category priceRange inStock needsAttention validationIssues ' +
          'variants.status variants.stock.available images updatedAt',
      )
      .lean(),
    Product.countDocuments(filter),
  ]);

  const categoryIds = [...new Set(rows.map((row) => String(row.category)))];
  const categories = await Category.find({ _id: { $in: categoryIds } })
    .select('name path')
    .lean();
  const byId = new Map(categories.map((c) => [String(c._id), c]));

  return {
    data: rows.map((row) => {
      const category = byId.get(String(row.category));
      const active = row.variants.filter((v) => v.status === 'active');
      const image = [...row.images].sort((a, b) => a.position - b.position)[0];
      return {
        id: String(row._id),
        title: row.title,
        slug: row.slug,
        status: row.status,
        category: category
          ? { id: String(category._id), name: category.name, path: category.path }
          : null,
        priceRange:
          row.priceRange && typeof row.priceRange.min === 'number'
            ? {
                min: row.priceRange.min,
                max: row.priceRange.max ?? row.priceRange.min,
                currency: row.priceRange.currency ?? 'USD',
              }
            : null,
        inStock: row.inStock,
        variantCount: row.variants.length,
        available: active.reduce((n, v) => n + v.stock.available, 0),
        needsAttention: row.needsAttention,
        issueCount: row.validationIssues.length,
        imagePublicId: image?.publicId ?? null,
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    page: {
      page: options.page,
      perPage: options.perPage,
      total,
      totalPages: Math.max(Math.ceil(total / options.perPage), 1),
    },
  };
}
