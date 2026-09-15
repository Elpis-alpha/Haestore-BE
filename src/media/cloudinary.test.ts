import { describe, expect, it } from 'vitest';
import { signParams } from './cloudinary.js';

/**
 * The signature is the whole of what keeps a browser upload inside the shop's folder, so it
 * is checked against the worked example in Cloudinary's own documentation rather than
 * against itself.
 */

describe('signParams', () => {
  it("matches Cloudinary's documented example", () => {
    expect(
      signParams(
        {
          timestamp: 1315060510,
          public_id: 'sample_image',
          eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop',
        },
        'abcd',
      ),
    ).toBe('bfd09f95f331f558cbd1320e67aa8d488770583e');
  });

  it('leaves out the parameters Cloudinary does not sign, and empty ones', () => {
    const base = signParams({ timestamp: 1, folder: 'haestore/products' }, 'secret');
    expect(
      signParams(
        {
          timestamp: 1,
          folder: 'haestore/products',
          api_key: '123',
          file: 'x',
          cloud_name: 'c',
          resource_type: 'image',
          tags: '',
        },
        'secret',
      ),
    ).toBe(base);
  });

  it('changes when the folder does, which is what pins an upload to it', () => {
    expect(signParams({ timestamp: 1, folder: 'haestore/products' }, 's')).not.toBe(
      signParams({ timestamp: 1, folder: 'elsewhere' }, 's'),
    );
  });
});
