import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { redis } from '../../cache/redis.js';
import { env } from '../../config/env.js';

/**
 * The one-time code: generation, hashing, and a single-use compare in Redis.
 *
 * Every constant here is a security boundary, so they are named rather than inlined.
 */
export const CODE_LENGTH = 6;
export const CHALLENGE_TTL_SECONDS = 600;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;

const challengeKey = (challengeId: string) => `otp:${challengeId}`;

/**
 * Six numeric digits.
 *
 * `crypto.randomInt` rejection-samples, so every value is equally likely.
 * `Math.floor(Math.random() * 1e6)` — the 2022 app's habit — is both non-cryptographic
 * and modulo-biased. Numeric rather than alphanumeric so `inputmode="numeric"` and
 * `autocomplete="one-time-code"` autofill it from the notification on iOS, which is
 * worth more in practice than the extra entropy of a mixed alphabet that people
 * mistype.
 */
export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/**
 * `HMAC-SHA256(pepper, challengeId + email + code)`, not bcrypt.
 *
 * bcrypt's work factor defends a large offline search space; a six-digit code has 10⁶
 * possibilities and falls to a dump-holder whatever the cost factor. What actually
 * protects it is the pepper, which lives in the environment and never in Redis — so a
 * Redis dump alone is useless. See ADR-004.
 *
 * The challenge id and email are inside the hash, which is what stops a code observed
 * on one challenge from verifying another, or a code mailed to one address from being
 * replayed against a different one.
 */
export function hashCode(challengeId: string, email: string, code: string): string {
  if (!env.OTP_PEPPER) {
    throw new Error('Sign-in is not configured: set OTP_PEPPER in back-end/.env');
  }
  return createHmac('sha256', env.OTP_PEPPER).update(`${challengeId}${email}${code}`).digest('hex');
}

export type Challenge = { challengeId: string; code: string };

/**
 * Creates a challenge and returns the code for the caller to mail.
 *
 * The id goes to the browser and the code goes to the mailbox, so possessing one
 * without the other proves nothing. The record holds the email because verification
 * must not trust the client to say whose code it is holding.
 */
export async function createChallenge(email: string): Promise<Challenge> {
  const challengeId = randomUUID();
  const code = generateCode();

  await redis
    .multi()
    .hset(challengeKey(challengeId), {
      email,
      codeHash: hashCode(challengeId, email, code),
      attempts: '0',
    })
    .expire(challengeKey(challengeId), CHALLENGE_TTL_SECONDS)
    .exec();

  return { challengeId, code };
}

export async function discardChallenge(challengeId: string): Promise<void> {
  await redis.del(challengeKey(challengeId));
}

/**
 * Compare, count and delete in one atomic step.
 *
 * A read-then-delete in application code is two round trips, and two concurrent
 * verifications of the same code can both pass between them — which turns a
 * single-use code into a reusable one for as long as the race window lasts. A Lua
 * script runs to completion with nothing interleaved, so "correct" and "consumed"
 * are the same event.
 *
 * The string comparison is not constant-time, and does not need to be: the value
 * compared is an HMAC under a pepper the attacker does not have, so there is no input
 * they can steer towards a longer match.
 */
const VERIFY_SCRIPT = `
local key = KEYS[1]
local expected = ARGV[1]
local maxAttempts = tonumber(ARGV[2])

if redis.call('EXISTS', key) == 0 then
  return {'expired', ''}
end

if redis.call('HGET', key, 'codeHash') == expected then
  local email = redis.call('HGET', key, 'email')
  redis.call('DEL', key)
  return {'ok', email}
end

local attempts = redis.call('HINCRBY', key, 'attempts', 1)
if attempts >= maxAttempts then
  redis.call('DEL', key)
  return {'locked', ''}
end
return {'wrong', tostring(maxAttempts - attempts)}
`;

export type VerifyResult =
  | { outcome: 'ok'; email: string }
  | { outcome: 'expired' }
  | { outcome: 'locked' }
  | { outcome: 'wrong'; attemptsRemaining: number };

export async function consumeChallenge(challengeId: string, code: string): Promise<VerifyResult> {
  // The email inside the record is the one hashed, so the candidate hash has to be
  // built from it rather than from anything the client sent. Reading it first costs a
  // round trip and removes the possibility of verifying against an attacker's email.
  const email = await redis.hget(challengeKey(challengeId), 'email');
  if (email === null) return { outcome: 'expired' };

  const [outcome = 'expired', detail = ''] = (await redis.eval(
    VERIFY_SCRIPT,
    1,
    challengeKey(challengeId),
    hashCode(challengeId, email, code),
    String(MAX_ATTEMPTS),
  )) as string[];

  if (outcome === 'ok') return { outcome: 'ok', email: detail };
  if (outcome === 'locked') return { outcome: 'locked' };
  if (outcome === 'wrong') return { outcome: 'wrong', attemptsRemaining: Number(detail) };
  return { outcome: 'expired' };
}
