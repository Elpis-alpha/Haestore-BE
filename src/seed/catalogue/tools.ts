import type { SeedProduct } from './types.js';
import { single, usd } from './variants.js';

export const TOOLS: SeedProduct[] = [
  /* ---------------------------------------------------------------- kitchen -- */
  {
    title: 'Carbon Steel Chef’s Knife',
    subtitle: 'A twenty-one centimetre gyuto, forged in Sakai',
    description:
      'Hard carbon steel takes a finer edge than stainless and keeps it longer, at the price of a patina and a little care: dry it after washing. The walnut handle is octagonal and sits well in either hand.',
    shelf: 'tools/kitchen',
    attributes: {
      metal: 'carbon-steel',
      wood: 'walnut',
      length_cm: 33,
      made_in: 'japan',
      guaranteed_for_life: true,
    },
    variants: single(usd(165), 6),
    photos: [{ query: 'chef knife', pick: 0 }],
    demand: 3,
    regard: 4.9,
  },
  {
    title: 'Olive Wood Spoon',
    subtitle: 'Carved from pruned branches, never from felled trees',
    description:
      'Olive wood is dense and close-grained, so it does not stain or split or take on the smell of garlic. Each spoon is carved from a branch pruned in the grove, and the grain of each is its own.',
    shelf: 'tools/kitchen',
    attributes: {
      wood: 'olive',
      length_cm: 30,
      made_in: 'greece',
      guaranteed_for_life: false,
    },
    variants: single(usd(14), 34),
    photos: [{ query: 'wooden spoon', pick: 0 }],
    demand: 6,
    regard: 4.5,
  },
  {
    title: 'Walnut Chopping Board',
    subtitle: 'End grain, so the knife sinks in rather than dulls',
    description:
      'Blocks of English walnut glued with the end grain up, which is kinder to a blade and hides its marks. Oil it when it looks dry, and it will outlast the kitchen.',
    shelf: 'tools/kitchen',
    attributes: {
      wood: 'walnut',
      length_cm: 45,
      made_in: 'united-kingdom',
      guaranteed_for_life: true,
    },
    variants: single(usd(85), 7),
    photos: [{ query: 'wooden cutting board', pick: 0 }],
    demand: 3,
    regard: 4.7,
  },

  /* ----------------------------------------------------------------- garden -- */
  {
    title: 'Ash-Handled Trowel',
    subtitle: 'Stainless steel, forged rather than stamped',
    description:
      'A narrow, pointed blade that goes into heavy soil without bending, on a turned ash handle that fits a gloved hand. Guaranteed for as long as you garden.',
    shelf: 'tools/garden',
    attributes: {
      metal: 'stainless-steel',
      wood: 'ash',
      length_cm: 30,
      made_in: 'united-kingdom',
      guaranteed_for_life: true,
    },
    variants: single(usd(42), 15),
    photos: [{ query: 'garden trowel', pick: 0 }],
    demand: 3,
    regard: 4.6,
  },
  {
    title: 'Bypass Secateurs',
    subtitle: 'For live stems, with replaceable blades',
    description:
      'Two blades that pass each other like scissors, so a living stem is cut cleanly rather than crushed. Every part can be bought again, down to the spring.',
    shelf: 'tools/garden',
    attributes: {
      metal: 'carbon-steel',
      length_cm: 20,
      made_in: 'japan',
      guaranteed_for_life: true,
    },
    variants: single(usd(58), 9),
    photos: [{ query: 'pruning shears', pick: 0 }],
    demand: 2,
    regard: 4.5,
  },
  {
    title: 'Ash Dibber',
    subtitle: 'For sowing seeds and planting out, marked in inches',
    description:
      'A turned ash handle and a brass-tipped point, with rings at each inch so a row of garlic goes in at the same depth. The simplest tool in the shed and the one borrowed most.',
    shelf: 'tools/garden',
    attributes: {
      metal: 'brass',
      wood: 'ash',
      length_cm: 25,
      made_in: 'united-kingdom',
      guaranteed_for_life: false,
    },
    variants: single(usd(22), 20),
    photos: [{ query: 'gardening tools', pick: 0 }],
    demand: 2,
    regard: 4.3,
  },

  /* ---------------------------------------------------------------- brewing -- */
  {
    title: 'Gooseneck Kettle',
    subtitle: 'A slow, steady pour for filter coffee',
    description:
      'The long, narrow spout lets you pour a thin stream exactly where you want it, which is most of the difference between good pour-over coffee and ordinary. Works on gas, electric and induction.',
    shelf: 'tools/brewing',
    attributes: {
      metal: 'stainless-steel',
      capacity_ml: 900,
      made_in: 'japan',
      guaranteed_for_life: false,
    },
    variants: single(usd(68), 10),
    photos: [{ query: 'gooseneck kettle', pick: 0 }],
    demand: 4,
    regard: 4.4,
  },
  {
    title: 'Hand Coffee Grinder',
    subtitle: 'Steel burrs, forty grams, thirty seconds',
    description:
      'Conical steel burrs give an even grind from espresso to cafetière, adjusted with a numbered dial so you can find your setting again. Enough for two cups in half a minute of turning.',
    shelf: 'tools/brewing',
    attributes: {
      metal: 'stainless-steel',
      capacity_ml: 40,
      made_in: 'italy',
      guaranteed_for_life: true,
    },
    variants: single(usd(95), 8),
    photos: [{ query: 'coffee grinder', pick: 0 }],
    demand: 3,
    regard: 4.6,
  },
  {
    title: 'Stoneware Pour-Over Dripper',
    subtitle: 'Holds heat, takes a standard cone filter',
    description:
      'Made by the potters who make our mugs, with ridges inside that keep the paper off the wall so the water draws through evenly. Warm it with a splash from the kettle first.',
    shelf: 'tools/brewing',
    attributes: {
      capacity_ml: 600,
      made_in: 'united-kingdom',
      guaranteed_for_life: false,
    },
    variants: single(usd(32), 16),
    photos: [{ query: 'pour over coffee', pick: 0 }],
    demand: 5,
    regard: 4.5,
  },
];
