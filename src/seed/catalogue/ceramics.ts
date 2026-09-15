import type { SeedProduct } from './types.js';
import { grid, single, usd } from './variants.js';

const cm = (length: number, width: number, height: number) => ({
  length,
  width,
  height,
  unit: 'cm',
});

export const CERAMICS: SeedProduct[] = [
  /* ------------------------------------------------------------ cups & mugs -- */
  {
    title: 'Everyday Mug',
    subtitle: 'Thrown stoneware, with a handle for four fingers',
    description:
      'The mug we sell more of than anything else on the shelf. Heavy enough to hold heat, with a wide handle and a lip that is thinner than it looks. Each glaze pools a little differently at the base.',
    shelf: 'ceramics/cups-mugs',
    attributes: {
      capacity_ml: 350,
      clay: 'stoneware',
      dimensions: cm(12, 9, 10),
      made_in: 'united-kingdom',
      dishwasher_safe: true,
      microwave_safe: true,
    },
    variants: grid(
      { glaze: ['celadon', 'tenmoku', 'oatmeal', 'iron-red'] },
      () => usd(32),
      (axis) => (axis.glaze === 'iron-red' ? 2 : 18),
    ),
    photos: [{ query: 'ceramic mug', pick: 23 }],
    demand: 9,
    regard: 4.7,
  },
  {
    title: 'Tenmoku Tea Bowl',
    subtitle: 'For matcha, or for holding with both hands',
    description:
      'A wide, low bowl in an iron glaze that breaks from black to rust where it runs thin over the rim. Made to be held rather than lifted by anything, so it has no handle and a foot you can feel.',
    shelf: 'ceramics/cups-mugs',
    attributes: {
      glaze: 'tenmoku',
      capacity_ml: 250,
      clay: 'stoneware',
      dimensions: cm(12, 12, 7),
      made_in: 'japan',
      dishwasher_safe: false,
      microwave_safe: false,
    },
    variants: single(usd(38), 7),
    photos: [{ query: 'handmade ceramic cup', pick: 0 }],
    demand: 3,
    regard: 4.8,
  },
  {
    title: 'Espresso Cups, pair',
    subtitle: 'Porcelain, thin-walled, a double shot to the line',
    description:
      'Two small porcelain cups with a thick base that keeps the coffee warm and a thin rim that keeps it pleasant. Sold as a pair because nobody drinks espresso alone for long.',
    shelf: 'ceramics/cups-mugs',
    attributes: {
      capacity_ml: 90,
      clay: 'porcelain',
      dimensions: cm(6, 6, 6),
      made_in: 'portugal',
      dishwasher_safe: true,
      microwave_safe: true,
    },
    variants: grid({ glaze: ['ash-white', 'cobalt'] }, () => usd(28), 14),
    photos: [{ query: 'handmade ceramic cup', pick: 1 }],
    demand: 5,
    regard: 4.4,
  },
  {
    title: 'Stoneware Beaker',
    subtitle: 'No handle, for water, wine or a short coffee',
    description:
      'A straight-sided cup that stacks, turned with a band of bare clay at the foot so it sits steadily on a wet table. Our potters make these between larger pieces and nobody has managed to stop buying them.',
    shelf: 'ceramics/cups-mugs',
    attributes: {
      capacity_ml: 300,
      clay: 'stoneware',
      dimensions: cm(8, 8, 10),
      made_in: 'united-kingdom',
      dishwasher_safe: true,
      microwave_safe: true,
    },
    variants: grid({ glaze: ['moss', 'oatmeal', 'ash-white'] }, () => usd(26), 16),
    photos: [{ query: 'ceramic mug', pick: 27 }],
    demand: 4,
    regard: 4.3,
  },

  /* --------------------------------------------------------- bowls & plates -- */
  {
    title: 'Breakfast Bowl',
    subtitle: 'Deep enough for porridge, wide enough for noodles',
    description:
      'The bowl for everything that is not a plate. The glaze stops just short of the foot, and the inside is left smooth so a spoon runs round it without catching.',
    shelf: 'ceramics/bowls-plates',
    attributes: {
      capacity_ml: 600,
      clay: 'stoneware',
      dimensions: cm(16, 16, 7),
      made_in: 'united-kingdom',
      dishwasher_safe: true,
      microwave_safe: true,
    },
    variants: grid({ glaze: ['celadon', 'oatmeal', 'cobalt'] }, () => usd(30), 20),
    photos: [{ query: 'ceramic bowl', pick: 0 }],
    demand: 6,
    regard: 4.5,
  },
  {
    title: 'Dinner Plate',
    subtitle: 'Twenty-seven centimetres, with a lip that catches sauce',
    description:
      'A plain, generous plate with a gently raised rim. Pressed rather than thrown, so a set of them matches, and finished by hand, so they do not match exactly.',
    shelf: 'ceramics/bowls-plates',
    attributes: {
      clay: 'stoneware',
      dimensions: cm(27, 27, 2.5),
      made_in: 'portugal',
      dishwasher_safe: true,
      microwave_safe: true,
    },
    variants: grid({ glaze: ['ash-white', 'oatmeal'] }, () => usd(36), 24),
    photos: [{ query: 'ceramic plates', pick: 0 }],
    demand: 5,
    regard: 4.2,
  },
  {
    title: 'Serving Bowl',
    subtitle: 'For salad for eight, or a loaf proving on the counter',
    description:
      'A large, open bowl in an iron-red glaze that goes nearly black where it is thick. Too big for the dishwasher and too good for it anyway.',
    shelf: 'ceramics/bowls-plates',
    attributes: {
      glaze: 'iron-red',
      capacity_ml: 2500,
      clay: 'stoneware',
      dimensions: cm(30, 30, 10),
      made_in: 'united-kingdom',
      dishwasher_safe: false,
      microwave_safe: false,
    },
    variants: single(usd(78), 4),
    photos: [{ query: 'ceramic bowl', pick: 1 }],
    demand: 2,
    regard: 4.6,
  },

  /* --------------------------------------------------------------- vases -- */
  {
    title: 'Bud Vase',
    subtitle: 'One stem, and a narrow neck to hold it upright',
    description:
      'A small porcelain bottle for a single flower or a sprig of something from a walk. Glazed inside, so it holds water without sweating onto the windowsill.',
    shelf: 'ceramics/vases',
    attributes: {
      clay: 'porcelain',
      dimensions: cm(6, 6, 14),
      made_in: 'japan',
      dishwasher_safe: false,
    },
    variants: grid({ glaze: ['celadon', 'tenmoku', 'ash-white'] }, () => usd(24), 12),
    photos: [{ query: 'ceramic vase', pick: 0 }],
    demand: 4,
    regard: 4.6,
  },
  {
    title: 'Tall Bottle Vase',
    subtitle: 'For branches rather than bunches',
    description:
      'Thirty-two centimetres of thrown stoneware in a moss glaze, weighted at the base so a long branch of blossom or eucalyptus will not tip it over.',
    shelf: 'ceramics/vases',
    attributes: {
      glaze: 'moss',
      clay: 'stoneware',
      dimensions: cm(12, 12, 32),
      made_in: 'united-kingdom',
      dishwasher_safe: false,
    },
    variants: single(usd(68), 5),
    photos: [{ query: 'ceramic vase', pick: 1 }],
    demand: 2,
    regard: 4.5,
  },
];
