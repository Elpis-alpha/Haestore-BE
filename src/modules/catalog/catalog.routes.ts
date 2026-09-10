import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import { param, query, validateQuery } from '../../middleware/validate.js';
import { Category } from './category.model.js';
import { Product } from './product.model.js';
import { getCategoryByPath } from './category.service.js';
import { getProductBySlug } from './product.service.js';
import { resolveEffectiveAttributes } from './effective-attributes.js';

export const catalogRouter = Router();

/**
 * The public catalogue.
 *
 * Storefront listing, filtering and faceting move to Meilisearch in Phase 3 (ADR-003);
 * what is here is the product page, the category tree, and a **degraded** listing that
 * keeps the shop open when the search cluster is not.
 *
 * Two rules apply to every list endpoint, because the 2022 app broke both: a mandatory
 * field projection, and a default and maximum page size. That app's product listing
 * ran with neither, so it returned every field of every item — including image buffers
 * stored in the document — for the entire catalogue on one request.
 */

/** Never send drafts, internal validation state, or the full variant array to a card. */
const CARD_PROJECTION =
  'title slug subtitle category categoryAncestors priceRange inStock images ratingAverage ratingCount createdAt';

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

const listQuerySchema = z.object({
  category: z.string().trim().toLowerCase().optional(),
  /**
   * Keyset, not `.skip(n)`. Skip re-reads and discards every preceding document, so
   * page 40 costs forty pages of work; a cursor costs one index seek at any depth. It
   * also cannot skip or duplicate a row when the catalogue changes mid-browse.
   */
  cursor: z.string().optional(),
  per_page: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  in_stock: z.coerce.boolean().optional(),
});

type ListQuery = z.infer<typeof listQuerySchema>;

catalogRouter.get('/categories', async (_req, res) => {
  const categories = await Category.find({ status: 'active' })
    .select('name slug path parent ancestors depth order description imagePublicId')
    .sort({ depth: 1, order: 1, name: 1 })
    .lean();
  res.json({ data: categories });
});

/**
 * A category by its full path, with the attributes the storefront may filter on.
 *
 * The filter panel is generated from this: the storefront has no hardcoded knowledge of
 * roast levels or glazes, so an attribute an admin defined this morning appears without
 * a deploy. That is the claim the whole rebuild exists to make good on.
 */
catalogRouter.get('/categories/by-path/*path', async (req, res) => {
  const raw = req.params.path;
  const path = (Array.isArray(raw) ? raw.join('/') : (raw ?? '')).toLowerCase();
  if (!path) throw badRequest('A category path is required.');

  const category = await getCategoryByPath(path);
  if (category.status !== 'active') throw notFound('Category not found.');

  const set = await resolveEffectiveAttributes(String(category._id));

  res.json({
    data: {
      category: {
        id: String(category._id),
        name: category.name,
        slug: category.slug,
        path: category.path,
        description: category.description,
        ancestors: category.ancestors.map(String),
      },
      // Only the filterable subset, and only what the panel needs to render.
      filters: set.attributes
        .filter((a) => a.isFilterable)
        .map((a) => ({
          key: a.key,
          label: a.label,
          type: a.type,
          filterUi: a.filterUi,
          unit: a.unit,
          options: a.options,
        })),
    },
  });
});

catalogRouter.get('/products', validateQuery(listQuerySchema), async (req, res) => {
  const q = query<ListQuery>(req);

  const filter: Record<string, unknown> = { status: 'active' };

  if (q.category) {
    const category = await Category.findOne({ path: q.category }).select('_id').lean();
    if (!category) throw notFound('Category not found.');
    // One equality predicate against the materialised ancestry covers the whole branch.
    filter.categoryAncestors = category._id;
  }
  if (q.in_stock) filter.inStock = true;

  // Every sort ends in _id so the key is total; without that tiebreak two documents
  // with the same price have an unstable order and a cursor can skip or repeat one.
  const sorts = {
    newest: { createdAt: -1, _id: -1 },
    price_asc: { 'priceRange.min': 1, _id: 1 },
    price_desc: { 'priceRange.min': -1, _id: -1 },
  } as const;
  const sort = sorts[q.sort];

  if (q.cursor) {
    if (!Types.ObjectId.isValid(q.cursor)) throw badRequest('That cursor is not valid.');
    const direction = q.sort === 'price_asc' ? '$gt' : '$lt';
    filter._id = { [direction]: new Types.ObjectId(q.cursor) };
  }

  // One extra row answers "is there a next page" without a second count query.
  const rows = await Product.find(filter)
    .select(CARD_PROJECTION)
    .sort(sort)
    .limit(q.per_page + 1)
    .lean();

  const hasMore = rows.length > q.per_page;
  const data = hasMore ? rows.slice(0, q.per_page) : rows;

  res.json({
    data,
    page: {
      perPage: q.per_page,
      hasMore,
      nextCursor: hasMore ? String(data[data.length - 1]?._id) : null,
      degraded: true,
    },
  });
});

catalogRouter.get('/products/:slug', async (req, res) => {
  const product = await getProductBySlug(param(req, 'slug'));
  const set = await resolveEffectiveAttributes(String(product.category));

  // Attributes are already denormalised with their display values, so the specification
  // table needs no definition lookup. The effective set only supplies grouping order.
  const groupOrder = new Map(set.attributes.map((a, i) => [a.key, i]));

  res.json({
    data: {
      ...product,
      attributes: [...product.attributes].sort(
        (a, b) => (groupOrder.get(a.key) ?? 999) - (groupOrder.get(b.key) ?? 999),
      ),
      // Internal review state is never part of a public response.
      validationIssues: undefined,
      needsAttention: undefined,
    },
  });
});
