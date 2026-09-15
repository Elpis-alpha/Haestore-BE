import type { SeedProduct } from './types.js';
import { grid, single, usd } from './variants.js';

export const APOTHECARY: SeedProduct[] = [
  /* ---------------------------------------------------------- soap & bath -- */
  {
    title: 'Cold-Process Soap',
    subtitle: 'Olive oil and shea, cured for six weeks',
    description:
      'Made in small batches and left to cure on wooden racks until it is hard and mild. It lathers slowly and lasts. The unscented bar is the one to choose for a baby or for skin that reacts to everything.',
    shelf: 'apothecary/soap-bath',
    attributes: {
      skin_type: ['any'],
      weight_g: 125,
      key_ingredients: 'Olive oil, coconut oil, shea butter, essential oils',
      vegan: true,
      made_in: 'united-kingdom',
    },
    variants: grid(
      { scent: ['unscented', 'lavender', 'rosemary-mint', 'cedarwood'] },
      () => usd(9),
      40,
    ),
    photos: [{ query: 'handmade soap', pick: 0 }],
    demand: 8,
    regard: 4.6,
  },
  {
    title: 'Oat & Honey Bar',
    subtitle: 'For dry skin, and hands that work outside',
    description:
      'Colloidal oats and raw honey stirred into a goat’s milk base, with nothing added for scent. Gentle enough to use on a face.',
    shelf: 'apothecary/soap-bath',
    attributes: {
      scent: 'unscented',
      skin_type: ['dry', 'sensitive'],
      weight_g: 125,
      key_ingredients: 'Goat’s milk, colloidal oats, raw honey, olive oil',
      vegan: false,
      made_in: 'united-kingdom',
    },
    variants: single(usd(10), 30),
    photos: [{ query: 'handmade soap', pick: 1 }],
    demand: 4,
    regard: 4.7,
  },
  {
    title: 'Mineral Bath Salts',
    subtitle: 'Magnesium flakes and grey sea salt',
    description:
      'A handful in a hot bath after a long walk. Magnesium chloride flakes, coarse Breton sea salt and a few drops of essential oil, in a jar with a wooden scoop.',
    shelf: 'apothecary/soap-bath',
    attributes: {
      skin_type: ['any'],
      weight_g: 500,
      key_ingredients: 'Magnesium chloride, Breton sea salt, essential oils',
      vegan: true,
      made_in: 'france',
    },
    variants: grid({ scent: ['lavender', 'vetiver'] }, () => usd(18), 15),
    photos: [{ query: 'bath salts', pick: 0 }],
    demand: 3,
    regard: 4.3,
  },

  /* ----------------------------------------------------------- oils & balms -- */
  {
    title: 'Rosehip Face Oil',
    subtitle: 'Cold-pressed, a few drops at night',
    description:
      'Rosehip seed oil pressed without heat, with jojoba to help it sink in. Unscented, because a face oil does not need to smell of anything. Keep it out of the light.',
    shelf: 'apothecary/oils-balms',
    attributes: {
      scent: 'unscented',
      skin_type: ['dry', 'any'],
      key_ingredients: 'Rosehip seed oil, jojoba oil, vitamin E',
      vegan: true,
      made_in: 'portugal',
    },
    variants: grid({ volume_ml: ['30', '50'] }, (a) => usd(a.volume_ml === '30' ? 28 : 42), 12),
    photos: [{ query: 'face oil bottle', pick: 1 }],
    demand: 5,
    regard: 4.5,
  },
  {
    title: 'Gardener’s Hand Balm',
    subtitle: 'Beeswax and calendula, in a tin for the pocket',
    description:
      'A firm balm that melts at skin temperature. It was made for hands cracked by soil and cold water and it works just as well on elbows, lips and the backs of heels.',
    shelf: 'apothecary/oils-balms',
    attributes: {
      skin_type: ['dry'],
      volume_ml: 50,
      key_ingredients: 'Beeswax, shea butter, calendula-infused sunflower oil',
      vegan: false,
      made_in: 'united-kingdom',
    },
    variants: grid(
      { scent: ['lavender', 'rose-geranium', 'unscented'] },
      () => usd(16),
      (axis) => (axis.scent === 'rose-geranium' ? 0 : 25),
    ),
    photos: [{ query: 'hand cream tin', pick: 6 }],
    demand: 6,
    regard: 4.6,
  },
  {
    title: 'Body Oil',
    subtitle: 'Sweet almond and apricot kernel, after a bath',
    description:
      'A light oil to put on damp skin. It absorbs in a minute or two and leaves a scent that stays close rather than filling the room.',
    shelf: 'apothecary/oils-balms',
    attributes: {
      skin_type: ['any'],
      volume_ml: 100,
      key_ingredients: 'Sweet almond oil, apricot kernel oil, essential oils',
      vegan: true,
      made_in: 'france',
    },
    variants: grid({ scent: ['bergamot', 'fig-leaf'] }, () => usd(34), 10),
    photos: [{ query: 'body oil', pick: 0 }],
    demand: 3,
    regard: 4.2,
  },

  /* ---------------------------------------------------------------- candles -- */
  {
    title: 'Stoneware Candle',
    subtitle: 'Poured into a pot you keep afterwards',
    description:
      'Soy wax and essential oils in one of our own small stoneware pots. When the candle is finished, wash the pot out in hot water and use it for pencils, a plant or a pinch of salt.',
    shelf: 'apothecary/candles',
    attributes: {
      burn_hours: 45,
      key_ingredients: 'Soy wax, cotton wick, essential oils',
      vegan: true,
      made_in: 'united-kingdom',
    },
    variants: grid({ scent: ['cedarwood', 'fig-leaf', 'bergamot'] }, () => usd(38), 14),
    photos: [{ query: 'candle', pick: 0 }],
    demand: 7,
    regard: 4.4,
  },
  {
    title: 'Travel Candle',
    subtitle: 'Twenty hours in a tin with a lid',
    description:
      'The same wax as our stoneware candle, in a tin small enough to take away for a weekend. The lid goes back on to put it out without smoke.',
    shelf: 'apothecary/candles',
    attributes: {
      burn_hours: 20,
      key_ingredients: 'Soy wax, cotton wick, essential oils',
      vegan: true,
      made_in: 'united-kingdom',
    },
    variants: grid({ scent: ['lavender', 'vetiver'] }, () => usd(18), 20),
    photos: [{ query: 'candle', pick: 1 }],
    demand: 4,
    regard: 4.1,
  },
  {
    title: 'Beeswax Tapers, pair',
    subtitle: 'Hand-dipped, and they smell faintly of honey',
    description:
      'Pure beeswax dipped by hand around a cotton wick, twenty-five centimetres tall. They burn slowly and cleanly and drip very little if kept out of a draught.',
    shelf: 'apothecary/candles',
    attributes: {
      scent: 'unscented',
      burn_hours: 8,
      key_ingredients: 'Beeswax, cotton wick',
      vegan: false,
      made_in: 'lithuania',
    },
    variants: single(usd(14), 30),
    photos: [{ query: 'beeswax candles', pick: 0 }],
    demand: 3,
    regard: 4.7,
  },
];
