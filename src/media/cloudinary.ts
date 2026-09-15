import { createHash } from 'node:crypto';
import { env, requireConfigured } from '../config/env.js';
import { notFound, serviceUnavailable } from '../lib/errors.js';
import { isCloudinaryPublicId } from '../modules/catalog/image-source.js';

/**
 * Cloudinary, for the shop's own photographs.
 *
 * Reached with `fetch` and a SHA-1 signature rather than the SDK — ADR-012's argument for
 * the payment providers, at a smaller scale: the console needs a signed upload and one
 * read-back, and neither justifies a dependency that also knows how to do two hundred
 * other things.
 *
 * **The browser uploads, and the server signs and then checks.** The file goes from the
 * admin's browser straight to Cloudinary, so a photograph never passes through the API's
 * one-megabyte body limit or its memory. What the server contributes is a signature over
 * the folder and the formats, which is what stops the upload being used to put something
 * else somewhere else, and afterwards a read of the resource from Cloudinary's own API —
 * the browser's word that it uploaded something is not how the shop learns its size.
 *
 * The seed's photographs are not here at all: Unsplash's are hotlinked (ADR-015).
 */

/** Parameters Cloudinary leaves out of the string it signs. */
const NOT_SIGNED = new Set(['file', 'cloud_name', 'resource_type', 'api_key']);

/**
 * Cloudinary's signature: the parameters sorted by name, joined as a query string without
 * encoding, with the secret appended, SHA-1 in hex.
 */
export function signParams(params: Record<string, string | number>, secret: string): string {
  const serialised = Object.keys(params)
    .filter((key) => !NOT_SIGNED.has(key) && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return createHash('sha1')
    .update(serialised + secret)
    .digest('hex');
}

export const PRODUCT_UPLOAD_FORMATS = 'jpg,jpeg,png,webp,avif';

export function productFolder(): string {
  return `${env.CLOUDINARY_FOLDER}/products`;
}

function credentials() {
  try {
    requireConfigured('Cloudinary', [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ]);
  } catch (err) {
    throw serviceUnavailable(
      'Photograph uploads are not set up on this shop: Cloudinary has no credentials.',
      err,
    );
  }
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME!,
    apiKey: env.CLOUDINARY_API_KEY!,
    apiSecret: env.CLOUDINARY_API_SECRET!,
  };
}

export type UploadTicket = {
  uploadUrl: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  allowedFormats: string;
  signature: string;
};

/**
 * Everything the browser sends alongside the file. Cloudinary refuses a signature more than
 * an hour old, so a ticket is asked for per upload rather than kept.
 */
export function issueUploadTicket(now = Date.now()): UploadTicket {
  const { cloudName, apiKey, apiSecret } = credentials();
  const timestamp = Math.floor(now / 1000);
  const folder = productFolder();
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    apiKey,
    timestamp,
    folder,
    allowedFormats: PRODUCT_UPLOAD_FORMATS,
    signature: signParams(
      { allowed_formats: PRODUCT_UPLOAD_FORMATS, folder, timestamp },
      apiSecret,
    ),
  };
}

export type UploadedPhotograph = {
  publicId: string;
  width: number;
  height: number;
  blurDataUrl?: string;
};

type Fetch = typeof fetch;

/**
 * What Cloudinary holds under a public id the browser says it just uploaded.
 *
 * Only ids in the products folder are looked up, so this cannot be used to read the
 * dimensions of anything else in the account.
 */
export async function describeUpload(
  publicId: string,
  fetchImpl: Fetch = fetch,
): Promise<UploadedPhotograph> {
  const { cloudName, apiKey, apiSecret } = credentials();
  if (!isCloudinaryPublicId(publicId) || !publicId.startsWith(`${productFolder()}/`)) {
    throw notFound('That photograph was not uploaded to this shop.');
  }

  const path = publicId.split('/').map(encodeURIComponent).join('/');
  const response = await fetchImpl(
    `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload/${path}`,
    {
      headers: {
        authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(10_000),
    },
  ).catch((err: unknown) => {
    throw serviceUnavailable('Cloudinary did not answer. Try again in a moment.', err);
  });

  if (response.status === 404) {
    throw notFound('Cloudinary has no photograph by that id. Upload it again.');
  }
  if (!response.ok) {
    throw serviceUnavailable(`Cloudinary answered ${response.status}. Try again in a moment.`);
  }

  const resource = (await response.json()) as { public_id: string; width: number; height: number };
  const blurDataUrl = await placeholderFor(cloudName, resource.public_id, fetchImpl);

  return {
    publicId: resource.public_id,
    width: resource.width,
    height: resource.height,
    ...(blurDataUrl ? { blurDataUrl } : {}),
  };
}

/** Largest placeholder worth inlining into every listing response that shows the photograph. */
const PLACEHOLDER_MAX_BYTES = 2_000;

/**
 * A sixteen-pixel JPEG of the shop's own photograph, inlined as the blur placeholder.
 *
 * Best effort: a photograph without a placeholder renders perfectly well, so a failure here
 * is not a reason to refuse the upload.
 */
async function placeholderFor(
  cloudName: string,
  publicId: string,
  fetchImpl: Fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(
      `https://res.cloudinary.com/${cloudName}/image/upload/w_16,q_auto:low,f_jpg/${publicId}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > PLACEHOLDER_MAX_BYTES) return undefined;
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}
