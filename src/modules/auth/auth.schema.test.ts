import { describe, expect, it } from 'vitest';
import { emailSchema, requestCodeSchema, verifyCodeSchema } from './auth.schema.js';

describe('emailSchema', () => {
  it('lowercases and trims, so the stored address and the hashed one are one string', () => {
    expect(emailSchema.parse('  Shopper@Example.TEST ')).toBe('shopper@example.test');
  });

  it('does not apply Gmail normalisation', () => {
    // Stripping dots or cutting at "+" would merge addresses their owner treats as
    // separate, and the rules are the provider's to change. The address is an identity.
    expect(emailSchema.parse('first.last+shop@gmail.com')).toBe('first.last+shop@gmail.com');
  });

  it('rejects something that is not an address', () => {
    expect(emailSchema.safeParse('not-an-address').success).toBe(false);
  });
});

describe('requestCodeSchema', () => {
  it('refuses unknown keys, so nothing extra reaches the service', () => {
    expect(requestCodeSchema.safeParse({ email: 'a@b.test', roles: ['admin'] }).success).toBe(
      false,
    );
  });
});

describe('verifyCodeSchema', () => {
  it('accepts a code pasted with the spacing a mail client adds', () => {
    expect(verifyCodeSchema.parse({ challengeId: crypto.randomUUID(), code: '123 456' }).code).toBe(
      '123456',
    );
    expect(verifyCodeSchema.parse({ challengeId: crypto.randomUUID(), code: '123-456' }).code).toBe(
      '123456',
    );
  });

  it('rejects a code of the wrong length rather than truncating it', () => {
    const challengeId = crypto.randomUUID();
    expect(verifyCodeSchema.safeParse({ challengeId, code: '12345' }).success).toBe(false);
    expect(verifyCodeSchema.safeParse({ challengeId, code: '1234567' }).success).toBe(false);
  });

  it('rejects a challenge id that is not a uuid, before it can become a Redis key', () => {
    expect(verifyCodeSchema.safeParse({ challengeId: 'otp:*', code: '123456' }).success).toBe(
      false,
    );
  });
});
