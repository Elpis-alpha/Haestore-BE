import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_SECTIONS } from './storefront.defaults.js';
import { isInternalPath, saveDraftSchema, sectionsSchema } from './storefront.schema.js';

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('isInternalPath', () => {
  it('accepts paths on this site', () => {
    for (const path of [
      '/',
      '/shop',
      '/shop/coffee-tea/beans?roast=dark,light',
      '/product/x#top',
    ]) {
      expect(isInternalPath(path), path).toBe(true);
    }
  });

  /**
   * Each of these is a way to put a link on the front page that leaves the site, and the
   * front page is in front of every visitor. They are the reason the field is not simply
   * "a string that starts with a slash".
   */
  it('refuses every spelling that leaves the site', () => {
    const escapes = [
      'https://evil.test',
      'javascript:alert(1)',
      'shop',
      '//evil.test',
      '/\\evil.test',
      '/\t/evil.test',
      '/\n/evil.test',
      '/ /evil.test',
      '\\\\evil.test',
      '/%09/evil.test/../..',
    ];
    for (const path of escapes) {
      const resolved = (() => {
        try {
          return new URL(path, 'https://haestore.invalid').origin;
        } catch {
          return 'unparseable';
        }
      })();
      // Either refused outright, or genuinely same-origin once a browser resolves it.
      if (isInternalPath(path)) expect(resolved, path).toBe('https://haestore.invalid');
      else expect(isInternalPath(path), path).toBe(false);
    }
    for (const path of escapes.slice(0, 8)) expect(isInternalPath(path), path).toBe(false);
  });
});

describe('sectionsSchema', () => {
  it('accepts the built-in default, so a fresh shop publishes cleanly', () => {
    expect(sectionsSchema.safeParse(DEFAULT_HOME_SECTIONS).success).toBe(true);
  });

  it('refuses a hero whose button leaves the site', () => {
    const result = sectionsSchema.safeParse([
      {
        id: 'hero-1',
        kind: 'hero',
        heading: 'Welcome',
        primary: { label: 'Go', href: '//evil.test' },
      },
    ]);
    expect(result.success).toBe(false);
  });

  it('requires a shelf for a category row and products for a hand-picked one', () => {
    const result = sectionsSchema.safeParse([
      { id: 'row-cat', kind: 'product-row', title: 'Coffee', source: 'category' },
      { id: 'row-pick', kind: 'product-row', title: 'Picks', source: 'handpicked' },
    ]);
    expect(result.success).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path.join('.'));
    expect(paths).toEqual(['0.categoryId', '1.productIds']);

    expect(
      sectionsSchema.safeParse([
        { id: 'row-cat', kind: 'product-row', title: 'Coffee', source: 'category', categoryId: ID },
        {
          id: 'row-pick',
          kind: 'product-row',
          title: 'Picks',
          source: 'handpicked',
          productIds: [ID],
        },
      ]).success,
    ).toBe(true);
  });

  it('refuses two sections with one id, which would make reordering ambiguous', () => {
    const note = { kind: 'note', body: 'Closed on Mondays.' };
    expect(
      sectionsSchema.safeParse([
        { ...note, id: 'note-1' },
        { ...note, id: 'note-1' },
      ]).success,
    ).toBe(false);
  });

  it('refuses a section kind the renderer does not know', () => {
    expect(
      sectionsSchema.safeParse([{ id: 'marquee-1', kind: 'marquee', body: 'SALE' }]).success,
    ).toBe(false);
  });

  it('caps a layout at twelve sections', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `note-${i + 10}`,
      kind: 'note',
      body: 'x',
    }));
    expect(sectionsSchema.safeParse(many).success).toBe(false);
  });

  it('requires the revision a draft save was made against', () => {
    expect(saveDraftSchema.safeParse({ sections: [] }).success).toBe(false);
    expect(saveDraftSchema.safeParse({ sections: [], revision: 0 }).success).toBe(true);
  });
});
