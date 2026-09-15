/**
 * Attributes in order, with every group kept together.
 *
 * The effective set is sorted by each binding's `order`, and the product page and the
 * console form both draw a heading wherever the group changes. That is right until a shelf
 * inherits one attribute of a group from its parent and binds the rest itself: Coffee takes
 * `origin` from Coffee & tea under "Where it grows", binds `process` and `altitude_m` under
 * the same heading, and its own `roast` sorts between them — so "Where it grows" was drawn
 * twice, and React warned about the duplicate key the heading is rendered under. Found by
 * the Phase 10 seed, the first catalogue with inheritance and groups together.
 *
 * So groups are placed where their first member falls, and members keep their relative
 * order within a group. It is stable: an order in which groups are already contiguous comes
 * back unchanged, which is every catalogue that never met this. Ungrouped attributes are one
 * group for this purpose, placed the same way.
 */
export function keepGroupsTogether<T extends { group?: string | null }>(attributes: T[]): T[] {
  const firstSeen = new Map<string, number>();
  attributes.forEach((attribute, index) => {
    const group = attribute.group ?? '';
    if (!firstSeen.has(group)) firstSeen.set(group, index);
  });

  return attributes
    .map((attribute, index) => ({ attribute, index }))
    .sort(
      (a, b) =>
        firstSeen.get(a.attribute.group ?? '')! - firstSeen.get(b.attribute.group ?? '')! ||
        a.index - b.index,
    )
    .map(({ attribute }) => attribute);
}
