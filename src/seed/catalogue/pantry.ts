import type { SeedProduct } from './types.js';
import { grid, single, usd } from './variants.js';

const PLANT = ['vegan', 'vegetarian', 'gluten-free', 'dairy-free'];
const HONEY = ['vegetarian', 'gluten-free', 'dairy-free'];

export const PANTRY: SeedProduct[] = [
  /* -------------------------------------------------------- honey & preserves -- */
  {
    title: 'Raw Wildflower Honey',
    subtitle: 'Unheated, unfiltered, and it will set',
    description:
      'From hives kept on meadows and hedgerows, spun and strained through a cloth and nothing finer. It crystallises in the cold, which is what raw honey does; stand the jar in warm water to loosen it.',
    shelf: 'pantry/honey-preserves',
    attributes: {
      diet: HONEY,
      organic: false,
      made_in: 'united-kingdom',
      keeps_months: 24,
    },
    variants: grid({ weight_g: ['340', '1000'] }, (a) => usd(a.weight_g === '340' ? 12 : 28), 20),
    photos: [{ query: 'honey jar', pick: 0 }],
    demand: 7,
    regard: 4.8,
  },
  {
    title: 'Seville Orange Marmalade',
    subtitle: 'Thick-cut, bitter, and made in January',
    description:
      'Seville oranges are in season for a few weeks each winter, and this is made in those weeks, in open pans, with less sugar than most. Sharp enough to wake you up.',
    shelf: 'pantry/honey-preserves',
    attributes: {
      weight_g: 340,
      diet: PLANT,
      organic: true,
      made_in: 'united-kingdom',
      keeps_months: 18,
    },
    variants: single(usd(8), 28),
    photos: [{ query: 'marmalade jar', pick: 0 }],
    demand: 5,
    regard: 4.5,
  },
  {
    title: 'Cretan Thyme Honey',
    subtitle: 'Herbal, a little medicinal, very good on yoghurt',
    description:
      'Bees on the hillsides of Crete forage wild thyme through the summer, and the honey tastes of it — dark, resinous and less sweet than you expect.',
    shelf: 'pantry/honey-preserves',
    attributes: {
      weight_g: 250,
      diet: HONEY,
      organic: false,
      made_in: 'greece',
      keeps_months: 24,
    },
    variants: single(usd(16), 12),
    photos: [{ query: 'honey jar', pick: 1 }],
    demand: 3,
    regard: 4.6,
  },

  /* --------------------------------------------------------- oils & vinegars -- */
  {
    title: 'Early Harvest Olive Oil',
    subtitle: 'Green, peppery, and pressed within hours of picking',
    description:
      'Koroneiki olives picked green in October, when they give less oil and more flavour, and cold-pressed the same day. It catches in the back of the throat, which is how you know. For finishing rather than frying.',
    shelf: 'pantry/oils-vinegars',
    attributes: {
      diet: PLANT,
      organic: true,
      made_in: 'greece',
      keeps_months: 18,
    },
    variants: grid({ volume_ml: ['250', '500'] }, (a) => usd(a.volume_ml === '250' ? 18 : 30), 22),
    photos: [{ query: 'olive oil bottle', pick: 0 }],
    demand: 6,
    regard: 4.7,
  },
  {
    title: 'Aged Balsamic Vinegar',
    subtitle: 'Twelve years in wood, thick enough to pour slowly',
    description:
      'Cooked grape must aged in a battery of barrels of chestnut, cherry and oak. A few drops on strawberries, a hard cheese or a bowl of lentils is the whole recipe.',
    shelf: 'pantry/oils-vinegars',
    attributes: {
      volume_ml: 250,
      diet: PLANT,
      organic: false,
      made_in: 'italy',
      keeps_months: 60,
    },
    variants: single(usd(24), 10),
    photos: [{ query: 'balsamic vinegar', pick: 0 }],
    demand: 3,
    regard: 4.5,
  },

  /* ------------------------------------------------------------ salt & spice -- */
  {
    title: 'Flaked Sea Salt',
    subtitle: 'Soft pyramids, for crumbling between fingers',
    description:
      'Evaporated from Atlantic seawater over a slow fire until hollow pyramid crystals form on the surface. Crush a pinch over anything just before it goes to the table.',
    shelf: 'pantry/salt-spice',
    attributes: {
      diet: PLANT,
      organic: false,
      made_in: 'united-kingdom',
      keeps_months: 60,
    },
    variants: grid({ weight_g: ['125', '500'] }, (a) => usd(a.weight_g === '125' ? 7 : 19), 40),
    photos: [{ query: 'sea salt flakes', pick: 0 }],
    demand: 6,
    regard: 4.6,
  },
  {
    title: 'Smoked Paprika',
    subtitle: 'Sweet pimentón, smoked over oak',
    description:
      'Peppers from the Vera valley, dried for two weeks over smouldering oak and then stone-ground. A spoonful turns a pan of beans or potatoes into dinner.',
    shelf: 'pantry/salt-spice',
    attributes: {
      weight_g: 50,
      diet: PLANT,
      organic: false,
      made_in: 'spain',
      keeps_months: 24,
    },
    variants: single(usd(6), 30),
    photos: [{ query: 'paprika spice', pick: 0 }],
    demand: 3,
    regard: 4.3,
  },
  {
    title: 'Ras el Hanout',
    subtitle: 'Twenty-two spices, blended in Fez',
    description:
      'The name means "head of the shop": the best a spice merchant has. This one is warm with cinnamon, cardamom and rose, and mild enough to use generously in a tagine or on roast carrots.',
    shelf: 'pantry/salt-spice',
    attributes: {
      weight_g: 50,
      diet: PLANT,
      organic: false,
      made_in: 'morocco',
      keeps_months: 12,
    },
    variants: single(usd(7), 18),
    photos: [{ query: 'spices', pick: 0 }],
    demand: 2,
    regard: 4.4,
  },
];
