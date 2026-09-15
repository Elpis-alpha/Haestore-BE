import { describe, expect, it } from 'vitest';
import { DEFINITIONS, PRODUCTS, SHELVES, catalogueProblems, indexShelves } from './index.js';

/**
 * The demo catalogue, checked without a database.
 *
 * The first test is the one that matters day to day. The rest hold the seed to what the plan
 * asked of it, so a later edit cannot quietly turn the adaptable demonstration into six
 * shelves with the same four filters.
 */

describe('the seed catalogue', () => {
  it('has nothing wrong with it', () => {
    expect(catalogueProblems()).toEqual([]);
  });

  it('is about fifty products across six shelves', () => {
    const live = PRODUCTS.filter((p) => p.status !== 'draft');
    expect(live.length).toBeGreaterThanOrEqual(50);
    expect(SHELVES.map((s) => s.slug)).toEqual([
      'coffee-tea',
      'ceramics',
      'apothecary',
      'textiles',
      'pantry',
      'tools',
    ]);
    for (const shelf of SHELVES) {
      expect(live.some((p) => p.shelf.startsWith(`${shelf.slug}/`))).toBe(true);
    }
  });

  it('gives coffee, ceramics and the apothecary deliberately different attributes', () => {
    const index = indexShelves();
    const keys = (path: string) => new Set(index.get(path)!.keys.keys());
    const coffee = keys('coffee-tea/coffee');
    const mugs = keys('ceramics/cups-mugs');
    const oils = keys('apothecary/oils-balms');

    for (const key of ['roast', 'process', 'grind', 'weight_g', 'origin'])
      expect(coffee).toContain(key);
    for (const key of ['glaze', 'dimensions', 'dishwasher_safe']) expect(mugs).toContain(key);
    for (const key of ['volume_ml', 'scent', 'skin_type']) expect(oils).toContain(key);

    expect([...coffee].filter((k) => mugs.has(k))).toEqual([]);
    expect([...coffee].filter((k) => oils.has(k))).toEqual([]);
  });

  it('suppresses an inherited attribute where it does not apply', () => {
    const index = indexShelves();
    expect(index.get('ceramics/cups-mugs')!.keys.has('microwave_safe')).toBe(true);
    expect(index.get('ceramics/vases')!.keys.has('microwave_safe')).toBe(false);
  });

  it('uses every attribute it defines', () => {
    const bound = new Set([...indexShelves().values()].flatMap((s) => [...s.keys.keys()]));
    expect(DEFINITIONS.map((d) => d.key).filter((key) => !bound.has(key))).toEqual([]);
  });

  it('finds the mistakes it exists to find', () => {
    const [first] = PRODUCTS;
    const broken = {
      ...first!,
      title: 'Broken',
      attributes: { ...first!.attributes, roast: 'burnt', glaze: 'celadon' },
    };
    const problems = catalogueProblems([broken]);
    expect(problems).toContain('"Broken": "burnt" is not an option of roast');
    expect(problems).toContain('"Broken" uses "glaze", which coffee-tea/coffee does not bind');
  });
});
