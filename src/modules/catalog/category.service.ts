import type { Types } from 'mongoose';
import mongoose, { type ClientSession } from 'mongoose';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { slugify } from '../../lib/slug.js';
import { AttributeDefinition } from './attribute-definition.model.js';
import { Category, type CategoryDoc } from './category.model.js';
import { Product } from './product.model.js';
import { bumpTreeVersion } from './catalog-versions.js';
import { appendOutbox } from '../../search/outbox.model.js';
import type {
  BindAttributeInput,
  CreateCategoryInput,
  UpdateCategoryInput,
} from './category.schema.js';

/**
 * The category tree.
 *
 * Ancestry is materialised (see the model), which makes reads trivial and writes the
 * interesting part: renaming a node rewrites its descendants' paths, and moving one
 * rewrites their ancestry too, plus the denormalised `categoryAncestors` on every
 * product beneath it. All of that happens in one transaction, because a half-moved
 * subtree is a catalogue where some products are reachable from a branch and others
 * are not.
 */

async function assertPathIsFree(path: string, exceptId?: Types.ObjectId): Promise<void> {
  const clash = await Category.findOne({ path, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .select('_id name')
    .lean();
  if (clash) {
    throw conflict(`Another category already lives at "${path}".`);
  }
}

const joinPath = (parentPath: string | null, slug: string) =>
  parentPath ? `${parentPath}/${slug}` : slug;

export async function createCategory(input: CreateCategoryInput): Promise<CategoryDoc> {
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw badRequest('That name does not produce a usable slug.');

  let parentDoc = null;
  if (input.parent) {
    parentDoc = await Category.findById(input.parent).lean();
    if (!parentDoc) throw badRequest('The parent category does not exist.');
  }

  const path = joinPath(parentDoc?.path ?? null, slug);
  await assertPathIsFree(path);

  const created = await Category.create({
    ...input,
    slug,
    path,
    parent: parentDoc?._id ?? null,
    depth: parentDoc ? parentDoc.depth + 1 : 0,
    // Ancestors include self. The id does not exist until after create, so it is
    // appended in a second step rather than guessed.
    ancestors: parentDoc ? [...parentDoc.ancestors] : [],
  });

  created.ancestors = [...created.ancestors, created._id];
  await created.save();

  await bumpTreeVersion();
  return created;
}

/**
 * Rewrites path, ancestors and depth for a node and everything under it.
 *
 * The subtree is loaded once and walked in memory rather than queried per level: the
 * `ancestors` index gives the whole set in a single read, and a tree deep enough for
 * that to be large is not a tree a shop has.
 */
async function recomputeSubtree(root: CategoryDoc, session: ClientSession): Promise<void> {
  const descendants = await Category.find({ ancestors: root._id, _id: { $ne: root._id } })
    .session(session)
    .sort({ depth: 1 });

  const childrenOf = new Map<string, CategoryDoc[]>();
  for (const node of descendants) {
    const key = String(node.parent);
    const siblings = childrenOf.get(key) ?? [];
    siblings.push(node);
    childrenOf.set(key, siblings);
  }

  const touched: CategoryDoc[] = [];
  const walk = (node: CategoryDoc) => {
    for (const child of childrenOf.get(String(node._id)) ?? []) {
      child.path = joinPath(node.path, child.slug);
      child.ancestors = [...node.ancestors, child._id];
      child.depth = node.depth + 1;
      touched.push(child);
      walk(child);
    }
  };
  walk(root);

  for (const node of touched) {
    await node.save({ session });
  }

  // Products carry their category's ancestry so a branch listing never has to join.
  // Those copies are only correct until the tree moves, so they move with it.
  const affected = [root, ...touched];
  if (affected.length > 0) {
    await Product.bulkWrite(
      affected.map((node) => ({
        updateMany: {
          filter: { category: node._id },
          update: { $set: { categoryAncestors: node.ancestors } },
        },
      })),
      { session },
    );
  }
}

export async function updateCategory(id: string, input: UpdateCategoryInput): Promise<CategoryDoc> {
  const category = await Category.findById(id);
  if (!category) throw notFound('Category not found.');

  const nextSlug = input.slug ?? (input.name ? slugify(input.name) : category.slug);
  const slugChanged = nextSlug !== category.slug;

  category.set(input);
  category.slug = nextSlug;

  if (!slugChanged) {
    await category.save();
    await bumpTreeVersion();
    return category;
  }

  const parent = category.parent ? await Category.findById(category.parent).lean() : null;
  const nextPath = joinPath(parent?.path ?? null, nextSlug);
  await assertPathIsFree(nextPath, category._id);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      category.path = nextPath;
      await category.save({ session });
      await recomputeSubtree(category, session);
      // One row for the whole branch. Every product beneath this node just had its
      // denormalised `categoryAncestors` rewritten, so every one of their index
      // documents is stale — but a row per product would add an unbounded number of
      // inserts to a transaction that is already rewriting them all, and a transaction
      // that large exceeds its lifetime limit and rolls the rename back.
      await appendOutbox(session, {
        kind: 'category-branch',
        entityId: String(category._id),
        op: 'upsert',
      });
    });
  } finally {
    await session.endSession();
  }

  await bumpTreeVersion();
  return category;
}

export async function moveCategory(id: string, parentId: string | null): Promise<CategoryDoc> {
  const category = await Category.findById(id);
  if (!category) throw notFound('Category not found.');

  let parent = null;
  if (parentId) {
    parent = await Category.findById(parentId);
    if (!parent) throw badRequest('The destination category does not exist.');

    // A node cannot become its own descendant. `ancestors` includes self, so this one
    // check covers both "into itself" and "into something beneath it".
    if (parent.ancestors.some((a) => String(a) === String(category._id))) {
      throw badRequest('A category cannot be moved inside itself.');
    }
  }

  const nextPath = joinPath(parent?.path ?? null, category.slug);
  await assertPathIsFree(nextPath, category._id);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      category.parent = parent?._id ?? null;
      category.depth = parent ? parent.depth + 1 : 0;
      category.path = nextPath;
      category.ancestors = parent ? [...parent.ancestors, category._id] : [category._id];
      await category.save({ session });
      await recomputeSubtree(category, session);
      await appendOutbox(session, {
        kind: 'category-branch',
        entityId: String(category._id),
        op: 'upsert',
      });
    });
  } finally {
    await session.endSession();
  }

  await bumpTreeVersion();
  return category;
}

export async function bindAttribute(id: string, input: BindAttributeInput): Promise<CategoryDoc> {
  const category = await Category.findById(id);
  if (!category) throw notFound('Category not found.');

  const definition = await AttributeDefinition.findById(input.defId).lean();
  if (!definition) throw badRequest('That attribute does not exist.');
  if (definition.archivedAt) throw badRequest('That attribute is archived.');

  const binding = {
    defId: definition._id,
    key: definition.key,
    required: input.required,
    order: input.order,
    ...(input.group ? { group: input.group } : {}),
  };

  const index = category.attributeBindings.findIndex((b) => b.key === definition.key);
  if (index >= 0) category.attributeBindings.splice(index, 1, binding);
  else category.attributeBindings.push(binding);

  // Binding a key here overrides any inherited suppression of it, which is what makes
  // "suppress from the parent, then rebind differently" work.
  category.suppressedKeys = category.suppressedKeys.filter((k) => k !== definition.key);

  await category.save();
  await bumpTreeVersion();
  return category;
}

export async function unbindAttribute(id: string, key: string): Promise<CategoryDoc> {
  const category = await Category.findById(id);
  if (!category) throw notFound('Category not found.');

  // `.set` rather than assigning the result of `.filter`: Mongoose tracks a
  // DocumentArray, and replacing it with a plain array loses that tracking (and does
  // not typecheck).
  category.set(
    'attributeBindings',
    category.attributeBindings.filter((b) => b.key !== key),
  );
  await category.save();
  await bumpTreeVersion();
  return category;
}

export async function setSuppressedKeys(id: string, keys: string[]): Promise<CategoryDoc> {
  const category = await Category.findById(id);
  if (!category) throw notFound('Category not found.');

  category.suppressedKeys = [...new Set(keys)];
  // Suppressing a key this node also binds is contradictory, and the binding wins —
  // otherwise the node would be asking to hide something only it provides.
  const bound = new Set(category.attributeBindings.map((b) => b.key));
  category.suppressedKeys = category.suppressedKeys.filter((k) => !bound.has(k));

  await category.save();
  await bumpTreeVersion();
  return category;
}

/**
 * Deletion is refused while anything depends on the category.
 *
 * Reassigning products automatically would silently move them into a branch with a
 * different attribute set, where their values no longer apply. That is a decision for
 * whoever is deleting, so they are told what is in the way instead.
 */
export async function deleteCategory(id: string): Promise<void> {
  const category = await Category.findById(id);
  if (!category) throw notFound('Category not found.');

  const children = await Category.countDocuments({ parent: category._id });
  if (children > 0) {
    throw conflict(
      `"${category.name}" still has ${children} sub-categories. Move or delete them first.`,
    );
  }

  const products = await Product.countDocuments({ category: category._id });
  if (products > 0) {
    throw conflict(
      `"${category.name}" still holds ${products} products. Move them to another category first.`,
    );
  }

  await category.deleteOne();
  await bumpTreeVersion();
}

export async function getCategoryTree() {
  const all = await Category.find().sort({ depth: 1, order: 1, name: 1 }).lean();

  type Node = (typeof all)[number] & { children: Node[] };
  const byId = new Map<string, Node>(all.map((c) => [String(c._id), { ...c, children: [] }]));
  const roots: Node[] = [];

  for (const node of byId.values()) {
    const parent = node.parent ? byId.get(String(node.parent)) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function getCategoryByPath(path: string) {
  const category = await Category.findOne({ path: path.toLowerCase() }).lean();
  if (!category) throw notFound('Category not found.');
  return category;
}
