import { APOTHECARY } from './apothecary.js';
import { DEFINITIONS } from './attributes.js';
import { CERAMICS } from './ceramics.js';
import { COFFEE_TEA } from './coffee-tea.js';
import { PANTRY } from './pantry.js';
import { SHELVES } from './shelves.js';
import { TEXTILES } from './textiles.js';
import { TOOLS } from './tools.js';
import type { SeedProduct, SeedShelf } from './types.js';

export { DEFINITIONS, SHELVES };
export type { SeedProduct, SeedShelf };

export const PRODUCTS: SeedProduct[] = [
  ...COFFEE_TEA,
  ...CERAMICS,
  ...APOTHECARY,
  ...TEXTILES,
  ...PANTRY,
  ...TOOLS,
];

export type IndexedShelf = {
  shelf: SeedShelf;
  path: string;
  /** Every key that applies here, inherited ones included, suppressions applied. */
  keys: Map<string, { required: boolean }>;
};

/** The tree flattened by path, each entry carrying its effective keys — the seed's own resolution. */
export function indexShelves(shelves: SeedShelf[] = SHELVES): Map<string, IndexedShelf> {
  const index = new Map<string, IndexedShelf>();

  const walk = (
    nodes: SeedShelf[],
    parentPath: string | null,
    inherited: Map<string, { required: boolean }>,
  ) => {
    for (const shelf of nodes) {
      const path = parentPath ? `${parentPath}/${shelf.slug}` : shelf.slug;
      const keys = new Map(inherited);
      for (const key of shelf.suppress ?? []) keys.delete(key);
      for (const binding of shelf.bindings ?? []) {
        keys.set(binding.key, { required: binding.required ?? false });
      }
      index.set(path, { shelf, path, keys });
      walk(shelf.children ?? [], path, keys);
    }
  };

  walk(shelves, null, new Map());
  return index;
}

/**
 * Everything wrong with the catalogue data, in words, without a database.
 *
 * The services would refuse most of these during a seed, but one at a time and a minute in.
 * The unit suite runs this, so a typo in an option value fails in a second on save — and the
 * two checks the services deliberately do not make (a required value missing, which lenient
 * mode records rather than refuses, and a photograph forgotten) fail here too.
 */
export function catalogueProblems(
  products: SeedProduct[] = PRODUCTS,
  shelves: SeedShelf[] = SHELVES,
): string[] {
  const problems: string[] = [];
  const definitions = new Map(DEFINITIONS.map((d) => [d.key, d]));
  const index = indexShelves(shelves);

  for (const { path, shelf } of index.values()) {
    for (const binding of shelf.bindings ?? []) {
      if (!definitions.has(binding.key))
        problems.push(`${path} binds "${binding.key}", which is not defined`);
    }
  }

  const titles = new Set<string>();
  for (const product of products) {
    const where = `"${product.title}"`;
    if (titles.has(product.title)) problems.push(`${where} appears twice`);
    titles.add(product.title);

    const shelf = index.get(product.shelf);
    if (!shelf) {
      problems.push(`${where} is on "${product.shelf}", which is not a shelf`);
      continue;
    }
    if ((shelf.shelf.children ?? []).length > 0) {
      problems.push(`${where} is on "${product.shelf}", which has shelves under it`);
    }

    const axes = Object.keys(product.variants[0]?.axis ?? {});
    if (product.variants.length === 0) problems.push(`${where} has no variants`);

    for (const key of [...Object.keys(product.attributes), ...axes]) {
      if (!shelf.keys.has(key))
        problems.push(`${where} uses "${key}", which ${product.shelf} does not bind`);
    }

    for (const key of axes) {
      const definition = definitions.get(key);
      if (!definition?.isVariantAxis)
        problems.push(`${where} sells along "${key}", which is not an axis`);
      if (key in product.attributes)
        problems.push(`${where} gives "${key}" as an attribute and an axis`);
    }

    const fingerprints = new Set<string>();
    for (const variant of product.variants) {
      const keys = Object.keys(variant.axis ?? {});
      if (keys.join() !== axes.join()) problems.push(`${where} has variants on different axes`);
      const fingerprint = JSON.stringify(variant.axis ?? {});
      if (fingerprints.has(fingerprint))
        problems.push(`${where} has two variants at ${fingerprint}`);
      fingerprints.add(fingerprint);
      if (!Number.isInteger(variant.price) || variant.price <= 0) {
        problems.push(`${where} has a variant priced ${variant.price}`);
      }
      for (const [key, value] of Object.entries(variant.axis ?? {})) {
        const values = (definitions.get(key)?.options ?? []).map((o) => o.value);
        if (!values.includes(value))
          problems.push(`${where}: "${value}" is not an option of ${key}`);
      }
    }

    for (const [key, value] of Object.entries(product.attributes)) {
      const values = (definitions.get(key)?.options ?? []).map((o) => o.value);
      if (values.length === 0) continue;
      for (const given of Array.isArray(value) ? value : [value]) {
        if (!values.includes(String(given))) {
          problems.push(`${where}: "${String(given)}" is not an option of ${key}`);
        }
      }
    }

    if (product.status !== 'draft') {
      for (const [key, { required }] of shelf.keys) {
        if (required && !(key in product.attributes))
          problems.push(`${where} is missing required "${key}"`);
      }
      if (product.photos.length === 0) problems.push(`${where} has no photograph`);
    }
  }

  return problems;
}
