import { deflateSync } from 'node:zlib';
import { decode, isBlurhashValid } from 'blurhash';

/**
 * A BlurHash, drawn as a PNG a few pixels across, as a data URL for `placeholder="blur"`.
 *
 * Unsplash returns a `blur_hash` with every photograph for exactly this purpose. Decoding
 * it here, once, at seed time, means the placeholder costs the storefront nothing: no
 * decoder in the Worker bundle, no canvas in the browser, and no second request to anyone.
 * The alternative — fetching a tiny version of the photograph and inlining its bytes —
 * would be a copy of an image Unsplash requires to be hotlinked (ADR-015).
 *
 * Eight pixels wide is enough. The browser scales it to the frame and `next/image` blurs
 * it, so more pixels buy bytes in every listing response and nothing a person can see.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit truecolour PNG from RGBA pixels. Alpha is dropped: a BlurHash has none. */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  // compression, filter and interlace are all method 0

  // One filter byte (0, none) at the start of every scanline, then RGB triples.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4;
      const to = row + 1 + x * 3;
      raw[to] = rgba[from]!;
      raw[to + 1] = rgba[from + 1]!;
      raw[to + 2] = rgba[from + 2]!;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const PLACEHOLDER_WIDTH = 8;

/**
 * The placeholder for a photograph of the given proportions, or null for a hash that does
 * not decode — a photograph without a placeholder still renders, so a bad hash is not a
 * reason to fail a seed.
 */
export function blurhashToDataUrl(
  hash: string,
  size: { width: number; height: number },
): string | null {
  if (!isBlurhashValid(hash).result) return null;
  const width = PLACEHOLDER_WIDTH;
  const ratio = size.width > 0 ? size.height / size.width : 1;
  const height = Math.min(16, Math.max(4, Math.round(width * ratio)));
  const pixels = decode(hash, width, height);
  return `data:image/png;base64,${encodePng(width, height, pixels).toString('base64')}`;
}
