import type { SeedDefinition } from './types.js';

/**
 * Every attribute the demo shop defines.
 *
 * **Deliberately dissimilar from shelf to shelf**, because that is the claim being
 * demonstrated: coffee has a roast, a process and a grind; ceramics a glaze, a clay body
 * and whether it survives a dishwasher; the apothecary a scent, a volume and a skin type.
 * None of those is a column anywhere. Each is a document like these, bound to a shelf, and
 * the filter panel on that shelf is generated from them.
 *
 * A few are shared where the thing measured really is the same — weight, volume, capacity,
 * where something was made — which is what inheritance and binding are for.
 */

const options = (...pairs: [value: string, label: string, swatchHex?: string][]) =>
  pairs.map(([value, label, swatchHex], order) => ({
    value,
    label,
    order,
    ...(swatchHex ? { swatchHex } : {}),
  }));

export const DEFINITIONS: SeedDefinition[] = [
  /* ---------------------------------------------------------------- shared -- */
  {
    key: 'weight_g',
    label: 'Weight',
    type: 'number',
    unit: 'g',
    description: 'Net weight of what is in the bag, jar or box.',
    options: options(
      ['50', '50 g'],
      ['100', '100 g'],
      ['125', '125 g'],
      ['200', '200 g'],
      ['250', '250 g'],
      ['340', '340 g'],
      ['500', '500 g'],
      ['1000', '1 kg'],
    ),
    isVariantAxis: true,
    filterUi: 'range',
  },
  {
    key: 'volume_ml',
    label: 'Volume',
    type: 'number',
    unit: 'ml',
    options: options(
      ['30', '30 ml'],
      ['50', '50 ml'],
      ['100', '100 ml'],
      ['200', '200 ml'],
      ['250', '250 ml'],
      ['500', '500 ml'],
    ),
    isVariantAxis: true,
    filterUi: 'range',
  },
  {
    key: 'capacity_ml',
    label: 'Capacity',
    type: 'number',
    unit: 'ml',
    description: 'What it holds, filled to a sensible line rather than the brim.',
    validation: { min: 20, max: 5000 },
    filterUi: 'range',
  },
  {
    key: 'dimensions',
    label: 'Dimensions',
    type: 'dimension',
    isFilterable: false,
  },
  {
    key: 'made_in',
    label: 'Made in',
    type: 'select',
    options: options(
      ['united-kingdom', 'United Kingdom'],
      ['portugal', 'Portugal'],
      ['france', 'France'],
      ['italy', 'Italy'],
      ['greece', 'Greece'],
      ['spain', 'Spain'],
      ['sweden', 'Sweden'],
      ['lithuania', 'Lithuania'],
      ['japan', 'Japan'],
      ['india', 'India'],
      ['morocco', 'Morocco'],
    ),
  },

  /* ---------------------------------------------------------- coffee & tea -- */
  {
    key: 'origin',
    label: 'Origin',
    type: 'select',
    isSearchable: true,
    options: options(
      ['ethiopia', 'Ethiopia'],
      ['kenya', 'Kenya'],
      ['rwanda', 'Rwanda'],
      ['colombia', 'Colombia'],
      ['guatemala', 'Guatemala'],
      ['brazil', 'Brazil'],
      ['sumatra', 'Sumatra, Indonesia'],
      ['yunnan', 'Yunnan, China'],
      ['fujian', 'Fujian, China'],
      ['darjeeling', 'Darjeeling, India'],
      ['assam', 'Assam, India'],
      ['japan', 'Japan'],
      ['egypt', 'Egypt'],
      ['south-africa', 'South Africa'],
    ),
  },
  {
    key: 'roast',
    label: 'Roast',
    type: 'select',
    options: options(
      ['light', 'Light'],
      ['medium', 'Medium'],
      ['medium-dark', 'Medium-dark'],
      ['dark', 'Dark'],
    ),
  },
  {
    key: 'process',
    label: 'Process',
    type: 'select',
    description: 'How the fruit was taken off the bean.',
    options: options(
      ['washed', 'Washed'],
      ['natural', 'Natural'],
      ['honey', 'Honey'],
      ['wet-hulled', 'Wet-hulled'],
    ),
  },
  {
    key: 'grind',
    label: 'Grind',
    type: 'select',
    options: options(
      ['whole', 'Whole bean'],
      ['espresso', 'Espresso'],
      ['filter', 'Filter'],
      ['cafetiere', 'Cafetière'],
    ),
    isVariantAxis: true,
  },
  {
    key: 'tasting_notes',
    label: 'Tasting notes',
    type: 'multiselect',
    isSearchable: true,
    options: options(
      ['chocolate', 'Chocolate'],
      ['caramel', 'Caramel'],
      ['nutty', 'Nutty'],
      ['citrus', 'Citrus'],
      ['stone-fruit', 'Stone fruit'],
      ['berry', 'Berry'],
      ['floral', 'Floral'],
      ['tropical', 'Tropical fruit'],
      ['spice', 'Spice'],
      ['molasses', 'Molasses'],
    ),
  },
  {
    key: 'altitude_m',
    label: 'Grown at',
    type: 'number',
    unit: 'm',
    validation: { min: 0, max: 3000, step: 50 },
    filterUi: 'range',
  },
  {
    key: 'tea_type',
    label: 'Tea',
    type: 'select',
    options: options(
      ['green', 'Green'],
      ['black', 'Black'],
      ['oolong', 'Oolong'],
      ['white', 'White'],
      ['puerh', 'Pu-erh'],
      ['herbal', 'Herbal'],
    ),
  },
  {
    key: 'caffeine',
    label: 'Caffeine',
    type: 'select',
    options: options(
      ['none', 'Caffeine-free'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
    ),
  },
  {
    key: 'steep_temp_c',
    label: 'Steep at',
    type: 'number',
    unit: '°C',
    validation: { min: 60, max: 100 },
    isFilterable: false,
  },
  {
    key: 'steep_minutes',
    label: 'Steep for',
    type: 'number',
    unit: 'min',
    validation: { min: 1, max: 10 },
    isFilterable: false,
  },

  /* -------------------------------------------------------------- ceramics -- */
  {
    key: 'glaze',
    label: 'Glaze',
    type: 'color',
    options: options(
      ['celadon', 'Celadon', '#9fb8a5'],
      ['tenmoku', 'Tenmoku', '#3b2a20'],
      ['oatmeal', 'Speckled oatmeal', '#d9cdb8'],
      ['ash-white', 'Ash white', '#ece8df'],
      ['iron-red', 'Iron red', '#8a3b24'],
      ['cobalt', 'Cobalt', '#2c4a7c'],
      ['moss', 'Moss', '#6b7449'],
    ),
    isVariantAxis: true,
    filterUi: 'swatch',
  },
  {
    key: 'clay',
    label: 'Clay body',
    type: 'select',
    options: options(
      ['stoneware', 'Stoneware'],
      ['porcelain', 'Porcelain'],
      ['earthenware', 'Earthenware'],
    ),
  },
  {
    key: 'dishwasher_safe',
    label: 'Dishwasher safe',
    type: 'boolean',
    filterUi: 'toggle',
  },
  {
    key: 'microwave_safe',
    label: 'Microwave safe',
    type: 'boolean',
    filterUi: 'toggle',
  },

  /* ------------------------------------------------------------ apothecary -- */
  {
    key: 'scent',
    label: 'Scent',
    type: 'select',
    options: options(
      ['unscented', 'Unscented'],
      ['lavender', 'Lavender'],
      ['cedarwood', 'Cedarwood'],
      ['rosemary-mint', 'Rosemary & mint'],
      ['bergamot', 'Bergamot'],
      ['rose-geranium', 'Rose geranium'],
      ['vetiver', 'Vetiver'],
      ['fig-leaf', 'Fig leaf'],
    ),
    isVariantAxis: true,
  },
  {
    key: 'skin_type',
    label: 'For skin that is',
    type: 'multiselect',
    options: options(['any', 'Any'], ['dry', 'Dry'], ['sensitive', 'Sensitive'], ['oily', 'Oily']),
  },
  {
    key: 'vegan',
    label: 'Vegan',
    type: 'boolean',
    filterUi: 'toggle',
  },
  {
    key: 'key_ingredients',
    label: 'Key ingredients',
    type: 'text',
    isFilterable: false,
    isSearchable: true,
    validation: { maxLength: 300 },
  },
  {
    key: 'burn_hours',
    label: 'Burns for',
    type: 'number',
    unit: 'h',
    validation: { min: 1, max: 200 },
    filterUi: 'range',
  },

  /* -------------------------------------------------------------- textiles -- */
  {
    key: 'fibre',
    label: 'Fibre',
    type: 'select',
    options: options(
      ['linen', 'Linen'],
      ['cotton', 'Cotton'],
      ['linen-cotton', 'Linen & cotton'],
      ['wool', 'Wool'],
      ['alpaca', 'Alpaca'],
    ),
  },
  {
    key: 'colour',
    label: 'Colour',
    type: 'color',
    options: options(
      ['natural', 'Natural', '#d8cdb9'],
      ['oat', 'Oat', '#cbbd9f'],
      ['indigo', 'Indigo', '#2f3e5c'],
      ['rust', 'Rust', '#9c4a2a'],
      ['sage', 'Sage', '#9aa58b'],
      ['charcoal', 'Charcoal', '#3a3834'],
      ['mustard', 'Mustard', '#c49a3a'],
    ),
    isVariantAxis: true,
    filterUi: 'swatch',
  },
  {
    key: 'bed_size',
    label: 'Bed size',
    type: 'select',
    options: options(['single', 'Single'], ['double', 'Double'], ['king', 'King']),
    isVariantAxis: true,
  },
  {
    key: 'weight_gsm',
    label: 'Fabric weight',
    type: 'number',
    unit: 'gsm',
    description: 'Grams per square metre. Heavier is warmer and slower to dry.',
    validation: { min: 50, max: 900 },
    filterUi: 'range',
  },
  {
    key: 'care',
    label: 'Care',
    type: 'text',
    isFilterable: false,
    validation: { maxLength: 300 },
  },

  /* ---------------------------------------------------------------- pantry -- */
  {
    key: 'diet',
    label: 'Suitable for',
    type: 'multiselect',
    options: options(
      ['vegan', 'Vegan'],
      ['vegetarian', 'Vegetarian'],
      ['gluten-free', 'Gluten-free'],
      ['dairy-free', 'Dairy-free'],
    ),
  },
  {
    key: 'organic',
    label: 'Organic',
    type: 'boolean',
    filterUi: 'toggle',
  },
  {
    key: 'keeps_months',
    label: 'Keeps for',
    type: 'number',
    unit: 'months',
    description: 'Unopened, somewhere cool and dark.',
    validation: { min: 1, max: 60 },
    isFilterable: false,
  },

  /* ----------------------------------------------------------------- tools -- */
  {
    key: 'wood',
    label: 'Wood',
    type: 'select',
    options: options(
      ['ash', 'Ash'],
      ['beech', 'Beech'],
      ['cherry', 'Cherry'],
      ['olive', 'Olive'],
      ['walnut', 'Walnut'],
    ),
  },
  {
    key: 'metal',
    label: 'Metal',
    type: 'select',
    options: options(
      ['carbon-steel', 'Carbon steel'],
      ['stainless-steel', 'Stainless steel'],
      ['brass', 'Brass'],
      ['copper', 'Copper'],
      ['cast-iron', 'Cast iron'],
    ),
  },
  {
    key: 'length_cm',
    label: 'Length',
    type: 'number',
    unit: 'cm',
    validation: { min: 1, max: 200 },
    filterUi: 'range',
  },
  {
    key: 'guaranteed_for_life',
    label: 'Guaranteed for life',
    type: 'boolean',
    filterUi: 'toggle',
  },
];
