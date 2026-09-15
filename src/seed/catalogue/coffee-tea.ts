import type { SeedProduct } from './types.js';
import { grid, single, usd } from './variants.js';

const GRINDS = ['whole', 'espresso', 'filter', 'cafetiere'];

/** A bag in two sizes and four grinds, the kilo priced as the shop prices a kilo. */
const bags = (small: number, kilo: number, onHand = 24) =>
  grid(
    { grind: GRINDS, weight_g: ['250', '1000'] },
    (axis) => usd(axis.weight_g === '1000' ? kilo : small),
    (axis) => (axis.weight_g === '1000' ? Math.round(onHand / 3) : onHand),
  );

export const COFFEE_TEA: SeedProduct[] = [
  /* ----------------------------------------------------------------- coffee -- */
  {
    title: 'Guji Natural',
    subtitle: 'Blueberry, jasmine and a long, sweet finish',
    description:
      'Grown by smallholders in the Guji zone and dried whole in the cherry on raised beds, which is where the blueberry comes from. We roast it light to keep the florals. Lovely as a filter, and surprising as an espresso.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'ethiopia',
      roast: 'light',
      process: 'natural',
      tasting_notes: ['berry', 'floral', 'tropical'],
      altitude_m: 2100,
    },
    variants: bags(19, 62),
    photos: [{ query: 'coffee beans', pick: 0 }],
    demand: 7,
    regard: 4.7,
  },
  {
    title: 'Nyeri Peaberry',
    subtitle: 'Blackcurrant and grapefruit, bright and clean',
    description:
      'Peaberries are the round single beans a coffee cherry sometimes grows instead of the usual pair, sorted out by hand. This lot from the slopes of Mount Kenya is washed and sun-dried, and tastes like it: blackcurrant, grapefruit and a finish like black tea.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'kenya',
      roast: 'light',
      process: 'washed',
      tasting_notes: ['citrus', 'berry'],
      altitude_m: 1800,
    },
    variants: bags(21, 68, 18),
    photos: [{ query: 'coffee beans', pick: 28 }],
    demand: 5,
    regard: 4.5,
  },
  {
    title: 'Huila Supremo',
    subtitle: 'Caramel, red apple and milk chocolate',
    description:
      'A washed Colombian from the southern highlands of Huila, where the altitude keeps the cherries ripening slowly. Roasted to medium for sweetness. The coffee we give people who say they do not like "fruity" coffee.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'colombia',
      roast: 'medium',
      process: 'washed',
      tasting_notes: ['caramel', 'stone-fruit', 'chocolate'],
      altitude_m: 1700,
    },
    variants: bags(17, 55, 30),
    photos: [{ query: 'coffee beans', pick: 26 }],
    demand: 6,
    regard: 4.4,
  },
  {
    title: 'Huehuetenango',
    subtitle: 'Cocoa, hazelnut and a little clove',
    description:
      'From the dry, high valleys near the Mexican border, where the warm winds off the plains keep frost away from coffee grown higher than almost anywhere else in Guatemala. Round and dependable, with a spice that shows up as it cools.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'guatemala',
      roast: 'medium',
      process: 'washed',
      tasting_notes: ['chocolate', 'nutty', 'spice'],
      altitude_m: 1900,
    },
    variants: bags(18, 58),
    photos: [{ query: 'coffee beans', pick: 7 }],
    demand: 4,
    regard: 4.3,
  },
  {
    title: 'Mogiana Honey',
    subtitle: 'Peanut brittle and dark chocolate',
    description:
      'Pulped and dried with some of the fruit still clinging to the bean, which gives this Brazilian its sticky sweetness. Heavy-bodied and low in acidity, and forgiving of a hurried morning.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'brazil',
      roast: 'medium-dark',
      process: 'honey',
      tasting_notes: ['nutty', 'chocolate', 'caramel'],
      altitude_m: 1100,
    },
    variants: bags(15, 48, 30),
    photos: [{ query: 'roasted coffee beans', pick: 28 }],
    demand: 5,
    regard: 4.2,
  },
  {
    title: 'Aceh Gayo',
    subtitle: 'Molasses, cedar and pipe tobacco',
    description:
      'Sumatran coffee is hulled while still wet, a method particular to the island and responsible for the earthy, syrupy cup people either love or leave. We roast it dark and make no apology.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'sumatra',
      roast: 'dark',
      process: 'wet-hulled',
      tasting_notes: ['molasses', 'spice', 'chocolate'],
      altitude_m: 1500,
    },
    variants: bags(17, 55, 16),
    photos: [{ query: 'roasted coffee beans', pick: 1 }],
    demand: 3,
    regard: 4.0,
  },
  {
    title: 'The House Espresso',
    subtitle: 'Chocolate, toffee and a crema that holds',
    description:
      'Two parts Brazil to one part Ethiopia, roasted a shade past medium. It is what we pour behind the counter, and it is built to taste good with milk and without, from a machine or a stovetop pot.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'brazil',
      roast: 'medium-dark',
      process: 'natural',
      tasting_notes: ['chocolate', 'caramel', 'nutty'],
      altitude_m: 1200,
    },
    variants: grid(
      { grind: ['whole', 'espresso'], weight_g: ['250', '1000'] },
      (axis) => usd(axis.weight_g === '1000' ? 50 : 16),
      (axis) => (axis.weight_g === '1000' ? 20 : 60),
    ),
    photos: [{ query: 'espresso', pick: 0 }],
    demand: 10,
    regard: 4.8,
  },
  {
    title: 'Kivu Honey, small lot',
    subtitle: 'Apricot, orange blossom and brown sugar',
    description:
      'Forty kilos from a single washing station on the shore of Lake Kivu, honey-processed and the best thing we roasted this season. Whole bean only, and gone when it is gone.',
    shelf: 'coffee-tea/coffee',
    attributes: {
      origin: 'rwanda',
      roast: 'light',
      process: 'honey',
      tasting_notes: ['stone-fruit', 'floral', 'citrus'],
      altitude_m: 1850,
      grind: 'whole',
      weight_g: 250,
    },
    variants: single(usd(22), 6),
    photos: [{ query: 'roasted coffee beans', pick: 23 }],
    demand: 1,
    regard: 5,
  },
  {
    title: 'Gesha, next harvest',
    subtitle: 'Bergamot, peach and jasmine',
    description:
      'Waiting on the sample roast before we decide how far to take it. Not on the shelves until then.',
    shelf: 'coffee-tea/coffee',
    // No roast yet, deliberately: this is the product the console's "needs attention" queue
    // shows on a freshly seeded shop.
    attributes: {
      origin: 'ethiopia',
      process: 'washed',
      tasting_notes: ['floral', 'stone-fruit', 'citrus'],
      altitude_m: 2000,
      grind: 'whole',
      weight_g: 250,
    },
    variants: single(usd(34), 0),
    photos: [],
    demand: 0,
    regard: 0,
    status: 'draft',
  },

  /* -------------------------------------------------------------------- tea -- */
  {
    title: 'First Flush Darjeeling',
    subtitle: 'Muscatel, spring grass and apricot',
    description:
      'The first picking after the Himalayan winter, from an estate that has grown tea since 1860. Light for a black tea, and best without milk. Take the leaves out after three minutes; they will give a second cup.',
    shelf: 'coffee-tea/tea',
    attributes: {
      origin: 'darjeeling',
      tea_type: 'black',
      caffeine: 'medium',
      steep_temp_c: 90,
      steep_minutes: 3,
    },
    variants: grid({ weight_g: ['50', '100'] }, (a) => usd(a.weight_g === '50' ? 14 : 26), 20),
    photos: [{ query: 'loose leaf tea', pick: 0 }],
    demand: 5,
    regard: 4.6,
  },
  {
    title: 'Assam Breakfast',
    subtitle: 'Malt, honey and enough strength for milk',
    description:
      'A strong, malty broken-leaf Assam from the Brahmaputra valley. It brews dark in four minutes and stands up to milk and sugar, which is what a breakfast tea is for.',
    shelf: 'coffee-tea/tea',
    attributes: {
      origin: 'assam',
      tea_type: 'black',
      caffeine: 'high',
      steep_temp_c: 100,
      steep_minutes: 4,
    },
    variants: grid({ weight_g: ['100', '250'] }, (a) => usd(a.weight_g === '100' ? 11 : 24), 40),
    photos: [{ query: 'loose leaf tea', pick: 4 }],
    demand: 7,
    regard: 4.3,
  },
  {
    title: 'Uji Sencha',
    subtitle: 'Sweet pea, seaweed and cut grass',
    description:
      'Steamed green tea from the hills south of Kyoto. Water just off the boil will make it bitter; seventy degrees and two minutes makes it sweet. Keep the tin closed and in the dark.',
    shelf: 'coffee-tea/tea',
    attributes: {
      origin: 'japan',
      tea_type: 'green',
      caffeine: 'medium',
      steep_temp_c: 70,
      steep_minutes: 2,
    },
    variants: grid({ weight_g: ['50', '100'] }, (a) => usd(a.weight_g === '50' ? 15 : 28), 18),
    photos: [{ query: 'green tea', pick: 7 }],
    demand: 4,
    regard: 4.5,
  },
  {
    title: 'Tieguanyin Oolong',
    subtitle: 'Orchid, butter and a mineral finish',
    description:
      'Rolled into tight green pearls that open slowly over several short infusions. Rinse the leaves once, then steep for a minute at a time and keep going — a spoonful is good for five or six cups.',
    shelf: 'coffee-tea/tea',
    attributes: {
      origin: 'fujian',
      tea_type: 'oolong',
      caffeine: 'medium',
      steep_temp_c: 90,
      steep_minutes: 1,
    },
    variants: grid({ weight_g: ['50', '100'] }, (a) => usd(a.weight_g === '50' ? 16 : 30), 14),
    photos: [{ query: 'loose leaf tea', pick: 6 }],
    demand: 3,
    regard: 4.4,
  },
  {
    title: 'Yunnan Gold',
    subtitle: 'Cocoa, sweet potato and no bitterness at all',
    description:
      'Made almost entirely from golden buds, which is what gives the dry leaf its colour and the cup its softness. Hard to over-steep, and the one we suggest to people who think they do not like black tea.',
    shelf: 'coffee-tea/tea',
    attributes: {
      origin: 'yunnan',
      tea_type: 'black',
      caffeine: 'medium',
      steep_temp_c: 95,
      steep_minutes: 3,
    },
    variants: grid({ weight_g: ['50', '100'] }, (a) => usd(a.weight_g === '50' ? 13 : 24), 22),
    photos: [{ query: 'loose leaf tea', pick: 7 }],
    demand: 3,
    regard: 4.6,
  },
  {
    title: 'Egyptian Chamomile',
    subtitle: 'Whole flowers, apple and hay',
    description:
      'Whole chamomile heads from the Nile delta rather than the dust that goes into bags. Caffeine-free, and the evening cup in more of our customers’ houses than anything else we sell.',
    shelf: 'coffee-tea/tea',
    attributes: {
      origin: 'egypt',
      tea_type: 'herbal',
      caffeine: 'none',
      steep_temp_c: 100,
      steep_minutes: 5,
    },
    variants: grid({ weight_g: ['50', '100'] }, (a) => usd(a.weight_g === '50' ? 9 : 16), 30),
    photos: [{ query: 'chamomile tea', pick: 0 }],
    demand: 4,
    regard: 4.2,
  },
  {
    title: 'Cederberg Rooibos',
    subtitle: 'Vanilla, honey and dried fig',
    description:
      'Grown only in the Cederberg mountains north of Cape Town, fermented and sun-dried. Naturally caffeine-free and very hard to spoil, so it is the tea for a pot left on the table.',
    shelf: 'coffee-tea/tea',
    attributes: {
      origin: 'south-africa',
      tea_type: 'herbal',
      caffeine: 'none',
      steep_temp_c: 100,
      steep_minutes: 6,
      weight_g: 100,
    },
    variants: single(usd(10), 26),
    photos: [{ query: 'rooibos tea', pick: 0 }],
    demand: 2,
    regard: 4,
  },
];
