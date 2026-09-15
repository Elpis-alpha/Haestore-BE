import type { SeedProduct } from './types.js';
import { grid, single, usd } from './variants.js';

const WASH_LINEN = 'Machine wash at 40°C. Line dry, and iron damp if you iron at all.';
const WASH_WOOL = 'Air it outside rather than washing it. When it must be washed, cool, by hand.';

export const TEXTILES: SeedProduct[] = [
  /* ---------------------------------------------------------- kitchen linen -- */
  {
    title: 'Linen Tea Towel',
    subtitle: 'Heavy, stonewashed, and better every time it is washed',
    description:
      'Woven from Lithuanian flax on old looms, then washed with stones so it arrives soft. Linen dries glass without leaving lint behind and dries itself quickly on a rail.',
    shelf: 'textiles/kitchen-linen',
    attributes: {
      fibre: 'linen',
      dimensions: { length: 70, width: 50, height: 0.2, unit: 'cm' },
      made_in: 'lithuania',
      care: WASH_LINEN,
    },
    variants: grid({ colour: ['natural', 'indigo', 'rust', 'sage'] }, () => usd(16), 30),
    photos: [{ query: 'linen tea towel', pick: 0 }],
    demand: 8,
    regard: 4.6,
  },
  {
    title: 'Linen Napkins, set of four',
    subtitle: 'For every day, not just for guests',
    description:
      'Four large napkins in the same stonewashed linen as our tea towels, hemmed by hand. They are meant to be used at every meal and thrown in with the wash.',
    shelf: 'textiles/kitchen-linen',
    attributes: {
      fibre: 'linen',
      dimensions: { length: 45, width: 45, height: 0.2, unit: 'cm' },
      made_in: 'lithuania',
      care: WASH_LINEN,
    },
    variants: grid({ colour: ['oat', 'charcoal', 'sage'] }, () => usd(38), 12),
    photos: [{ query: 'linen napkins', pick: 0 }],
    demand: 4,
    regard: 4.4,
  },
  {
    title: 'Waffle Dish Cloths, set of three',
    subtitle: 'Cotton waffle weave, for the washing up',
    description:
      'Thick cotton cloths woven in a deep waffle that holds water and scrubs a pan without scratching it. Boil-washable, which is the only way to keep a dish cloth nice.',
    shelf: 'textiles/kitchen-linen',
    attributes: {
      fibre: 'cotton',
      colour: 'natural',
      dimensions: { length: 30, width: 30, height: 0.4, unit: 'cm' },
      made_in: 'portugal',
      care: 'Machine wash hot, up to 90°C.',
    },
    variants: single(usd(14), 36),
    photos: [{ query: 'dish cloth', pick: 0 }],
    demand: 3,
    regard: 4,
  },

  /* ------------------------------------------------------- throws & blankets -- */
  {
    title: 'Lambswool Throw',
    subtitle: 'Woven in a Yorkshire mill, fringed by hand',
    description:
      'A soft, lofty throw in lambswool from a mill that has woven blankets since the 1830s. Big enough to wrap around two people on a sofa, light enough to leave on the end of a bed all year.',
    shelf: 'textiles/throws-blankets',
    attributes: {
      fibre: 'wool',
      weight_gsm: 420,
      dimensions: { length: 180, width: 130, height: 1, unit: 'cm' },
      made_in: 'united-kingdom',
      care: WASH_WOOL,
    },
    variants: grid(
      { colour: ['oat', 'charcoal', 'mustard'] },
      () => usd(145),
      (axis) => (axis.colour === 'mustard' ? 0 : 6),
    ),
    photos: [{ query: 'wool throw blanket', pick: 0 }],
    demand: 4,
    regard: 4.8,
  },
  {
    title: 'Alpaca Blanket',
    subtitle: 'Undyed, in the colour of the animal',
    description:
      'Baby alpaca woven in Biella into a blanket that is warmer than wool at half the weight. Undyed, so the colour is the fleece’s own, and it varies a little from one blanket to the next.',
    shelf: 'textiles/throws-blankets',
    attributes: {
      fibre: 'alpaca',
      colour: 'natural',
      weight_gsm: 500,
      dimensions: { length: 200, width: 140, height: 1, unit: 'cm' },
      made_in: 'italy',
      care: WASH_WOOL,
    },
    variants: single(usd(220), 3),
    photos: [{ query: 'wool throw blanket', pick: 1 }],
    demand: 1,
    regard: 4.9,
  },
  {
    title: 'Cotton Picnic Blanket',
    subtitle: 'Striped, and backed so the grass stays out',
    description:
      'A heavy woven cotton blanket with a waterproof backing and a leather strap to carry it rolled. It has survived a lot of beaches and one festival.',
    shelf: 'textiles/throws-blankets',
    attributes: {
      fibre: 'cotton',
      weight_gsm: 300,
      dimensions: { length: 180, width: 150, height: 0.5, unit: 'cm' },
      made_in: 'portugal',
      care: 'Brush off, then sponge clean. Machine wash cool only if you must.',
    },
    variants: grid({ colour: ['indigo', 'rust'] }, () => usd(85), 8),
    photos: [{ query: 'picnic blanket', pick: 0 }],
    demand: 2,
    regard: 4.2,
  },

  /* ---------------------------------------------------------------- bed linen -- */
  {
    title: 'Stonewashed Linen Duvet Cover',
    subtitle: 'Cool in summer, warm in winter, soft from the first night',
    description:
      'Pure linen washed with stones before it is sewn, so there is no breaking-in period. Wooden buttons at the foot, and ties inside to keep the duvet from wandering.',
    shelf: 'textiles/bed-linen',
    attributes: {
      fibre: 'linen',
      weight_gsm: 170,
      made_in: 'lithuania',
      care: WASH_LINEN,
    },
    variants: grid(
      { colour: ['natural', 'sage'], bed_size: ['single', 'double', 'king'] },
      (axis) => usd({ single: 140, double: 180, king: 210 }[axis.bed_size!]!),
      (axis) => (axis.bed_size === 'king' ? 4 : 8),
    ),
    photos: [{ query: 'linen bedding', pick: 0 }],
    demand: 5,
    regard: 4.5,
  },
  {
    title: 'Linen Pillowcases, pair',
    subtitle: 'Envelope-backed, no buttons to lie on',
    description:
      'Two pillowcases in the same stonewashed linen as the duvet covers, with a deep envelope closure. They go with anything, which is most of what a pillowcase needs to do.',
    shelf: 'textiles/bed-linen',
    attributes: {
      fibre: 'linen',
      weight_gsm: 170,
      made_in: 'lithuania',
      care: WASH_LINEN,
    },
    variants: grid({ colour: ['natural', 'sage', 'charcoal'] }, () => usd(45), 14),
    photos: [{ query: 'linen bedding', pick: 1 }],
    demand: 5,
    regard: 4.4,
  },
];
