import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { clientIp } from './client-ip.js';

const asRequest = (ip: string | undefined) => ({ ip }) as Request;

describe('clientIp', () => {
  it('unwraps the IPv4-mapped form Node reports on a dual-stack socket', () => {
    // Left alone, this and "127.0.0.1" are two rate-limit buckets for one client,
    // which quietly doubles every per-IP limit.
    expect(clientIp(asRequest('::ffff:127.0.0.1'))).toBe('127.0.0.1');
    expect(clientIp(asRequest('::ffff:203.0.113.9'))).toBe('203.0.113.9');
  });

  it('leaves a real IPv6 address alone', () => {
    expect(clientIp(asRequest('2001:db8::1'))).toBe('2001:db8::1');
    expect(clientIp(asRequest('::1'))).toBe('::1');
  });

  it('leaves a plain IPv4 address alone', () => {
    expect(clientIp(asRequest('203.0.113.9'))).toBe('203.0.113.9');
  });

  it('does not unwrap something that merely looks like the prefix', () => {
    expect(clientIp(asRequest('::ffff:2001:db8::1'))).toBe('::ffff:2001:db8::1');
  });

  it('is a string even when Express has no address', () => {
    expect(clientIp(asRequest(undefined))).toBe('');
  });
});
