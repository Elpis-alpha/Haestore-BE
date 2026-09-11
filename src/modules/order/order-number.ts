import { randomInt, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { env, requireConfigured } from '../../config/env.js';

/**
 * Human-facing order numbers, and the token that makes a guest order readable.
 *
 * **`HAE-` plus eight Crockford base32 characters**, drawn from `crypto.randomInt`
 * rather than a counter. A sequential number tells anyone who places two orders how
 * many the shop took in between — the classic invoice-number leak — and it also makes
 * a neighbouring order trivially guessable. Random costs nothing here because the
 * number is not the access control; it is a label a customer can read down a phone.
 *
 * The alphabet omits `I`, `L`, `O` and `U`: the first three because they are
 * indistinguishable from `1` and `0` when read aloud or typed from a printed slip, and
 * `U` because excluding it is what stops the generator producing a word somebody has
 * to read out to support.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 8;

export function generateOrderNumber(): string {
  let body = '';
  for (let i = 0; i < LENGTH; i += 1) {
    body += ALPHABET[randomInt(ALPHABET.length)];
  }
  return `HAE-${body}`;
}

/** Accepts what `generateOrderNumber` produces, case-insensitively. */
export const ORDER_NUMBER_PATTERN = /^HAE-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

/**
 * Normalises an order number the way Crockford base32 intends, and the reason is a
 * defect found by looking at a real confirmation page.
 *
 * Excluding `O`, `I` and `L` from the *alphabet* is only half of the scheme. It stops
 * the generator producing a character that looks like another one — but it does nothing
 * about the reader, who sees `HAE-CJ0RTHPK` rendered in a humanist face with an unslashed
 * zero, reads it as the letter O, and types `HAE-CJORTHPK`. Without this, that lookup
 * returns 404 and the customer is told their order does not exist.
 *
 * So decoding folds the ambiguous characters onto the ones the alphabet actually uses:
 * `O` → `0`, and `I` and `L` → `1`. The mapping is safe precisely *because* the
 * generator never emits `O`, `I` or `L` — there is no legitimate order number those
 * characters could belong to, so folding them can never collide with a real one.
 *
 * Hyphens and spaces are stripped too, because a number read down a phone arrives with
 * whatever spacing the listener felt like.
 */
export function normaliseOrderNumber(value: string): string {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');

  // The prefix is re-attached rather than preserved, so 'hae cj0rthpk', 'HAE-CJ0RTHPK'
  // and 'CJORTHPK' all resolve to the same number.
  const body = cleaned.startsWith('HAE') ? cleaned.slice(3) : cleaned;
  return `HAE-${body}`;
}

export function isOrderNumber(value: string): boolean {
  return ORDER_NUMBER_PATTERN.test(normaliseOrderNumber(value));
}

/**
 * The guest claim token.
 *
 * A guest has no account, so `/orders/HAE-…` cannot be authorised by a session — but it
 * still must not be readable by anyone who guesses a number. The order confirmation
 * email links to `/orders/HAE-…?t=<token>`, and the token is what authorises the read.
 *
 * **Stored as an HMAC, never in the clear**, for the same reason as the session id and
 * the guest cookie: a database dump then yields no working links. `GUEST_COOKIE_SECRET`
 * keys it, so the digest cannot be recomputed by anyone holding only the dump.
 */
export function generateClaimToken(): string {
  return randomBytes(24).toString('base64url');
}

export function hashClaimToken(token: string): string {
  requireConfigured('Guest order links', ['GUEST_COOKIE_SECRET']);
  return createHmac('sha256', env.GUEST_COOKIE_SECRET as string)
    .update(token)
    .digest('hex');
}

/**
 * Compared in constant time. The window is small — an attacker would have to guess the
 * order number first — but a timing-variable compare on a credential is the kind of
 * thing that is free to get right and embarrassing to explain.
 */
export function claimTokenMatches(token: string, storedHash: string | null | undefined): boolean {
  if (!storedHash) return false;
  const candidate = Buffer.from(hashClaimToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
