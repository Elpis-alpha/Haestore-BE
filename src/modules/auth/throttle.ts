import { redis } from '../../cache/redis.js';
import { RESEND_COOLDOWN_SECONDS } from './otp.js';

/**
 * Rate limits on the sign-in path.
 *
 * These are the actual defence for a six-digit code — not the hash cost. Three
 * separate limits, because they answer three separate abuses:
 *
 * - **per email, 5/hour** — someone hammering one mailbox with codes, which is a
 *   nuisance to the owner of that mailbox whether or not it is an attack.
 * - **per IP, 20/hour** — someone walking a list of addresses to see which bounce,
 *   or simply to spray.
 * - **a 60-second cooldown per email** — a resend button held down.
 *
 * A tripped limit still answers 202 with a well-formed challenge id. Returning 429
 * here would be a signal an attacker could read, and the shape of the answer is what
 * the enumeration resistance rests on.
 */

const REQUEST_LIMIT_PER_EMAIL = 5;
const REQUEST_LIMIT_PER_IP = 20;
const WINDOW_SECONDS = 3600;

/**
 * `INCR` then conditionally `EXPIRE`, as one script.
 *
 * Issued as two commands, a crash between them leaves a counter with no TTL — which
 * is a limit that never resets, so the first person to trip it is locked out until
 * someone notices and deletes a key by hand.
 */
const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

async function countWithin(key: string, seconds: number): Promise<number> {
  return Number(await redis.eval(COUNT_SCRIPT, 1, key, String(seconds)));
}

export type ThrottleVerdict = 'send' | 'cooling-down' | 'limited';

/**
 * Decides whether this request earns an email. Always consumes the counters.
 *
 * Deliberately not refunded when the send afterwards fails: a limit you get back on
 * an error is a free retry loop, and mail failures are exactly the condition under
 * which a client retries hardest.
 */
export async function throttleCodeRequest(email: string, ip: string): Promise<ThrottleVerdict> {
  const [perEmail, perIp] = await Promise.all([
    countWithin(`otp:rl:email:${email}`, WINDOW_SECONDS),
    countWithin(`otp:rl:ip:${ip}`, WINDOW_SECONDS),
  ]);

  if (perEmail > REQUEST_LIMIT_PER_EMAIL || perIp > REQUEST_LIMIT_PER_IP) return 'limited';

  // NX makes claiming the cooldown the same operation as testing it, so two clicks
  // landing together cannot both pass.
  const claimed = await redis.set(`otp:cd:${email}`, '1', 'EX', RESEND_COOLDOWN_SECONDS, 'NX');
  return claimed === 'OK' ? 'send' : 'cooling-down';
}

/** Seconds until another code may be sent to this address, for the UI's countdown. */
export async function cooldownRemaining(email: string): Promise<number> {
  const ttl = await redis.ttl(`otp:cd:${email}`);
  return ttl > 0 ? ttl : 0;
}

export const AUTH_LIMITS = {
  REQUEST_LIMIT_PER_EMAIL,
  REQUEST_LIMIT_PER_IP,
  WINDOW_SECONDS,
} as const;
