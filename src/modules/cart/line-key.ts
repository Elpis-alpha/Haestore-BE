/**
 * A cart line's identity.
 *
 * A line is a (product, variant) pair and nothing else — adding the same variant twice
 * raises a quantity rather than making a second row. That is what makes the merge in
 * merge.ts expressible as a key-by-key comparison instead of a similarity search, and
 * it is why the key is derived rather than generated: two carts that were never in
 * contact still agree on what "the same line" means.
 *
 * Joined with `_`, not `:`. The key travels in a URL path segment, and it is also the
 * shape most likely to be reused as an id somewhere that reserves the colon for its own
 * namespacing — which is exactly what silently discarded every second reindex in
 * Phase 3 until the BullMQ job ids were changed. Both halves are 24 hex characters, so
 * the result is unambiguous, URL-safe and needs no escaping anywhere.
 */

export const LINE_KEY_PATTERN = /^[0-9a-f]{24}_[0-9a-f]{24}$/;

export function lineKeyOf(productId: string, variantId: string): string {
  return `${String(productId).toLowerCase()}_${String(variantId).toLowerCase()}`;
}

export function isLineKey(value: string): boolean {
  return LINE_KEY_PATTERN.test(value);
}

/** Splits a key back into its halves, or null if it is not one of ours. */
export function parseLineKey(value: string): { productId: string; variantId: string } | null {
  if (!isLineKey(value)) return null;
  const [productId, variantId] = value.split('_');
  return { productId: productId as string, variantId: variantId as string };
}
