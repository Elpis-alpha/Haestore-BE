import { describe, expect, it } from 'vitest';
import { GUEST_COOKIE, guestKeyHash, newGuestToken, readGuestCookie } from './guest-cookie.js';
import { isLineKey, lineKeyOf, parseLineKey } from './line-key.js';

const req = (cookies: Record<string, unknown>) =>
  ({ cookies }) as unknown as Parameters<typeof readGuestCookie>[0];

describe('the guest cookie', () => {
  it('carries the __Host- prefix', () => {
    // Browser-enforced: no Domain, Secure, Path=/. It is the only defence against a
    // sibling origin planting somebody else's shopping in the jar.
    expect(GUEST_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('mints 128 bits, base64url', () => {
    const token = newGuestToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newGuestToken()).not.toBe(token);
  });

  it('hashes to a stable 256-bit digest that is not the token', () => {
    const token = newGuestToken();
    const digest = guestKeyHash(token);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(guestKeyHash(token));
    expect(digest).not.toContain(token);
    expect(guestKeyHash(newGuestToken())).not.toBe(digest);
  });

  it('refuses an unbounded cookie value', () => {
    // The value is attacker-supplied and becomes an HMAC input. Hashing an arbitrarily
    // long string on every cart request is free work for anybody who asks for it.
    expect(readGuestCookie(req({ [GUEST_COOKIE]: 'x'.repeat(65) }))).toBeUndefined();
    expect(readGuestCookie(req({ [GUEST_COOKIE]: 'x'.repeat(64) }))).toBe('x'.repeat(64));
  });

  it('ignores a missing, empty or non-string cookie', () => {
    expect(readGuestCookie(req({}))).toBeUndefined();
    expect(readGuestCookie(req({ [GUEST_COOKIE]: '' }))).toBeUndefined();
    expect(readGuestCookie(req({ [GUEST_COOKIE]: 42 }))).toBeUndefined();
  });
});

describe('line keys', () => {
  const p = '65a000000000000000000001';
  const v = '65b000000000000000000002';

  it('is derived from the pair, so two carts agree without ever meeting', () => {
    expect(lineKeyOf(p, v)).toBe(`${p}_${v}`);
    expect(lineKeyOf(p.toUpperCase(), v.toUpperCase())).toBe(lineKeyOf(p, v));
  });

  it('uses no colon', () => {
    // A colon in an id is how Phase 3 silently discarded every second reindex: BullMQ
    // namespaces its own keys with one. This key travels in URLs and may yet become a
    // job id, so it does not carry the character that bit last time.
    expect(lineKeyOf(p, v)).not.toContain(':');
  });

  it('rejects anything that is not a pair of object ids', () => {
    expect(isLineKey(lineKeyOf(p, v))).toBe(true);
    expect(isLineKey('not-a-key')).toBe(false);
    expect(isLineKey(`${p}_`)).toBe(false);
    expect(isLineKey(`${p}_${v}_${v}`)).toBe(false);
    expect(isLineKey(`${p.toUpperCase()}_${v}`)).toBe(false);
    expect(parseLineKey('nope')).toBeNull();
  });

  it('splits back into its halves', () => {
    expect(parseLineKey(lineKeyOf(p, v))).toEqual({ productId: p, variantId: v });
  });
});
