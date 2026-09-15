import { describe, expect, it } from 'vitest';
import {
  blurDataUrlSchema,
  imageCreditSchema,
  imageSourceSchema,
  isCloudinaryPublicId,
  isUnsplashImageUrl,
} from './image-source.js';

/**
 * What may stand in a product's `publicId`.
 *
 * The negative cases are the ones worth having: every string refused here is one that
 * would otherwise reach an `<img src>` on every page of the shop.
 */

const UNSPLASH =
  'https://images.unsplash.com/photo-1511920170033-f8396924c348?ixid=M3w2NTk2fDB8MXxzZWFyY2h8MXx8&ixlib=rb-4.1.0';

describe('isUnsplashImageUrl', () => {
  it('accepts a photograph URL as the API returns it', () => {
    expect(isUnsplashImageUrl(UNSPLASH)).toBe(true);
  });

  it.each([
    ['plain http', UNSPLASH.replace('https:', 'http:')],
    ['another host', UNSPLASH.replace('images.unsplash.com', 'images.unsplash.com.evil.test')],
    ['Unsplash+', 'https://plus.unsplash.com/premium_photo-1675435644687-562e8042b9db?ixid=x'],
    ['credentials', UNSPLASH.replace('https://', 'https://user:pass@')],
    ['a port', UNSPLASH.replace('.com/', '.com:8443/')],
    ['a path that is not a photograph', 'https://images.unsplash.com/profile-123?ixid=x'],
    ['a nested path', 'https://images.unsplash.com/photo-1/../../x'],
    ['not a URL', 'images.unsplash.com/photo-1511920170033'],
  ])('refuses %s', (_label, value) => {
    expect(isUnsplashImageUrl(value)).toBe(false);
  });
});

describe('isCloudinaryPublicId', () => {
  it.each(['first', 'haestore/x', 'haestore/products/q3x1_ab-9', 'haestore/v2/tea.pot'])(
    'accepts %s',
    (value) => {
      expect(isCloudinaryPublicId(value)).toBe(true);
    },
  );

  it.each([
    'https://evil.test/x.png',
    '//evil.test/x.png',
    '/leading/slash',
    'haestore/../secrets',
    'haestore/./x',
    'haestore//x',
    'javascript:alert(1)',
    'has space',
    'x'.repeat(256),
  ])('refuses %s', (value) => {
    expect(isCloudinaryPublicId(value)).toBe(false);
  });
});

describe('imageSourceSchema', () => {
  it('takes either kind and nothing else', () => {
    expect(imageSourceSchema.safeParse('haestore/products/x').success).toBe(true);
    expect(imageSourceSchema.safeParse(UNSPLASH).success).toBe(true);
    expect(imageSourceSchema.safeParse('https://example.com/cat.jpg').success).toBe(false);
  });
});

describe('imageCreditSchema', () => {
  const credit = {
    author: 'Nathan Dumlao',
    authorUrl: 'https://unsplash.com/@nate_dumlao?utm_source=haestore&utm_medium=referral',
    source: 'Unsplash',
    sourceUrl: 'https://unsplash.com/?utm_source=haestore&utm_medium=referral',
  };

  it('accepts an attribution with https links', () => {
    expect(imageCreditSchema.safeParse(credit).success).toBe(true);
  });

  it('refuses a link that could run script or leave TLS', () => {
    expect(
      imageCreditSchema.safeParse({ ...credit, authorUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      imageCreditSchema.safeParse({ ...credit, sourceUrl: 'http://unsplash.com' }).success,
    ).toBe(false);
  });
});

describe('blurDataUrlSchema', () => {
  it('accepts a base64 image data URL', () => {
    expect(blurDataUrlSchema.safeParse('data:image/png;base64,iVBORw0KGgo=').success).toBe(true);
  });

  it('refuses anything that could close the CSS url() it is written into', () => {
    expect(
      blurDataUrlSchema.safeParse('data:image/png;base64,AA");background:red;("').success,
    ).toBe(false);
    expect(blurDataUrlSchema.safeParse('data:image/svg+xml,<svg onload=alert(1)>').success).toBe(
      false,
    );
  });
});
