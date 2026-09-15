import { inflateSync } from 'node:zlib';
import { encode } from 'blurhash';
import { describe, expect, it } from 'vitest';
import { blurhashToDataUrl, encodePng, PLACEHOLDER_WIDTH } from './blurhash-png.js';

/**
 * The placeholder is a PNG this file writes by hand, so the tests read it back by hand:
 * signature, header, and the pixels out of the inflated scanlines.
 */

function readPng(buffer: Buffer) {
  expect(buffer.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const idatLength = buffer.readUInt32BE(33);
  expect(buffer.subarray(37, 41).toString('ascii')).toBe('IDAT');
  const raw = inflateSync(buffer.subarray(41, 41 + idatLength));
  const pixel = (x: number, y: number) => {
    const at = y * (width * 3 + 1) + 1 + x * 3;
    return [raw[at], raw[at + 1], raw[at + 2]];
  };
  return { width, height, raw, pixel };
}

function solid(width: number, height: number, rgb: [number, number, number]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) pixels.set([...rgb, 255], i * 4);
  return pixels;
}

describe('encodePng', () => {
  it('writes a header, one filter byte per row, and the RGB triples', () => {
    const png = readPng(encodePng(3, 2, solid(3, 2, [82, 53, 35])));
    expect(png.width).toBe(3);
    expect(png.height).toBe(2);
    expect(png.raw.length).toBe((3 * 3 + 1) * 2);
    expect(png.raw[0]).toBe(0);
    expect(png.pixel(2, 1)).toEqual([82, 53, 35]);
  });
});

describe('blurhashToDataUrl', () => {
  it('draws a solid photograph as its own colour', () => {
    const hash = encode(solid(4, 4, [82, 53, 35]), 4, 4, 1, 1);
    const url = blurhashToDataUrl(hash, { width: 4000, height: 5000 });
    expect(url).toMatch(/^data:image\/png;base64,/);

    const png = readPng(Buffer.from(url!.split(',')[1]!, 'base64'));
    expect(png.width).toBe(PLACEHOLDER_WIDTH);
    expect(png.height).toBe(10);
    const [r, g, b] = png.pixel(4, 5) as number[];
    // sRGB → linear → sRGB loses at most a step either way.
    expect(Math.abs(r! - 82)).toBeLessThanOrEqual(1);
    expect(Math.abs(g! - 53)).toBeLessThanOrEqual(1);
    expect(Math.abs(b! - 35)).toBeLessThanOrEqual(1);
  });

  it('keeps the proportions within a sensible band', () => {
    const hash = encode(solid(4, 4, [200, 200, 200]), 4, 4, 1, 1);
    const tall = readPng(
      Buffer.from(blurhashToDataUrl(hash, { width: 1, height: 9 })!.split(',')[1]!, 'base64'),
    );
    const wide = readPng(
      Buffer.from(blurhashToDataUrl(hash, { width: 9, height: 1 })!.split(',')[1]!, 'base64'),
    );
    expect(tall.height).toBe(16);
    expect(wide.height).toBe(4);
  });

  it('is small enough to ride along in a listing response', () => {
    const photo = new Uint8ClampedArray(32 * 32 * 4).map((_, i) => (i * 37) % 256);
    const hash = encode(photo, 32, 32, 4, 3);
    expect(blurhashToDataUrl(hash, { width: 3, height: 4 })!.length).toBeLessThan(600);
  });

  it('returns null for a hash that does not decode, rather than throwing', () => {
    expect(blurhashToDataUrl('not a hash', { width: 1, height: 1 })).toBeNull();
  });
});
