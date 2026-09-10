import type { CookieOptions, Request, Response } from 'express';
import { SESSION_TTL_SECONDS } from './session.js';

/**
 * The session cookie.
 *
 * **`__Host-` is not decoration.** The prefix is a browser-enforced contract: a cookie
 * whose name starts with it is rejected outright unless it is `Secure`, has `Path=/`,
 * and carries **no `Domain` attribute**. That last clause is the one that matters —
 * without it, script running on any subdomain can set a session cookie that the API
 * will accept, and the API cannot tell it apart from one it issued itself. Nothing in
 * server code can defend against that; the prefix moves the check into the browser.
 *
 * It is why the frontend proxies `/api/*` through a Next rewrite (ADR-001): a cookie
 * with no `Domain` is single-origin by definition, so the browser must only ever see
 * one origin. Server components call the API directly and deliberately do not carry
 * this cookie.
 *
 * The prefix is kept in development too, rather than dropped for convenience. Browsers
 * treat `localhost` as a secure context, so `Secure` is honoured over plain http there
 * and the development path is the same path that ships. Special-casing it would repeat
 * the mistake ADR-007 removed: exercising a configuration that cannot go to production.
 */
export const SESSION_COOKIE = '__Host-hae_sid';

export const SESSION_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  /**
   * `Lax`, not `Strict`. `Strict` withholds the cookie on any cross-site navigation,
   * including the redirect back from Stripe or PayPal — so the shopper returns from
   * paying and appears to be signed out, mid-checkout. `Lax` still blocks the
   * cross-site POST that CSRF needs, and `originGuard` is the second lock.
   */
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_TTL_SECONDS * 1000,
};

export function setSessionCookie(res: Response, sessionId: string): void {
  res.cookie(SESSION_COOKIE, sessionId, SESSION_COOKIE_OPTIONS);
}

/**
 * Clearing must repeat the attributes exactly.
 *
 * A cookie is identified by name, domain and path; `clearCookie` with different
 * options sets a *different* cookie's expiry and leaves the real one in place — which
 * looks like a sign-out that did not work, but only on some routes.
 */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...SESSION_COOKIE_OPTIONS, maxAge: undefined });
}

export function readSessionCookie(req: Request): string | undefined {
  const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[SESSION_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
