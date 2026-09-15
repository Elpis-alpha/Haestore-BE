import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { slugify } from '../lib/slug.js';

/**
 * The Unsplash API, as the seed uses it: search, and report a download.
 *
 * **Every search response is cached on disk and never asked for twice.** A demo key allows
 * fifty requests an hour, and a seed that searched on every run would spend an afternoon
 * waiting for the quota. With the cache, choosing a different photograph from a search
 * already made costs nothing, and a reseed costs nothing at all.
 *
 * **A download is reported once per photograph per machine**, recorded in a ledger beside
 * the cache. Unsplash asks for `download_location` to be requested when an application
 * *uses* a photograph — puts it in a post, sets it as a header — and a product page showing
 * it is that use. Reporting it again on every reseed of the same database would count one
 * decision many times.
 *
 * The client stops, rather than retrying, at the rate limit: `RateLimited` is the signal to
 * the caller that the rest can wait for the next hour, and every caller treats it that way.
 */

export type UnsplashPhoto = {
  id: string;
  width: number;
  height: number;
  color: string | null;
  blur_hash: string | null;
  description: string | null;
  alt_description: string | null;
  premium?: boolean;
  urls: { raw: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; username: string; links: { html: string } };
};

export class RateLimited extends Error {
  constructor() {
    super('Unsplash rate limit reached for this hour.');
    this.name = 'RateLimited';
  }
}

/** Beside the root repo's assets when the three repos are checked out together. */
export function defaultCacheDir(cwd = process.cwd()): string {
  if (env.UNSPLASH_CACHE_DIR) return path.resolve(cwd, env.UNSPLASH_CACHE_DIR);
  const assets = path.resolve(cwd, '..', 'assets');
  return existsSync(assets)
    ? path.join(assets, '.unsplash-cache')
    : path.resolve(cwd, '.unsplash-cache');
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Written to a temporary name and renamed, so an interrupted seed never leaves half a file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

type Fetch = typeof fetch;

export type SearchOptions = { orientation?: 'portrait' | 'landscape' | 'squarish' };

export class UnsplashClient {
  /** What the last response said was left this hour, or null before any request. */
  remaining: number | null = null;
  requests = 0;

  constructor(
    private readonly accessKey: string | undefined,
    readonly cacheDir: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get canRequest(): boolean {
    return Boolean(this.accessKey) && this.remaining !== 0;
  }

  private async request(url: string): Promise<Response> {
    if (!this.accessKey) throw new Error('UNSPLASH_ACCESS_KEY is not set.');
    if (this.remaining === 0) throw new RateLimited();

    const response = await this.fetchImpl(url, {
      headers: { authorization: `Client-ID ${this.accessKey}`, 'accept-version': 'v1' },
      signal: AbortSignal.timeout(15_000),
    });
    this.requests += 1;

    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining !== '') this.remaining = Number(remaining);

    // Unsplash answers an exhausted quota with a 403 and the words in the body; a 429 is
    // accepted too, in case that ever changes.
    if (response.status === 429 || (response.status === 403 && this.remaining === 0)) {
      this.remaining = 0;
      throw new RateLimited();
    }
    if (response.status === 403) {
      const text = await response.text().catch(() => '');
      if (/rate limit/i.test(text)) {
        this.remaining = 0;
        throw new RateLimited();
      }
      throw new Error(`Unsplash refused the request (403): ${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new Error(`Unsplash answered ${response.status} for ${new URL(url).pathname}`);
    }
    return response;
  }

  private searchFile(query: string, options: SearchOptions): string {
    const orientation = options.orientation ?? 'portrait';
    return path.join(this.cacheDir, 'search', `${slugify(query)}--${orientation}.json`);
  }

  /** Whether a search is answered from disk, so a caller can plan around the quota. */
  isCached(query: string, options: SearchOptions = {}): boolean {
    return existsSync(this.searchFile(query, options));
  }

  /**
   * Thirty results, filtered for content by Unsplash, portrait by default because a shelf
   * card and the product page's frame are both taller than wide.
   */
  async search(query: string, options: SearchOptions = {}): Promise<UnsplashPhoto[]> {
    const file = this.searchFile(query, options);
    const cached = await readJson<{ results: UnsplashPhoto[] }>(file);
    if (cached) return cached.results;

    const params = new URLSearchParams({
      query,
      per_page: '30',
      orientation: options.orientation ?? 'portrait',
      content_filter: 'high',
    });
    const response = await this.request(
      `https://api.unsplash.com/search/photos?${params.toString()}`,
    );
    const body = (await response.json()) as { results: UnsplashPhoto[] };

    await writeJson(file, {
      query,
      orientation: options.orientation ?? 'portrait',
      fetchedAt: new Date().toISOString(),
      results: body.results,
    });
    return body.results;
  }

  private get ledgerFile(): string {
    return path.join(this.cacheDir, 'downloads.json');
  }

  async reportedDownloads(): Promise<Record<string, string>> {
    return (await readJson<Record<string, string>>(this.ledgerFile)) ?? {};
  }

  /**
   * Reports the downloads not yet reported from this machine, until the quota runs out.
   * Returns how many were reported and how many are still owed.
   */
  async reportDownloads(
    photos: { id: string; downloadLocation: string }[],
  ): Promise<{ reported: number; owed: number }> {
    const ledger = await this.reportedDownloads();
    const unique = [...new Map(photos.map((p) => [p.id, p])).values()];
    const pending = unique.filter((photo) => !ledger[photo.id]);

    let reported = 0;
    try {
      for (const photo of pending) {
        if (!this.canRequest) break;
        await this.request(photo.downloadLocation);
        ledger[photo.id] = new Date().toISOString();
        reported += 1;
      }
    } catch (err) {
      if (!(err instanceof RateLimited)) throw err;
    } finally {
      if (reported > 0) await writeJson(this.ledgerFile, ledger);
    }
    return { reported, owed: pending.length - reported };
  }
}
