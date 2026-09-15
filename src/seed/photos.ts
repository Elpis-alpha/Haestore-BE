import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { blurhashToDataUrl } from '../media/blurhash-png.js';
import { isUnsplashImageUrl } from '../modules/catalog/image-source.js';
import type { UnsplashPhoto } from './unsplash.js';

/**
 * Which photograph each product wears, decided once and committed.
 *
 * A product in the catalogue data names its photographs as searches — `{ query: 'pour over
 * coffee', pick: 2 }` — because that is how a person chooses one. `npm run seed:photos`
 * turns each search into a specific photograph and writes it here, into
 * `photos.lock.json`, which is committed. `npm run seed` reads only the lock.
 *
 * The split is what makes a fresh clone cheap. Choosing photographs needs the API and its
 * fifty-an-hour quota; seeding a shop with photographs already chosen needs neither, apart
 * from reporting each download once (see unsplash.ts). And the shop looks the same on every
 * machine, which a seed that searched afresh would not promise — search results move.
 *
 * What is locked is what the licence needs and nothing more: the hotlink address, the
 * placeholder hash, the proportions, and the attribution.
 */

export type PhotoSpec = {
  query: string;
  /** Which of the search's eligible results, counting from zero. */
  pick?: number;
  /** What the photograph shows, for people who cannot see it. Unsplash's own description stands in. */
  alt?: string;
};

export type LockedPhoto = {
  id: string;
  url: string;
  width: number;
  height: number;
  blurHash: string | null;
  description: string | null;
  author: string;
  authorUrl: string;
  pageUrl: string;
  downloadLocation: string;
};

export type PhotoLock = Record<string, LockedPhoto>;

export const LOCK_FILE = fileURLToPath(new URL('./photos.lock.json', import.meta.url));

export function specKey(spec: PhotoSpec): string {
  return `${spec.query.trim().toLowerCase()}#${spec.pick ?? 0}`;
}

export function readLock(file = LOCK_FILE): PhotoLock {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PhotoLock;
  } catch {
    return {};
  }
}

/** Sorted by key, so a change to one product's photograph is a one-entry diff. */
export async function writeLock(lock: PhotoLock, file = LOCK_FILE): Promise<void> {
  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * The results a product may wear. Unsplash+ photographs come back from search under a
 * different licence and host, and a photograph without a BlurHash would arrive on the shelf
 * with no placeholder — both are passed over rather than chosen.
 */
export function eligible(results: UnsplashPhoto[]): UnsplashPhoto[] {
  return results.filter(
    (photo) => !photo.premium && isUnsplashImageUrl(photo.urls.raw) && Boolean(photo.blur_hash),
  );
}

export function lockPhoto(photo: UnsplashPhoto): LockedPhoto {
  return {
    id: photo.id,
    url: photo.urls.raw,
    width: photo.width,
    height: photo.height,
    blurHash: photo.blur_hash,
    description: photo.alt_description ?? photo.description,
    author: photo.user.name,
    authorUrl: photo.user.links.html,
    pageUrl: photo.links.html,
    downloadLocation: photo.links.download_location,
  };
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A locked photograph as a product image: hotlinked, placeheld, and credited with the UTM
 * parameters Unsplash's attribution guideline asks for on both links.
 */
export function productImage(
  photo: LockedPhoto,
  options: { alt?: string; fallbackAlt: string; position: number; appName: string },
) {
  const utm = new URLSearchParams({ utm_source: options.appName, utm_medium: 'referral' });
  const blurDataUrl = photo.blurHash ? blurhashToDataUrl(photo.blurHash, photo) : null;
  const alt =
    options.alt ?? (photo.description ? sentence(photo.description) : options.fallbackAlt);

  return {
    publicId: photo.url,
    alt: alt.slice(0, 200),
    width: photo.width,
    height: photo.height,
    ...(blurDataUrl ? { blurDataUrl } : {}),
    position: options.position,
    credit: {
      author: photo.author,
      authorUrl: `${photo.authorUrl}?${utm.toString()}`,
      source: 'Unsplash',
      sourceUrl: `https://unsplash.com/?${utm.toString()}`,
    },
  };
}
