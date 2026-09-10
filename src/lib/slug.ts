/**
 * URL slugs.
 *
 * Deliberately not a dependency: the rules a shop needs are few and knowing them
 * exactly matters more than covering every script, since a slug that changes shape
 * between library versions breaks every bookmarked URL.
 */

/**
 * Normalises to NFD first so accented Latin decomposes into a base letter plus a
 * combining mark, and the marks can be stripped — "Café" becomes "cafe" rather than
 * "caf". Æ and ß have no decomposition, so they are mapped explicitly.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/æ/gi, 'ae')
    .replace(/ø/gi, 'o')
    .replace(/ß/g, 'ss')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

export function isSlug(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
}

/**
 * Appends -2, -3, … until the slug is free.
 *
 * Takes a predicate rather than a collection so the caller decides what "taken" means
 * — a unique index on Category.path scopes differently from one on Product.slug.
 */
export async function uniqueSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base) || 'item';
  if (!(await isTaken(root))) return root;

  for (let n = 2; n <= 500; n += 1) {
    const candidate = `${root}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error(`Could not find a free slug for "${base}" after 500 attempts`);
}
