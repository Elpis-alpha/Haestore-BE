import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS } from './session-cookie.js';
import { SESSION_TTL_SECONDS } from './session.js';

/**
 * A drift guard, in the spirit of the design system's token tests.
 *
 * The `__Host-` prefix is a contract the *browser* enforces by silently refusing the
 * cookie. There is no error, no log line and no failed request — sign-in simply never
 * sticks, on production only, because the attribute that broke it is one nobody
 * exercises locally. So the contract is asserted here, where breaking it is loud.
 */
describe('the session cookie', () => {
  it('carries the __Host- prefix', () => {
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('is Secure, which the prefix requires', () => {
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(true);
  });

  it('is Path=/, which the prefix requires', () => {
    expect(SESSION_COOKIE_OPTIONS.path).toBe('/');
  });

  it('declares no Domain, which is the clause that actually defends anything', () => {
    // With a Domain attribute, script on any subdomain could set a session cookie the
    // API would accept and could not distinguish from one it issued. The prefix makes
    // the browser refuse that; this test makes us refuse to ask for it.
    expect(SESSION_COOKIE_OPTIONS.domain).toBeUndefined();
  });

  it('is HttpOnly, so no script can read it', () => {
    expect(SESSION_COOKIE_OPTIONS.httpOnly).toBe(true);
  });

  it('is SameSite=Lax, not Strict, so returning from a payment provider keeps you signed in', () => {
    expect(SESSION_COOKIE_OPTIONS.sameSite).toBe('lax');
  });

  it('expires with the server-side session rather than outliving it', () => {
    expect(SESSION_COOKIE_OPTIONS.maxAge).toBe(SESSION_TTL_SECONDS * 1000);
  });
});
