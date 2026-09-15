import type { z } from 'zod';
import type { sectionSchema } from '../modules/storefront/storefront.schema.js';

/** The six things on the counter, in the order they sit there. */
export const HANDPICKED = [
  'The House Espresso',
  'Everyday Mug',
  'Linen Tea Towel',
  'Raw Wildflower Honey',
  'Cold-Process Soap',
  'Olive Wood Spoon',
];

/**
 * The front page the seed publishes, as version 1 of a composed layout.
 *
 * It uses every kind of section the composer offers — a hero, the shelves, a note, and a row
 * of each source — so a fresh clone shows what the composer can do without anyone opening
 * it, and opening it shows a real layout to change rather than the built-in default.
 */
export function homeSections(ids: {
  coffeeShelfId: string;
  handpicked: string[];
}): z.input<typeof sectionSchema>[] {
  return [
    {
      id: 'hero-doorway',
      kind: 'hero',
      heading: 'A general store, kept the old way',
      body:
        'Coffee and tea, ceramics, botanicals, textiles, pantry and hand tools. We keep a ' +
        'small range, and we know where every piece of it comes from.',
      primary: { label: 'Browse the shelves', href: '/shop' },
      secondary: { label: 'This week’s coffee', href: '/shop/coffee-tea/coffee' },
    },
    {
      id: 'shelves-all',
      kind: 'shelves',
      title: 'The shelves',
      note: 'Six of them, and everything on each one chosen by hand.',
      categoryIds: [],
    },
    {
      id: 'row-counter',
      kind: 'product-row',
      title: 'From behind the counter',
      note: 'What we use ourselves, every day.',
      source: 'handpicked',
      productIds: ids.handpicked,
      limit: 6,
    },
    {
      id: 'note-keeping',
      kind: 'note',
      heading: 'How we keep the shop',
      body:
        'We buy from a few dozen growers, potters, weavers and makers, most of whom we have ' +
        'met, and we sell what we would use at home. When something runs out it is usually ' +
        'because a harvest or a kiln firing did, and it comes back when they do.',
    },
    {
      id: 'row-coffee',
      kind: 'product-row',
      title: 'Roasted this week',
      note: 'Single origins, and the espresso we pour behind the counter.',
      source: 'category',
      categoryId: ids.coffeeShelfId,
      productIds: [],
      limit: 6,
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
}
