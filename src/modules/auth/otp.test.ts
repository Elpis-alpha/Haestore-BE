import { describe, expect, it } from 'vitest';
import { CODE_LENGTH, generateCode, hashCode } from './otp.js';

describe('generateCode', () => {
  it('is always six digits, leading zeros kept', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateCode()).toMatch(new RegExp(`^\\d{${CODE_LENGTH}}$`));
    }
  });

  it('reaches the whole space, including the low values padding hides', () => {
    // A `Math.floor(Math.random() * 900000) + 100000` generator — the common shortcut —
    // never emits anything below 100000, quietly costing a tenth of the keyspace. This
    // asserts the low decade is reachable rather than that any particular draw happens.
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(generateCode()[0] ?? '');
    expect(seen).toContain('0');
    expect(seen.size).toBe(10);
  });
});

describe('hashCode', () => {
  const challengeId = '0f3b2b3e-3c0e-4b1a-9f2a-4b6a1c2d3e4f';

  it('is stable for the same inputs', () => {
    expect(hashCode(challengeId, 'a@b.test', '123456')).toBe(
      hashCode(challengeId, 'a@b.test', '123456'),
    );
  });

  it('binds the code to its challenge, so an observed code cannot be replayed', () => {
    const other = 'ffffffff-3c0e-4b1a-9f2a-4b6a1c2d3e4f';
    expect(hashCode(challengeId, 'a@b.test', '123456')).not.toBe(
      hashCode(other, 'a@b.test', '123456'),
    );
  });

  it('binds the code to its address, so a code cannot be redirected to another account', () => {
    expect(hashCode(challengeId, 'a@b.test', '123456')).not.toBe(
      hashCode(challengeId, 'attacker@b.test', '123456'),
    );
  });

  it('does not contain the code, the email or the pepper', () => {
    const digest = hashCode(challengeId, 'a@b.test', '123456');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('123456');
    expect(digest).not.toContain('a@b.test');
    expect(digest).not.toContain('unit_test_pepper');
  });
});
