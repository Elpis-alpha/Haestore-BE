import { createHmac, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { env, requireConfigured } from '../../config/env.js';

/**
 * Guest identity.
 *
 * **This is deliberately not the session cookie**, and the reason is that the two have
 * opposite requirements at exactly one moment. On sign-in the session id must *rotate*,
 * because an id that survives a privilege change is a session-fixation hole; the guest
 * token must *survive*, because it is the only thing that can find the cart the person
 * filled before signing in. One cookie cannot do both, so there are two.
 *
 * It carries the `__Host-` prefix for the same browser-enforced reasons as the session
 * cookie — `Secure`, `Path=/`, and no `Domain`, so script on a sibling origin cannot
 * plant one. The plan called it `hae_cid`; the prefix is added because the argument
 * that earned it for the sid applies unchanged here. A planted guest cookie is a
 * smaller prize than a planted session, but it is somebody else's shopping.
 *
 * **It is set lazily, on the first add-to-cart, and never on a page view.** Somebody who
 * browses the shop and leaves gets no cookie at all — which keeps a consent banner off
 * the storefront, and means the cart collection is bounded by people who added something
 * rather than by visits.
 */
export const GUEST_COOKIE = '__Host-hae_cid';

/**
 * Thirty days, matching the session. A guest cart's TTL index uses the same window, so
 * the cookie and the cart it names expire together rather than leaving a live cookie
 * pointing at a swept document.
 */
export const GUEST_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;

const GUEST_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  /**
   * `Lax`, like the session. The cart has to survive the redirect back from Stripe or
   * PayPal in Phase 7, and `Strict` withholds the cookie on exactly that navigation —
   * so a guest would return from paying with an empty bag.
   */
  sameSite: 'lax',
  path: '/',
  maxAge: GUEST_COOKIE_TTL_SECONDS * 1000,
};

/**
 * The stored key is an HMAC of the token, not the token.
 *
 * The same argument as the OTP pepper and the session key: a database dump yields
 * digests, and a digest is not a cookie. Keyed rather than a bare SHA-256 so the
 * mapping cannot be recomputed by anyone holding only the data — the secret lives in
 * the environment and never in Mongo, which is what makes the two halves independent.
 */
export function guestKeyHash(token: string): string {
  requireConfigured('The guest cart', ['GUEST_COOKIE_SECRET']);
  return createHmac('sha256', env.GUEST_COOKIE_SECRET as string)
    .update(token)
    .digest('hex');
}

/** 128 bits, base64url so it is cookie-safe without escaping. */
export function newGuestToken(): string {
  return randomBytes(16).toString('base64url');
}

export function readGuestCookie(req: Request): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[GUEST_COOKIE];
  // Bounded before it is used as an HMAC input: the value is attacker-supplied, and
  // hashing an unbounded string on every cart request is free work for anybody who
  // wants it done.
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return undefined;
  return value;
}

export function setGuestCookie(res: Response, token: string): void {
  res.cookie(GUEST_COOKIE, token, GUEST_COOKIE_OPTIONS);
}

/** Attributes must match exactly, or this expires a different cookie. See session-cookie.ts. */
export function clearGuestCookie(res: Response): void {
  res.clearCookie(GUEST_COOKIE, { ...GUEST_COOKIE_OPTIONS, maxAge: undefined });
}

/**
 * The bag count, in a cookie the browser may read.
 *
 * Not a credential and not a source of truth — a number, so the header can render a
 * badge without a round trip and without making every page dynamic. The drawer always
 * shows the server's answer; this only decides whether a "3" appears next to the
 * handle a moment sooner.
 *
 * `httpOnly` is off on purpose, because the point is that client script reads it. It is
 * therefore also forgeable, which costs nothing: forging it changes a number on your own
 * screen and no total anywhere.
 */
export const BAG_COUNT_COOKIE = 'hae_bag';

export function setBagCount(res: Response, count: number): void {
  res.cookie(BAG_COUNT_COOKIE, String(count), {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: GUEST_COOKIE_TTL_SECONDS * 1000,
  });
}

/**
 * "There is a merge report waiting", in a cookie the browser may read.
 *
 * The same device as the bag count, for the same reason. Without it the cart page has
 * to ask the API on every visit whether a merge happened — which is a 401 in the console
 * for every signed-out shopper and a wasted round trip for every signed-in one, to be
 * told "no" almost always. With it, the page asks only when the answer is yes.
 *
 * Readable, forgeable and worthless: forging it makes your own browser fetch a report
 * that is not there and render nothing.
 */
export const MERGE_FLAG_COOKIE = 'hae_merge';

export function setMergeFlag(res: Response, present: boolean): void {
  if (!present) {
    res.clearCookie(MERGE_FLAG_COOKIE, {
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    return;
  }
  res.cookie(MERGE_FLAG_COOKIE, '1', {
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    path: '/',
    // A week, matching the undo window. After that there is nothing left to show.
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
