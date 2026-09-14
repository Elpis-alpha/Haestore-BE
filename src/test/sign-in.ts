import type { Express } from 'express';
import request from 'supertest';
import { redis } from '../cache/redis.js';
import { clearOutbox, readOutbox } from '../mail/dev-outbox.js';
import { SESSION_COOKIE } from '../modules/auth/session-cookie.js';
import { deviceIdOf } from '../modules/auth/session.js';

/**
 * Signing in, for integration tests that need a session rather than test the sign-in.
 *
 * It goes through the real OTP round trip — request a code, read it from the dev outbox
 * the way a person reads their mail, verify it — so a session made here is exactly the
 * session a browser holds. A shortcut that wrote a session straight into Redis would let
 * a test pass against a session shape the sign-in never produces.
 */

export const ORIGIN = 'http://localhost:3000';

/** On ADMIN_EMAILS in setup-integration.ts, so it becomes an admin at verification. */
export const ADMIN_EMAIL = 'keeper@haestore.test';

export type TestSession = { cookie: string; sessionId: string; userId: string };

export async function signIn(app: Express, email: string): Promise<TestSession> {
  // Past the 60-second resend cooldown, which is per address: a test signing the same
  // person in twice would otherwise read a stale code.
  await redis.del(`otp:cd:${email}`);
  clearOutbox();

  const requested = await request(app)
    .post('/api/auth/otp/request')
    .set('Origin', ORIGIN)
    .send({ email })
    .expect(202);
  const { challengeId } = (requested.body as { data: { challengeId: string } }).data;

  const message = readOutbox().find((entry) => entry.to === email);
  const code = message ? /\b(\d{6})\b/.exec(message.subject)?.[1] : undefined;
  if (!code) throw new Error(`No sign-in code was sent to ${email}`);

  const verified = await request(app)
    .post('/api/auth/otp/verify')
    .set('Origin', ORIGIN)
    .send({ challengeId, code })
    .expect(200);

  const header: unknown = verified.headers['set-cookie'];
  const values = Array.isArray(header) ? (header as string[]) : [String(header)];
  const sessionId = values
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`))
    ?.split(';')[0]
    ?.split('=')[1];
  if (!sessionId) throw new Error('Verification set no session cookie');

  return {
    cookie: `${SESSION_COOKIE}=${sessionId}`,
    sessionId,
    userId: (verified.body as { data: { user: { id: string } } }).data.user.id,
  };
}

/** Moves the session's last proof of possession thirteen hours back, past step-up's window. */
export async function staleStepUp(sessionId: string): Promise<void> {
  await redis.hset(`sess:${deviceIdOf(sessionId)}`, {
    authAt: String(Date.now() - 13 * 60 * 60 * 1000),
  });
}

/**
 * Waits for something written after a response has been sent.
 *
 * The audit row is inserted on the response's `finish` event, so the request resolving
 * in the test and the row existing are two events, not one.
 */
export async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}
