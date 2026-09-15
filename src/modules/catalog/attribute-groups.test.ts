import { describe, expect, it } from 'vitest';
import { keepGroupsTogether } from './attribute-groups.js';

const keys = (list: { key: string }[]) => list.map((a) => a.key);

describe('keepGroupsTogether', () => {
  it('draws an inherited attribute and its shelf-level siblings under one heading', () => {
    // Coffee: origin inherited at order 0, roast and notes at 20–21, then process and
    // altitude under origin's heading at 22–23.
    const coffee = [
      { key: 'origin', group: 'Where it grows' },
      { key: 'roast', group: 'In the cup' },
      { key: 'tasting_notes', group: 'In the cup' },
      { key: 'process', group: 'Where it grows' },
      { key: 'altitude_m', group: 'Where it grows' },
      { key: 'grind', group: 'The bag' },
    ];
    expect(keys(keepGroupsTogether(coffee))).toEqual([
      'origin',
      'process',
      'altitude_m',
      'roast',
      'tasting_notes',
      'grind',
    ]);
  });

  it('leaves an order that already keeps its groups together exactly as it was', () => {
    const tidy = [
      { key: 'a', group: 'One' },
      { key: 'b', group: 'One' },
      { key: 'c' },
      { key: 'd', group: 'Two' },
    ];
    expect(keepGroupsTogether(tidy)).toEqual(tidy);
  });

  it('treats the ungrouped as one group, placed where the first of them falls', () => {
    const mixed = [{ key: 'a' }, { key: 'b', group: 'Care' }, { key: 'c', group: null }];
    expect(keys(keepGroupsTogether(mixed))).toEqual(['a', 'c', 'b']);
  });
});
