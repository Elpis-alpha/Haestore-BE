import type { Request } from 'express';

/**
 * The caller's address, in one spelling.
 *
 * Node listening on a dual-stack socket reports an IPv4 client as the IPv4-mapped
 * IPv6 form, `::ffff:127.0.0.1`. Left alone that is two bugs, not one cosmetic
 * problem: the same client reaching the API over both forms gets **two separate
 * rate-limit buckets**, doubling every per-IP limit; and the device list shows a
 * shopper an address they will not recognise as their own.
 *
 * So it is normalised once, here, and both the limiter and the session record read
 * the result — rather than each normalising, or one of them forgetting to.
 */
export function clientIp(req: Request): string {
  const ip = req.ip ?? '';
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(ip);
  return mapped?.[1] ?? ip;
}
