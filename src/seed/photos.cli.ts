/**
 * `npm run seed:photos [-- --curate]`
 *
 * Turns each product's photograph searches into specific photographs, and writes them to
 * `src/seed/photos.lock.json`, which is committed. See photos.ts for why that is a separate
 * step from seeding.
 *
 * - Searches are cached on disk, so choosing a different result costs nothing.
 * - A search the quota cannot pay for is left unresolved, and the run says so; run it again
 *   in an hour and it carries on.
 * - Photographs chosen are reported to Unsplash as downloads, once each, as its guidelines
 *   ask. **`--curate` skips that**, and writes a contact sheet of every search instead, so
 *   photographs looked at and passed over are not counted as used. Run once more without it
 *   when the choices are settled.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { PRODUCTS } from './catalogue/index.js';
import { eligible, lockPhoto, readLock, specKey, writeLock, type PhotoLock } from './photos.js';
import { defaultCacheDir, RateLimited, UnsplashClient, type UnsplashPhoto } from './unsplash.js';

const curate = process.argv.includes('--curate');

async function main(): Promise<void> {
  if (!env.UNSPLASH_ACCESS_KEY) {
    logger.warn('seed:photos: UNSPLASH_ACCESS_KEY is not set, so only cached searches can be used');
  }
  const client = new UnsplashClient(env.UNSPLASH_ACCESS_KEY, defaultCacheDir());

  const previous = readLock();
  const lock: PhotoLock = {};
  const unresolved: string[] = [];
  const wanted = PRODUCTS.flatMap((product) =>
    product.photos.map((spec) => ({ product: product.title, spec, key: specKey(spec) })),
  );

  for (const { spec, key, product } of wanted) {
    if (lock[key]) continue;
    if (previous[key]) {
      lock[key] = previous[key];
      continue;
    }
    if (!client.isCached(spec.query) && !client.canRequest) {
      unresolved.push(key);
      continue;
    }
    try {
      const photo = eligible(await client.search(spec.query))[spec.pick ?? 0];
      if (!photo) {
        logger.warn(
          { product, query: spec.query, pick: spec.pick },
          'seed:photos: no result there',
        );
        unresolved.push(key);
        continue;
      }
      lock[key] = lockPhoto(photo);
    } catch (err) {
      // The quota, or the network: either way this search waits for the next run, and the
      // searches after it still get their chance.
      if (!(err instanceof RateLimited)) {
        logger.warn(
          { query: spec.query, err: (err as Error).message },
          'seed:photos: search failed',
        );
      }
      unresolved.push(key);
    }
  }

  await writeLock(lock);

  // One photograph on two products reads as a mistake on the shelf, so it is named.
  const byPhoto = new Map<string, string[]>();
  for (const { product, key } of wanted) {
    const id = lock[key]?.id;
    if (id) byPhoto.set(id, [...(byPhoto.get(id) ?? []), product]);
  }
  for (const [id, products] of byPhoto) {
    if (products.length > 1)
      logger.warn({ id, products }, 'seed:photos: one photograph, two products');
  }

  const downloads = curate
    ? { reported: 0, owed: Object.keys(lock).length }
    : await client.reportDownloads(
        Object.values(lock).map((p) => ({ id: p.id, downloadLocation: p.downloadLocation })),
      );

  if (curate) await writeContactSheet(client, wanted, lock);

  logger.info(
    {
      locked: Object.keys(lock).length,
      dropped: Object.keys(previous).filter((key) => !lock[key]).length,
      unresolved: unresolved.length,
      downloadsReported: downloads.reported,
      downloadsOwed: downloads.owed,
      requests: client.requests,
      quotaRemaining: client.remaining,
    },
    unresolved.length > 0
      ? 'seed:photos: some searches wait for the next hour — run this again then'
      : 'seed:photos: every product has its photographs',
  );
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Every search, every eligible result numbered as `pick` counts them, and who wears which. */
async function writeContactSheet(
  client: UnsplashClient,
  wanted: { product: string; spec: { query: string; pick?: number }; key: string }[],
  lock: PhotoLock,
): Promise<void> {
  const queries = [...new Set(wanted.map((w) => w.spec.query))];
  const sections: string[] = [];

  for (const query of queries) {
    if (!client.isCached(query)) continue;
    const results: UnsplashPhoto[] = eligible(await client.search(query));
    const users = wanted.filter((w) => w.spec.query === query);
    const cells = results
      .map((photo, pick) => {
        const wearers = users.filter((u) => (u.spec.pick ?? 0) === pick).map((u) => u.product);
        return `<figure class="${wearers.length ? 'chosen' : ''}"><img src="${escape(photo.urls.small)}" loading="lazy"><figcaption><b>${pick}</b> ${escape(wearers.join(', ') || photo.alt_description || '')}</figcaption></figure>`;
      })
      .join('');
    sections.push(`<h2>${escape(query)}</h2><div class="grid">${cells}</div>`);
  }

  const chosen = wanted
    .map(({ product, key }) => {
      const photo = lock[key];
      return photo
        ? `<figure class="chosen"><img src="${escape(photo.url)}&w=300"><figcaption>${escape(product)}</figcaption></figure>`
        : `<figure><figcaption>${escape(product)} — unresolved</figcaption></figure>`;
    })
    .join('');

  const html = `<!doctype html><meta charset="utf-8"><title>Seed photographs</title>
<style>body{font:13px system-ui;margin:16px;background:#f6f1ea}h2{margin:24px 0 8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
figure{margin:0;background:#fff;padding:4px}figure.chosen{outline:3px solid #523523}
img{width:100%;aspect-ratio:4/5;object-fit:cover;display:block}figcaption{padding:2px}</style>
<h1>Chosen</h1><div class="grid">${chosen}</div>${sections.join('')}`;

  const file = path.join(client.cacheDir, 'contact-sheet.html');
  await writeFile(file, html);
  logger.info({ file }, 'seed:photos: contact sheet written');
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'seed:photos: failed');
  process.exit(1);
});
