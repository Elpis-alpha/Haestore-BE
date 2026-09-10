import mongoose from 'mongoose';
import { badRequest, notFound } from '../../lib/errors.js';
import { uniqueSlug } from '../../lib/slug.js';
import { Category } from './category.model.js';
import { Product, type ProductDoc } from './product.model.js';
import { currentVersions } from './catalog-versions.js';
import { resolveEffectiveAttributes, type EffectiveAttributeSet } from './effective-attributes.js';
import {
  cachedValidator,
  validateAndProject,
  type ValidationIssue,
} from './attribute-validator.js';
import { buildSku, summariseVariants } from './variants.js';
import { appendOutbox } from '../../search/outbox.model.js';
import type { CreateProductInput, UpdateProductInput, VariantInput } from './product.schema.js';

/**
 * Writing a product is one pipeline, and every write goes through all of it:
 *
 *   category -> effective attribute set -> compiled validator -> projected values
 *            -> axis check -> variant normalisation -> denormalised summary -> save
 *
 * Nothing skips a step. A product that took a shortcut is a product whose attributes
 * do not match its category, and the whole adaptable design rests on that never being
 * true.
 *
 * **Every write is a transaction, and every transaction appends to the search outbox.**
 * The transaction is not there for the product document — a single document write is
 * already atomic — it is there so the row that says "reindex this" commits with it or
 * not at all. Enqueuing after the save instead would leave a window in which a crash
 * produces a product that exists and is unfindable. See search/outbox.model.ts.
 */

async function loadSet(categoryId: string): Promise<{
  set: EffectiveAttributeSet;
  validatorKey: string;
}> {
  const versions = await currentVersions();
  const set = await resolveEffectiveAttributes(categoryId);
  return { set, validatorKey: `${versions.tree}:${versions.defs}:${categoryId}` };
}

/**
 * Normalises the submitted variants against the declared axes.
 *
 * Every variant must position itself on exactly the declared axes — no more, no fewer.
 * A variant missing an axis has no defined position in the grid, and one carrying an
 * extra axis claims a dimension the product says it does not sell along. Both are
 * silent data corruption if allowed through, and both are trivial to produce by
 * editing `variantAxes` and forgetting the variants.
 */
function normaliseVariants(
  variants: VariantInput[],
  variantAxes: string[],
  set: EffectiveAttributeSet,
): VariantInput[] {
  const axisSet = new Set(variantAxes);

  for (const key of variantAxes) {
    const attribute = set.attributes.find((a) => a.key === key);
    if (!attribute) throw badRequest(`"${key}" is not an attribute of this category.`);
    if (!attribute.isAxisEligible) {
      throw badRequest(`"${attribute.label}" cannot be a variant axis.`);
    }
  }

  const seen = new Set<string>();

  return variants.map((variant, index) => {
    const keys = variant.axisValues.map((a) => a.key);

    const missing = variantAxes.filter((k) => !keys.includes(k));
    if (missing.length > 0) {
      throw badRequest(`Variant ${index + 1} is missing a value for: ${missing.join(', ')}.`);
    }
    const extra = keys.filter((k) => !axisSet.has(k));
    if (extra.length > 0) {
      throw badRequest(
        `Variant ${index + 1} has values for axes this product does not use: ${extra.join(', ')}.`,
      );
    }

    // Axis values are ordered to match `variantAxes` so two variants at the same grid
    // position produce the same fingerprint regardless of submission order.
    const ordered = variantAxes.map((key) => {
      const found = variant.axisValues.find((a) => a.key === key);
      if (!found) throw badRequest(`Variant ${index + 1} is missing "${key}".`);
      return { key, value: found.value };
    });

    const fingerprint = ordered.map((a) => `${a.key}:${a.value}`).join('|');
    if (seen.has(fingerprint)) {
      throw badRequest(
        `Two variants occupy the same position in the grid (${fingerprint || 'the single default variant'}).`,
      );
    }
    seen.add(fingerprint);

    return { ...variant, axisValues: ordered };
  });
}

/**
 * Turns the submitted stock figure into the stored triple.
 *
 * `available` is stored rather than derived (see the model), so it has to be
 * maintained here. Reservations belong to the checkout path and are preserved across
 * an admin edit — an admin lowering `onHand` below what is already reserved does not
 * cancel those orders, so `available` floors at zero and the discrepancy is left for
 * the reconciliation sweep rather than papered over.
 */
function stockFor(input: VariantInput['stock'], reserved: number) {
  return {
    onHand: input.onHand,
    reserved,
    available: Math.max(0, input.onHand - reserved),
    lowStockThreshold: input.lowStockThreshold,
    backorderable: input.backorderable,
  };
}

type BuildResult = {
  attributes: ReturnType<typeof validateAndProject>['attributes'];
  issues: ValidationIssue[];
  variants: ReturnType<typeof normaliseVariants>;
  summary: ReturnType<typeof summariseVariants>;
};

async function buildFrom(
  categoryId: string,
  attributes: Record<string, unknown>,
  variantAxes: string[],
  variants: VariantInput[],
  reservedBySku: Map<string, number>,
  skuPrefix: string,
): Promise<BuildResult & { set: EffectiveAttributeSet }> {
  const { set, validatorKey } = await loadSet(categoryId);
  const validator = cachedValidator(validatorKey, set);

  const projected = validateAndProject(attributes, set, validator);
  const normalised = normaliseVariants(variants, variantAxes, set);

  const withStock = normalised.map((v) => ({
    ...v,
    // A SKU the admin did not supply is derived from the title and the variant's grid
    // position, which is deterministic: regenerating a grid does not renumber the rows
    // that already existed.
    sku: v.sku ?? buildSku(skuPrefix, v.axisValues),
    stock: stockFor(v.stock, reservedBySku.get(v.sku ?? '') ?? 0),
  }));

  return {
    set,
    attributes: projected.attributes,
    issues: projected.issues,
    variants: withStock,
    summary: summariseVariants(
      withStock.map((v) => ({
        price: v.price,
        status: v.status,
        stock: { available: v.stock.available, backorderable: v.stock.backorderable },
      })),
    ),
  };
}

export async function createProduct(input: CreateProductInput): Promise<ProductDoc> {
  const category = await Category.findById(input.categoryId).lean();
  if (!category) throw badRequest('That category does not exist.');

  const built = await buildFrom(
    input.categoryId,
    input.attributes,
    input.variantAxes,
    input.variants,
    new Map(),
    input.title,
  );

  const slug = await uniqueSlug(input.slug ?? input.title, async (candidate) => {
    return (await Product.countDocuments({ slug: candidate })) > 0;
  });

  return inWriteTransaction(async (session) => {
    // The array form, because that is the only overload of `create` that accepts a
    // session — the single-document form silently ignores it and writes outside the
    // transaction.
    const [product] = await Product.create(
      [
        {
          title: input.title,
          slug,
          subtitle: input.subtitle,
          description: input.description,
          category: category._id,
          categoryAncestors: category.ancestors,
          status: input.status,
          attributes: built.attributes,
          variantAxes: input.variantAxes,
          variants: built.variants,
          images: input.images,
          priceRange: built.summary.priceRange ?? undefined,
          inStock: built.summary.inStock,
          needsAttention: built.issues.length > 0,
          validationIssues: built.issues,
          publishedAt: input.status === 'active' ? new Date() : undefined,
        },
      ],
      { session },
    );
    if (!product) throw new Error('product create returned nothing');

    applyDefaultVariant(product);
    await product.save({ session });
    return product;
  });
}

export async function updateProduct(id: string, input: UpdateProductInput): Promise<ProductDoc> {
  const product = await Product.findById(id);
  if (!product) throw notFound('Product not found.');

  // Reservations live on the stored variants, not in the request. Carrying them across
  // by SKU means an admin edit cannot silently release stock that belongs to an order
  // already placed.
  const reservedBySku = new Map(
    product.variants.map((v) => [v.sku, v.stock.reserved] as [string, number]),
  );

  const attributes =
    input.attributes ?? Object.fromEntries(product.attributes.map((a) => [a.key, storedValue(a)]));
  const variantAxes = input.variantAxes ?? product.variantAxes;
  const variants =
    input.variants ??
    product.variants.map((v) => ({
      sku: v.sku,
      axisValues: v.axisValues.map((a) => ({ key: a.key, value: a.value })),
      price: { amount: v.price.amount, currency: v.price.currency },
      ...(v.compareAtPrice
        ? {
            compareAtPrice: {
              amount: v.compareAtPrice.amount,
              currency: v.compareAtPrice.currency,
            },
          }
        : {}),
      stock: {
        onHand: v.stock.onHand,
        lowStockThreshold: v.stock.lowStockThreshold ?? 3,
        backorderable: v.stock.backorderable ?? false,
      },
      ...(v.weightGrams != null ? { weightGrams: v.weightGrams } : {}),
      imagePublicIds: v.imagePublicIds,
      status: v.status,
      position: v.position,
    }));

  const built = await buildFrom(
    String(product.category),
    attributes,
    variantAxes,
    variants,
    reservedBySku,
    input.title ?? product.title,
  );

  if (input.title !== undefined) product.title = input.title;
  if (input.subtitle !== undefined) product.subtitle = input.subtitle;
  if (input.description !== undefined) product.description = input.description;
  if (input.images !== undefined) product.set('images', input.images);
  if (input.status !== undefined) {
    if (input.status === 'active' && !product.publishedAt) product.publishedAt = new Date();
    product.status = input.status;
  }

  product.set('attributes', built.attributes);
  product.set('variantAxes', variantAxes);
  product.set('variants', built.variants);
  product.set('priceRange', built.summary.priceRange ?? undefined);
  product.inStock = built.summary.inStock;
  product.needsAttention = built.issues.length > 0;
  product.set('validationIssues', built.issues);
  applyDefaultVariant(product);

  return inWriteTransaction(async (session) => {
    await product.save({ session });
    return product;
  });
}

/** Reverses the projection, so an update that omits `attributes` keeps what is stored. */
function storedValue(attribute: ProductDoc['attributes'][number]): unknown {
  switch (attribute.type) {
    case 'multiselect':
      return attribute.valueStrings;
    case 'number':
      return attribute.valueNumber;
    case 'boolean':
      return attribute.valueBool;
    case 'dimension':
      return attribute.valueDim;
    default:
      return attribute.valueString;
  }
}

/**
 * Moving a product between categories re-validates it against the destination's
 * attribute set, because the two sets are generally different — that is the entire
 * premise of an adaptable catalogue. In lenient mode the product moves and arrives
 * flagged; in strict mode the move is refused.
 */
export async function recategoriseProduct(id: string, categoryId: string): Promise<ProductDoc> {
  const product = await Product.findById(id);
  if (!product) throw notFound('Product not found.');

  const category = await Category.findById(categoryId).lean();
  if (!category) throw badRequest('That category does not exist.');

  const flat = Object.fromEntries(product.attributes.map((a) => [a.key, storedValue(a)]));
  const { set, validatorKey } = await loadSet(categoryId);
  const validator = cachedValidator(validatorKey, set);

  // Values whose keys the destination does not bind are dropped rather than carried as
  // orphans. The admin is told which, so the loss is visible rather than discovered
  // later on an empty specification table.
  const boundKeys = new Set(set.attributes.map((a) => a.key));
  const dropped = Object.keys(flat).filter((k) => !boundKeys.has(k));
  for (const key of dropped) delete flat[key];

  const projected = validateAndProject(flat, set, validator);

  product.category = category._id;
  product.set('categoryAncestors', category.ancestors);
  product.set('attributes', projected.attributes);

  const issues: ValidationIssue[] = [
    ...projected.issues,
    ...dropped.map((key) => ({
      key,
      code: 'unknown_attribute' as const,
      message: `"${key}" was dropped: the new category does not use it.`,
    })),
  ];
  product.needsAttention = issues.length > 0;
  product.set('validationIssues', issues);

  return inWriteTransaction(async (session) => {
    await product.save({ session });
    return product;
  });
}

/**
 * The variant a bare product URL selects. Lowest-positioned active variant, else the
 * first.
 *
 * Mutates in memory and does not save. It used to save on its own, which meant every
 * create was two writes and the second one sat outside whatever transaction the first
 * belonged to — so the outbox row could commit against a product whose default variant
 * had not been chosen yet.
 */
function applyDefaultVariant(product: ProductDoc): void {
  const active = product.variants.filter((v) => v.status === 'active');
  const chosen = [...(active.length > 0 ? active : product.variants)].sort(
    (a, b) => a.position - b.position,
  )[0];

  const next = chosen?._id;
  if (String(product.defaultVariantId ?? '') === String(next ?? '')) return;
  product.defaultVariantId = next;
}

/**
 * Runs a product write inside a transaction and records the reindex intent with it.
 *
 * Every mutating export goes through here, so there is exactly one place where the
 * pairing of "the product changed" and "the index must be told" is expressed — and no
 * way to add a new write that forgets the second half.
 */
async function inWriteTransaction<T extends { _id: unknown }>(
  work: (session: mongoose.ClientSession) => Promise<T>,
  op: 'upsert' | 'delete' = 'upsert',
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
      await appendOutbox(session, {
        kind: 'product',
        entityId: String(result._id),
        op,
      });
    });
    // `withTransaction` either commits or throws, so this is unreachable unless the
    // callback returned without assigning — which would be a bug worth failing on.
    if (!result) throw new Error('product write transaction produced no document');
    return result;
  } finally {
    await session.endSession();
  }
}

export async function getProductBySlug(slug: string) {
  const product = await Product.findOne({ slug: slug.toLowerCase(), status: 'active' }).lean();
  if (!product) throw notFound('Product not found.');
  return product;
}

export async function deleteProduct(id: string): Promise<void> {
  const product = await Product.findById(id);
  if (!product) throw notFound('Product not found.');
  // Archive rather than delete: orders snapshot their lines, but reviews, wishlists and
  // the search index all reference the product by id.
  product.status = 'archived';

  // `delete` rather than `upsert`, although the worker would reach the same conclusion
  // from the archived status. Saying it plainly means an operator reading the outbox
  // can see a removal as a removal.
  await inWriteTransaction(async (session) => {
    await product.save({ session });
    return product;
  }, 'delete');
}
