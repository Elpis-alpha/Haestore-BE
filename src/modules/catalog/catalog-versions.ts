import { redis } from '../../cache/redis.js';

/**
 * Two monotonic counters that make the effective-attribute cache safe.
 *
 * The cache key is (categoryId, treeVersion, defsVersion). Bumping a counter does not
 * evict anything — it simply makes every existing key unreachable, so a stale entry can
 * never be read and there is no invalidation fan-out to get wrong. Old entries expire
 * on their own TTL.
 *
 * They are deliberately coarse: any category write bumps the tree, any definition write
 * bumps the defs, and both invalidate every category's cached set. That is the right
 * trade because these are admin actions measured in dozens per day, while a precise
 * dependency graph would be a second thing to keep correct.
 *
 * They live in Redis alongside the cache they key, so losing Redis loses the counters
 * and the cache together — a cold cache, never a stale one.
 */

const TREE_VERSION_KEY = 'catalog:v:tree';
const DEFS_VERSION_KEY = 'catalog:v:defs';

export type CatalogVersions = { tree: number; defs: number };

export async function currentVersions(): Promise<CatalogVersions> {
  const [tree, defs] = await redis.mget(TREE_VERSION_KEY, DEFS_VERSION_KEY);
  return { tree: Number(tree ?? 0), defs: Number(defs ?? 0) };
}

/** Call after any write that changes the category tree or its bindings. */
export async function bumpTreeVersion(): Promise<number> {
  return redis.incr(TREE_VERSION_KEY);
}

/** Call after any write that changes an attribute definition. */
export async function bumpDefsVersion(): Promise<number> {
  return redis.incr(DEFS_VERSION_KEY);
}
