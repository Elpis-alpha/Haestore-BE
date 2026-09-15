import type { SeedShelf } from './types.js';

/**
 * The category tree, with what each shelf binds.
 *
 * **Required means required of every product**, so nothing a product might sell along an axis
 * is marked required: a coffee sold in 250 g and 1 kg bags has no single weight to give, and
 * a required `weight_g` would flag every one of them. What is required is what every product
 * on the shelf has exactly one of — a roast, an origin, a fibre.
 *
 * Bindings are placed as high as they are true. `origin` is bound once on Coffee & tea and
 * inherited by both children; `glaze` and `clay` once on Ceramics. The one suppression is
 * there because it is real rather than to show the feature off: nobody microwaves a vase.
 */
export const SHELVES: SeedShelf[] = [
  {
    name: 'Coffee & tea',
    slug: 'coffee-tea',
    description:
      'Roasted in small batches and sent within the week, and leaf from growers we buy from every year.',
    bindings: [{ key: 'origin', required: true, group: 'Where it grows' }],
    children: [
      {
        name: 'Coffee',
        slug: 'coffee',
        description: 'Single origins and one house blend, roasted to order.',
        bindings: [
          { key: 'roast', required: true, group: 'In the cup' },
          { key: 'tasting_notes', group: 'In the cup' },
          { key: 'process', group: 'Where it grows' },
          { key: 'altitude_m', group: 'Where it grows' },
          { key: 'grind', group: 'The bag' },
          { key: 'weight_g', group: 'The bag' },
        ],
      },
      {
        name: 'Tea',
        slug: 'tea',
        description: 'Loose leaf, and a few herbal infusions for the evening.',
        bindings: [
          { key: 'tea_type', required: true, group: 'In the cup' },
          { key: 'caffeine', group: 'In the cup' },
          { key: 'steep_temp_c', group: 'Brewing' },
          { key: 'steep_minutes', group: 'Brewing' },
          { key: 'weight_g', group: 'The tin' },
        ],
      },
    ],
  },
  {
    name: 'Ceramics',
    slug: 'ceramics',
    description: 'Thrown and glazed by hand, so no two are quite the same.',
    bindings: [
      { key: 'glaze', group: 'The piece' },
      { key: 'clay', group: 'The piece' },
      { key: 'dimensions', group: 'The piece' },
      { key: 'made_in', group: 'The piece' },
      { key: 'dishwasher_safe', group: 'Care' },
      { key: 'microwave_safe', group: 'Care' },
    ],
    children: [
      {
        name: 'Cups & mugs',
        slug: 'cups-mugs',
        description: 'For the first coffee and the last tea.',
        bindings: [{ key: 'capacity_ml', required: true, group: 'The piece' }],
      },
      {
        name: 'Bowls & plates',
        slug: 'bowls-plates',
        description: 'Everyday tableware, heavy enough to feel it.',
        bindings: [{ key: 'capacity_ml', group: 'The piece' }],
      },
      {
        name: 'Vases & vessels',
        slug: 'vases',
        description: 'For a branch from the garden, or for nothing at all.',
        suppress: ['microwave_safe'],
      },
    ],
  },
  {
    name: 'Apothecary',
    slug: 'apothecary',
    description: 'Soap, oils and candles made with plants and very little else.',
    bindings: [
      { key: 'key_ingredients', group: 'What is in it' },
      { key: 'vegan', group: 'What is in it' },
      { key: 'made_in', group: 'What is in it' },
    ],
    children: [
      {
        name: 'Soap & bath',
        slug: 'soap-bath',
        description: 'Cold-process bars, cured for six weeks.',
        bindings: [
          { key: 'scent', group: 'Scent' },
          { key: 'skin_type', group: 'For' },
          { key: 'weight_g', group: 'Size' },
        ],
      },
      {
        name: 'Oils & balms',
        slug: 'oils-balms',
        description: 'For hands, faces and the skin winter leaves behind.',
        bindings: [
          { key: 'scent', group: 'Scent' },
          { key: 'skin_type', group: 'For' },
          { key: 'volume_ml', group: 'Size' },
        ],
      },
      {
        name: 'Candles',
        slug: 'candles',
        description: 'Poured into our own vessels, with cotton wicks.',
        bindings: [
          { key: 'scent', group: 'Scent' },
          { key: 'burn_hours', required: true, group: 'Size' },
        ],
      },
    ],
  },
  {
    name: 'Textiles',
    slug: 'textiles',
    description: 'Linen, cotton and wool, woven to be used and washed for years.',
    bindings: [
      { key: 'fibre', required: true, group: 'The cloth' },
      { key: 'colour', group: 'The cloth' },
      { key: 'made_in', group: 'The cloth' },
      { key: 'care', group: 'Care' },
    ],
    children: [
      {
        name: 'Kitchen linen',
        slug: 'kitchen-linen',
        description: 'Tea towels, napkins and cloths that get better with washing.',
        bindings: [{ key: 'dimensions', group: 'The cloth' }],
      },
      {
        name: 'Throws & blankets',
        slug: 'throws-blankets',
        description: 'For the end of the bed and the back of the chair.',
        bindings: [
          { key: 'weight_gsm', group: 'The cloth' },
          { key: 'dimensions', group: 'The cloth' },
        ],
      },
      {
        name: 'Bed linen',
        slug: 'bed-linen',
        description: 'Stonewashed, so it arrives soft rather than getting there.',
        bindings: [
          { key: 'bed_size', group: 'Size' },
          { key: 'weight_gsm', group: 'The cloth' },
        ],
      },
    ],
  },
  {
    name: 'Pantry',
    slug: 'pantry',
    description: 'Honey, oil, salt and the things that make plain food good.',
    bindings: [
      { key: 'diet', group: 'What is in it' },
      { key: 'organic', group: 'What is in it' },
      { key: 'made_in', group: 'Where it is from' },
      { key: 'keeps_months', group: 'Keeping' },
    ],
    children: [
      {
        name: 'Honey & preserves',
        slug: 'honey-preserves',
        description: 'Raw honey and fruit set with as little sugar as it takes.',
        bindings: [{ key: 'weight_g', group: 'The jar' }],
      },
      {
        name: 'Oils & vinegars',
        slug: 'oils-vinegars',
        description: 'Pressed and aged by families who have done it for generations.',
        bindings: [{ key: 'volume_ml', group: 'The bottle' }],
      },
      {
        name: 'Salt & spice',
        slug: 'salt-spice',
        description: 'Flaked, smoked and ground, in small tins that go quickly.',
        bindings: [{ key: 'weight_g', group: 'The tin' }],
      },
    ],
  },
  {
    name: 'Tools',
    slug: 'tools',
    description: 'Hand tools for the kitchen, the garden and the coffee, meant to be kept.',
    bindings: [
      { key: 'made_in', group: 'The tool' },
      { key: 'guaranteed_for_life', group: 'The tool' },
    ],
    children: [
      {
        name: 'Kitchen',
        slug: 'kitchen',
        description: 'Knives, spoons and boards.',
        bindings: [
          { key: 'wood', group: 'The tool' },
          { key: 'metal', group: 'The tool' },
          { key: 'length_cm', group: 'The tool' },
        ],
      },
      {
        name: 'Garden',
        slug: 'garden',
        description: 'Trowels, secateurs, and a dibber for the seed tray.',
        bindings: [
          { key: 'wood', group: 'The tool' },
          { key: 'metal', group: 'The tool' },
          { key: 'length_cm', group: 'The tool' },
        ],
      },
      {
        name: 'Brewing',
        slug: 'brewing',
        description: 'Kettles, grinders and drippers for the coffee on the shelf above.',
        bindings: [
          { key: 'metal', group: 'The tool' },
          { key: 'capacity_ml', group: 'The tool' },
        ],
      },
    ],
  },
];
