import type { Section } from './storefront.schema.js';

/**
 * The front page before anyone has composed one.
 *
 * This is the Phase 4 home page, expressed as data. A fresh database serves it, and the
 * composer's first draft starts from it, so publishing version 1 without changing
 * anything produces exactly the page that was there before — the composer takes over the
 * front of the shop without a visible seam.
 */
export const DEFAULT_HOME_SECTIONS: Section[] = [
  {
    id: 'hero-doorway',
    kind: 'hero',
    heading: 'A general store, kept the old way',
    body:
      'Coffee and tea, ceramics, botanicals, textiles, pantry and hand tools. We keep a ' +
      'small range and know where each of it comes from.',
    primary: { label: 'Browse the shelves', href: '/shop' },
  },
  {
    id: 'shelves-all',
    kind: 'shelves',
    title: 'The shelves',
    note: 'Everything the shop stocks, in the order it was put out.',
    categoryIds: [],
  },
  {
    id: 'row-newest',
    kind: 'product-row',
    title: 'Just put out',
    note: 'The most recent things on the shelves.',
    source: 'newest',
    productIds: [],
    limit: 6,
  },
];
