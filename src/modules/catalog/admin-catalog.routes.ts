import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from '../../middleware/require-role.js';
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
import { resolveEffectiveAttributes } from './effective-attributes.js';
import { planVariantGrid } from './variants.js';
import { notFound } from '../../lib/errors.js';

/**
 * The admin catalogue console.
 *
 * `requireRole('admin')` is applied to the whole router on the line below, once. Not
 * per handler — that is the arrangement where one forgotten line opens the surface and
 * nothing notices.
 */
export const adminCatalogRouter = Router();

adminCatalogRouter.use(requireRole('admin'));

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

adminCatalogRouter.delete('/categories/:id', async (req, res) => {
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

adminCatalogRouter.delete('/products/:id', async (req, res) => {
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
    const fallbackPrice = product.variants[0]?.price ?? { amount: 0, currency: 'USD' };

    const merged = plan.variants.map((generated, index) => {
      const key = generated.axisValues.map((a) => `${a.key}:${a.value}`).join('|');
      const kept = existing.get(key);
      return {
        sku: kept?.sku ?? generated.sku,
        axisValues: generated.axisValues,
        price: kept?.price ?? fallbackPrice,
        stock: kept?.stock ?? { onHand: 0, reserved: 0, available: 0 },
        status: kept?.status ?? 'active',
        position: index,
      };
    });

    product.set(
      'variantAxes',
      input.axes.map((a) => a.key),
    );
    product.set('variants', merged);
    await product.save();

    res.json({ data: { count: plan.count, warn: plan.warn, product } });
  },
);
