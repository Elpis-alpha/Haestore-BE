import { Router } from 'express';
import { z } from 'zod';
import { requireStepUp } from '../../middleware/session.js';
import {
  body,
  idParam,
  param,
  query,
  validateBody,
  validateQuery,
} from '../../middleware/validate.js';
import {
  createAttributeDefinitionSchema,
  updateAttributeDefinitionSchema,
  type CreateAttributeDefinitionInput,
  type UpdateAttributeDefinitionInput,
} from './attribute-definition.schema.js';
import {
  archiveAttributeDefinition,
  attributeUsage,
  createAttributeDefinition,
  getAttributeDefinition,
  listAttributeDefinitions,
  restoreAttributeDefinition,
  updateAttributeDefinition,
} from './attribute-definition.service.js';
import {
  bindAttributeSchema,
  createCategorySchema,
  moveCategorySchema,
  suppressKeysSchema,
  updateCategorySchema,
  type BindAttributeInput,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from './category.schema.js';
import {
  bindAttribute,
  createCategory,
  deleteCategory,
  getCategoryTree,
  moveCategory,
  setSuppressedKeys,
  unbindAttribute,
  updateCategory,
} from './category.service.js';
import {
  createProductSchema,
  generateVariantsSchema,
  recategoriseProductSchema,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from './product.schema.js';
import {
  createProduct,
  deleteProduct,
  recategoriseProduct,
  updateProduct,
} from './product.service.js';
import { Product } from './product.model.js';
import {
  adminProductListQuerySchema,
  listProductsForAdmin,
  type AdminProductListQuery,
} from './admin-product.service.js';
import { resolveEffectiveAttributes } from './effective-attributes.js';
import { planVariantGrid } from './variants.js';
import { notFound } from '../../lib/errors.js';

/**
 * The admin catalogue console.
 *
 * Gated by `requireRole('admin')` on the admin router it is mounted under — once, above
 * every admin router, rather than here. Phase 2 put the gate on this router, which was
 * right while it was the only one; see admin/admin.routes.ts for why it moved.
 */
export const adminCatalogRouter: Router = Router();

/* -------------------------------------------------------- attribute definitions -- */

adminCatalogRouter.get(
  '/attributes',
  validateQuery(z.object({ includeArchived: z.coerce.boolean().default(false) })),
  async (req, res) => {
    const { includeArchived } = query<{ includeArchived: boolean }>(req);
    res.json({ data: await listAttributeDefinitions({ includeArchived }) });
  },
);

adminCatalogRouter.post(
  '/attributes',
  validateBody(createAttributeDefinitionSchema),
  async (req, res) => {
    res
      .status(201)
      .json({ data: await createAttributeDefinition(body<CreateAttributeDefinitionInput>(req)) });
  },
);

/** Declared before `/attributes/:id`, which would otherwise read "usage" as an id. */
adminCatalogRouter.get('/attributes/usage', async (_req, res) => {
  res.json({ data: await attributeUsage() });
});

adminCatalogRouter.get('/attributes/:id', async (req, res) => {
  res.json({ data: await getAttributeDefinition(idParam(req)) });
});

adminCatalogRouter.patch(
  '/attributes/:id',
  validateBody(updateAttributeDefinitionSchema),
  async (req, res) => {
    res.json({
      data: await updateAttributeDefinition(
        idParam(req),
        body<UpdateAttributeDefinitionInput>(req),
      ),
    });
  },
);

// Archive, not delete. Products keep values keyed by definitions no longer offered.
adminCatalogRouter.post('/attributes/:id/archive', async (req, res) => {
  res.json({ data: await archiveAttributeDefinition(idParam(req)) });
});

adminCatalogRouter.post('/attributes/:id/restore', async (req, res) => {
  res.json({ data: await restoreAttributeDefinition(idParam(req)) });
});

/* ------------------------------------------------------------------ categories -- */

adminCatalogRouter.get('/categories', async (_req, res) => {
  res.json({ data: await getCategoryTree() });
});

adminCatalogRouter.post('/categories', validateBody(createCategorySchema), async (req, res) => {
  res.status(201).json({ data: await createCategory(body<CreateCategoryInput>(req)) });
});

adminCatalogRouter.patch(
  '/categories/:id',
  validateBody(updateCategorySchema),
  async (req, res) => {
    res.json({ data: await updateCategory(idParam(req), body<UpdateCategoryInput>(req)) });
  },
);

/** Reparenting cascades through descendants and products, so it is not part of PATCH. */
adminCatalogRouter.post(
  '/categories/:id/move',
  validateBody(moveCategorySchema),
  async (req, res) => {
    res.json({
      data: await moveCategory(idParam(req), body<{ parent: string | null }>(req).parent),
    });
  },
);

/**
 * Behind step-up, because it cannot be undone.
 *
 * `requireRole` on the router answers "is this an admin". This answers "is this admin
 * *here, now*" — a session left open on an unattended laptop is a valid session, and
 * the twelve-hour window is what stops it being enough to delete a branch of the
 * catalogue. It responds 403 STEP_UP_REQUIRED rather than 401, so the client re-verifies
 * a code **without losing the session**, and whatever the person was doing survives.
 */
adminCatalogRouter.delete('/categories/:id', requireStepUp(), async (req, res) => {
  await deleteCategory(idParam(req));
  res.status(204).end();
});

adminCatalogRouter.post(
  '/categories/:id/attributes',
  validateBody(bindAttributeSchema),
  async (req, res) => {
    res.json({ data: await bindAttribute(idParam(req), body<BindAttributeInput>(req)) });
  },
);

adminCatalogRouter.delete('/categories/:id/attributes/:key', async (req, res) => {
  res.json({ data: await unbindAttribute(idParam(req), param(req, 'key')) });
});

adminCatalogRouter.put(
  '/categories/:id/suppressed',
  validateBody(suppressKeysSchema),
  async (req, res) => {
    res.json({ data: await setSuppressedKeys(idParam(req), body<{ keys: string[] }>(req).keys) });
  },
);

/**
 * What the product form renders from: every attribute that applies here, inherited
 * ones included, each saying which ancestor contributed it.
 */
adminCatalogRouter.get('/categories/:id/effective-attributes', async (req, res) => {
  res.json({ data: await resolveEffectiveAttributes(idParam(req)) });
});

/* -------------------------------------------------------------------- products -- */

adminCatalogRouter.get(
  '/products',
  validateQuery(adminProductListQuerySchema),
  async (req, res) => {
    res.json(await listProductsForAdmin(query<AdminProductListQuery>(req)));
  },
);

adminCatalogRouter.post('/products', validateBody(createProductSchema), async (req, res) => {
  res.status(201).json({ data: await createProduct(body<CreateProductInput>(req)) });
});

adminCatalogRouter.get('/products/:id', async (req, res) => {
  const product = await Product.findById(idParam(req)).lean();
  if (!product) throw notFound('Product not found.');
  res.json({ data: product });
});

adminCatalogRouter.patch('/products/:id', validateBody(updateProductSchema), async (req, res) => {
  res.json({ data: await updateProduct(idParam(req), body<UpdateProductInput>(req)) });
});

adminCatalogRouter.post(
  '/products/:id/category',
  validateBody(recategoriseProductSchema),
  async (req, res) => {
    res.json({
      data: await recategoriseProduct(idParam(req), body<{ categoryId: string }>(req).categoryId),
    });
  },
);

/** Step-up, for the same reason as deleting a category. */
adminCatalogRouter.delete('/products/:id', requireStepUp(), async (req, res) => {
  await deleteProduct(idParam(req));
  res.status(204).end();
});

/**
 * Previews or produces the variant grid.
 *
 * `dryRun` exists so the admin sees the count *before* anything is created — the
 * difference between "this will make 48 variants, continue?" and discovering it
 * afterwards.
 */
adminCatalogRouter.post(
  '/products/:id/variants/generate',
  validateBody(generateVariantsSchema),
  async (req, res) => {
    const product = await Product.findById(idParam(req));
    if (!product) throw notFound('Product not found.');

    const input = body<{ axes: { key: string; values: string[] }[]; dryRun: boolean }>(req);
    const set = await resolveEffectiveAttributes(String(product.category));
    const plan = planVariantGrid(input.axes, product.title, set);

    if (input.dryRun) {
      res.json({ data: { count: plan.count, warn: plan.warn, variants: plan.variants } });
      return;
    }

    // Existing rows are matched by grid position, so regenerating after adding a value
    // keeps the prices and stock already entered against the rows that still exist.
    const existing = new Map(
      product.variants.map((v) => [v.axisValues.map((a) => `${a.key}:${a.value}`).join('|'), v]),
    );
    const first = product.variants[0];
    const fallbackPrice = first
      ? { amount: first.price.amount, currency: first.price.currency }
      : { amount: 0, currency: 'USD' };

    const variants = plan.variants.map((generated, index) => {
      const key = generated.axisValues.map((a) => `${a.key}:${a.value}`).join('|');
      const kept = existing.get(key);
      return {
        sku: kept?.sku ?? generated.sku,
        axisValues: generated.axisValues,
        price: kept ? { amount: kept.price.amount, currency: kept.price.currency } : fallbackPrice,
        ...(kept?.compareAtPrice
          ? {
              compareAtPrice: {
                amount: kept.compareAtPrice.amount,
                currency: kept.compareAtPrice.currency,
              },
            }
          : {}),
        stock: {
          onHand: kept?.stock.onHand ?? 0,
          lowStockThreshold: kept?.stock.lowStockThreshold ?? 3,
          backorderable: kept?.stock.backorderable ?? false,
        },
        ...(kept?.weightGrams != null ? { weightGrams: kept.weightGrams } : {}),
        imagePublicIds: kept ? [...kept.imagePublicIds] : [],
        status: kept?.status ?? ('active' as const),
        position: index,
      };
    });

    /**
     * Through `updateProduct`, not `product.save()`.
     *
     * Until Phase 8 this route set the variants and saved the document directly, which
     * skipped the whole write pipeline: no outbox row (so the index never learned the new
     * grid), no recomputed `priceRange` or `inStock` (so the listing card kept the old
     * ones), and no `available` maintained from `onHand` (so every generated variant was
     * unsellable until someone edited it again). Found while deciding whether the console
     * could call it.
     */
    const updated = await updateProduct(String(product._id), {
      variantAxes: input.axes.map((a) => a.key),
      variants,
    });

    res.json({ data: { count: plan.count, warn: plan.warn, product: updated } });
  },
);
