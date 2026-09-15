import { z } from 'zod';

/**
 * Where a product photograph lives, and what the shop owes the person who took it.
 *
 * `publicId` holds exactly one of two things (ADR-015):
 *
 * - **A Cloudinary public id** — `haestore/products/q3x1…`. The shop's own photographs,
 *   uploaded from the console. The storefront's image loader turns one into a
 *   transformation URL.
 * - **A hotlinked Unsplash address** — `https://images.unsplash.com/photo-…?ixid=…`. The
 *   seed's photographs. Unsplash requires its images to be served from its own CDN so a
 *   photographer's views are counted, so they are never copied into Cloudinary; the loader
 *   resizes them with the imgix parameters Unsplash supports instead.
 *
 * Nothing else is accepted, and the refusal is the point. This string becomes an
 * `<img src>` on the shelves, in the bag and in the order history, and "any URL" would make
 * the product form a way to put an arbitrary third-party image — or a tracking pixel — in
 * front of every visitor.
 */

export const UNSPLASH_IMAGE_HOST = 'images.unsplash.com';

export function isUnsplashImageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    url.hostname === UNSPLASH_IMAGE_HOST &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    // Unsplash+ photographs live on another host under another licence, and are refused by
    // the host check; this refuses anything on the right host that is not a photograph.
    /^\/photo-[A-Za-z0-9-]+$/.test(url.pathname)
  );
}

/**
 * Slash-separated segments of letters, digits, `_`, `-` and `.`, none of which starts with
 * a dot or a hyphen. Narrower than what Cloudinary allows, and wide enough for every id it
 * issues into a folder — and it cannot spell a scheme, a host or a parent directory.
 */
const PUBLIC_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

export function isCloudinaryPublicId(value: string): boolean {
  return value.length <= 255 && PUBLIC_ID.test(value);
}

export function isImageSource(value: string): boolean {
  return isCloudinaryPublicId(value) || isUnsplashImageUrl(value);
}

export const imageSourceSchema = z.string().trim().min(1).max(500).refine(isImageSource, {
  message:
    'A photograph is a Cloudinary public id (haestore/products/…) or an images.unsplash.com address.',
});

const httpsUrl = z.url({ protocol: /^https$/ }).max(500);

/**
 * Who took it, and where it came from, as the page will print it: "Photo by {author} on
 * {source}", each a link.
 *
 * Stored with the image rather than looked up, because the attribution is part of the
 * licence to show the photograph and must survive anything that happens to the source — a
 * photographer renaming their profile does not change who took a picture already on the
 * shelf. The links are `https` or nothing, since they are rendered as `href`s.
 */
export const imageCreditSchema = z.object({
  author: z.string().trim().min(1).max(120),
  authorUrl: httpsUrl,
  source: z.string().trim().min(1).max(60),
  sourceUrl: httpsUrl,
});

export type ImageCredit = z.infer<typeof imageCreditSchema>;

/**
 * A placeholder, and only an image one.
 *
 * `next/image` writes `blurDataURL` into a CSS `background-image: url("…")`, so a string
 * that closed the quote would be style injection into every card that showed it. A base64
 * image data URL has no quote, bracket or semicolon to close anything with.
 */
export const blurDataUrlSchema = z
  .string()
  .max(8000)
  .regex(/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/, {
    message: 'A placeholder is a base64 PNG, JPEG, WebP or GIF data URL.',
  });
