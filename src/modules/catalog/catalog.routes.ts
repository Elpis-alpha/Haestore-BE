import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import { param } from '../../middleware/validate.js';
import { isFilterableType } from './attribute-types.js';
import { Category } from './category.model.js';
import { getCategoryByPath } from './category.service.js';
import { getProductBySlug } from './product.service.js';
import {
  globalFilterableAttributes,
  resolveEffectiveAttributes,
  type EffectiveAttribute,
} from './effective-attributes.js';
import { parsePriceRange } from '../../search/filter-expression.js';
import {
  DEFAULT_PAGE_SIZE,
  listProducts,
  MAX_PAGE_SIZE,
  SORT_KEYS,
  type SortKey,
} from '../../search/search.service.js';

export const catalogRouter = Router();

/**
 * The public catalogue.
 *
 * Listing, filtering, sorting and faceting are served by Meilisearch (ADR-003), with a
 * MongoDB fallback behind the same URL. Mongo keeps the product page and the category
 * tree.
 *
 * Two rules apply to every list endpoint, because the 2022 app broke both: a mandatory
 * field projection, and a default and maximum page size. That app's product listing
 * ran with neither, so it returned every field of every item — including image buffers
 * stored in the document — for the entire catalogue on one request.
 */

/**
 * Parameter names the listing owns.
 *
 * Everything *not* in this set is treated as a candidate attribute filter, which is
 * what lets a filter an admin invented this morning work without a deploy. The set is
 * kept in step with RESERVED_ATTRIBUTE_KEYS in attribute-types.ts, which refuses these
 * as attribute keys at definition time — so the collision is impossible by
 * construction rather than resolved here.
 */
const RESERVED_PARAMS = new Set([
  'q',
  'category',
  'sort',
  'page',
  'per_page',
  'price',
  'in_stock',
  'view',
]);

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().toLowerCase().optional(),
  /**
   * Page-based, not keyset. Meilisearch paginates by offset and bounds the depth with
   * `maxTotalHits`, so a cursor would have to be emulated on top of an offset anyway.
   * The Mongo fallback honours the same bound, which is what keeps the two engines
   * agreeing about which pages exist.
   */
  page: z.coerce.number().int().min(1).max(1000).default(1),
  per_page: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  sort: z.enum(SORT_KEYS as [SortKey, ...SortKey[]]).optional(),
  price: z.string().optional(),
  in_stock: z.coerce.boolean().optional(),
});

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
      // Filterable in intent *and* satisfiable in type. The same guard derives
      // Meilisearch's filterableAttributes, so the panel can never offer a control the
      // index has no way to answer.
      filters: set.attributes
        .filter((a) => a.isFilterable && isFilterableType(a.type))
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

/**
 * The storefront listing.
 *
 * Every parameter that is not reserved is offered to the filter builder as a candidate
 * attribute filter, which is the mechanism the whole rebuild is named for: an admin
 * defines "Roast" this morning and `?roast=dark` works this afternoon, with no code
 * here naming it.
 *
 * Nothing from the query string reaches Meilisearch's filter DSL without first being
 * matched against the category's own attribute definitions — see
 * search/filter-expression.ts, which is where that boundary is enforced and tested.
 */
catalogRouter.get('/products', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    throw badRequest('One or more query parameters are not valid.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const q = parsed.data;

  let categoryId: string | null = null;
  let attributes: EffectiveAttribute[];

  if (q.category) {
    const category = await Category.findOne({ path: q.category, status: 'active' })
      .select('_id')
      .lean();
    if (!category) throw notFound('Category not found.');
    categoryId = String(category._id);
    attributes = (await resolveEffectiveAttributes(categoryId)).attributes;
  } else {
    // An unscoped listing still gets a panel: the union of every live filterable
    // definition, which is exactly what any product in the shop could be filtered by.
    attributes = await globalFilterableAttributes();
  }

  // Anything the listing does not own is a candidate attribute filter. Unknown keys are
  // reported back rather than rejected, so a bookmark that outlived its attribute keeps
  // working and says what it lost.
  const attributeParams: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (RESERVED_PARAMS.has(key)) continue;
    if (typeof value === 'string' || Array.isArray(value)) {
      attributeParams[key] = value as string | string[];
    }
  }

  const result = await listProducts({
    ...(q.q ? { q: q.q } : {}),
    categoryId,
    attributes,
    attributeParams,
    price: parsePriceRange(q.price),
    ...(q.in_stock ? { inStock: true } : {}),
    // Relevance is only meaningful with a query, so an unsearched listing defaults to
    // newest rather than to Meilisearch's internal ordering, which would look arbitrary.
    sort: q.sort ?? (q.q ? 'relevance' : 'newest'),
    page: q.page,
    perPage: q.per_page,
  });

  res.json(result);
});

catalogRouter.get('/products/:slug', async (req, res) => {
  const product = await getProductBySlug(param(req, 'slug'));
  const set = await resolveEffectiveAttributes(String(product.category));

  // Attributes are already denormalised with their display values, so the specification
  // table needs no definition lookup. The effective set only supplies grouping order.
  const groupOrder = new Map(set.attributes.map((a, i) => [a.key, i]));
  const labels = new Map(set.attributes.map((a) => [a.key, a.label]));

  res.json({
    data: {
      ...product,
      // Each with its definition's current label, so the specification table names every
      // row in the admin's words — not only the filterable ones the category endpoint lists.
      attributes: [...product.attributes]
        .sort((a, b) => (groupOrder.get(a.key) ?? 999) - (groupOrder.get(b.key) ?? 999))
        .map((attribute) => {
          const label = labels.get(attribute.key);
          return label ? { ...attribute, label } : attribute;
        }),
      /**
       * Each axis this product sells along, with its label and its options' labels and
       * swatches. A variant's `axisValues` carry the admin's slugs — `whole-bean` — and
       * until Phase 8 the product page recovered names from the category's *filter* list,
       * which omits any axis that is not filterable and fell back to prettifying the slug.
       * The effective set is already loaded above and cached by version, so this costs
       * nothing and closes the gap FRONTEND.md recorded.
       */
      axes: product.variantAxes.flatMap((key) => {
        const attribute = set.attributes.find((a) => a.key === key);
        if (!attribute) return [];
        return [
          {
            key,
            label: attribute.label,
            ...(attribute.unit ? { unit: attribute.unit } : {}),
            options: attribute.options.map((option) => ({
              value: option.value,
              label: option.label,
              ...(option.swatchHex ? { swatchHex: option.swatchHex } : {}),
            })),
          },
        ];
      }),
      // Internal review state is never part of a public response.
      validationIssues: undefined,
      needsAttention: undefined,
    },
  });
});
