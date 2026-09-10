import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { redis } from '../../cache/redis.js';
import { clearOutbox, readOutbox } from '../../mail/dev-outbox.js';
import { SESSION_COOKIE } from './session-cookie.js';
import { deviceIdOf } from './session.js';
import { User } from './user.model.js';

/**
 * The auth round trip, over HTTP, against a real Redis and a real MongoDB replica set.
 *
 * These are the security regressions the plan asks for, one per defect the 2022 app
 * shipped: an enumeration oracle, JWTs that never expired, sessions that survived a
 * password change, and an admin surface behind a shared secret in the query string.
 */

const app = createApp();

type CodeRequestResponse = { data: { challengeId: string; cooldownSeconds: number } };
type VerifyResponse = { data: { user: { id: string; email: string; roles: string[] } } };
type ErrorResponse = { error: { code: string; message: string; details?: unknown } };
type DevicesResponse = { data: { id: string; current: boolean; userAgent: string }[] };

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

/** The code never leaves the mailbox, so the test reads it the way a person would. */
function codeFromOutbox(email: string): string {
  const message = readOutbox().find((entry) => entry.to === email);
  if (!message) throw new Error(`No message was sent to ${email}`);
  const code = /\b(\d{6})\b/.exec(message.subject)?.[1];
  if (!code) throw new Error(`No code in: ${message.subject}`);
  return code;
}

/** Pulls the session cookie out of Set-Cookie, as a browser would. */
function sessionCookieFrom(res: request.Response): string | undefined {
  // Supertest types every header as `any`; narrowing here rather than casting at each
  // access keeps the assertions below honest about what they are reading.
  const header: unknown = res.headers['set-cookie'];
  const values: string[] = Array.isArray(header)
    ? header.filter((value): value is string => typeof value === 'string')
    : typeof header === 'string'
      ? [header]
      : [];
  const cookie = values.find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  const parsed = cookie?.split(';')[0]?.split('=')[1];
  return parsed && parsed.length > 0 ? parsed : undefined;
}

/**
 * Steps past the 60-second resend cooldown.
 *
 * Several tests sign the same address in twice — two devices, a rotation — and the
 * cooldown is per address, so without this the second request correctly sends nothing
 * and the test reads a stale code. The cooldown itself is asserted on its own above;
 * this is the test declining to wait a minute, not the test disabling a control.
 */
async function releaseCooldown(email: string): Promise<void> {
  await redis.del(`otp:cd:${email}`);
}

async function signIn(email: string): Promise<{ cookie: string; sessionId: string }> {
  await releaseCooldown(email);
  clearOutbox();
  const requested = await request(app).post('/api/auth/otp/request').send({ email }).expect(202);
  const { challengeId } = bodyOf<CodeRequestResponse>(requested).data;

  const verified = await request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId, code: codeFromOutbox(email) })
    .expect(200);

  const sessionId = sessionCookieFrom(verified);
  if (!sessionId) throw new Error('Verification set no session cookie');
  return { cookie: `${SESSION_COOKIE}=${sessionId}`, sessionId };
}

beforeEach(() => {
  clearOutbox();
});

describe('requesting a code', () => {
  it('answers identically for an address that exists and one that does not', async () => {
    await signIn('known@example.test');
    await releaseCooldown('known@example.test');
    clearOutbox();

    const known = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'known@example.test' });
    const unknown = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'never-seen@example.test' });

    expect(known.status).toBe(unknown.status);
    expect(Object.keys(bodyOf<CodeRequestResponse>(known).data).sort()).toEqual(
      Object.keys(bodyOf<CodeRequestResponse>(unknown).data).sort(),
    );
    // Both get a real challenge id. The 2022 app shipped the opposite of this as
    // `GET /api/users/user/exists?email=`, a purpose-built enumeration oracle.
    expect(bodyOf<CodeRequestResponse>(known).data.challengeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates no user, so an unverified address is not an account', async () => {
    await request(app).post('/api/auth/otp/request').send({ email: 'window@example.test' });
    expect(await User.countDocuments({ email: 'window@example.test' })).toBe(0);
  });

  it('withholds a second code inside the cooldown, still answering 202', async () => {
    const first = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'eager@example.test' })
      .expect(202);
    clearOutbox();

    const second = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'eager@example.test' })
      .expect(202);

    expect(readOutbox()).toHaveLength(0);
    expect(bodyOf<CodeRequestResponse>(second).data.cooldownSeconds).toBeGreaterThan(0);
    // The withheld challenge id is well-formed and stands for nothing, so a client
    // cannot tell a throttled request from a sent one.
    expect(bodyOf<CodeRequestResponse>(second).data.challengeId).not.toBe(
      bodyOf<CodeRequestResponse>(first).data.challengeId,
    );
  });

  it('stops after five in an hour, and the sixth is indistinguishable', async () => {
    const email = 'persistent@example.test';
    for (let i = 0; i < 6; i += 1) {
      // The cooldown is per address, so it has to be released to reach the hourly cap.
      await releaseCooldown(email);
      await request(app).post('/api/auth/otp/request').send({ email }).expect(202);
    }
    expect(readOutbox().filter((m) => m.to === email)).toHaveLength(5);
  });
});

describe('verifying a code', () => {
  it('creates the account, already verified, on the first correct code', async () => {
    const before = await User.countDocuments();
    const { cookie } = await signIn('first@example.test');

    const user = await User.findOne({ email: 'first@example.test' }).lean();
    expect(await User.countDocuments()).toBe(before + 1);
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(cookie).toContain(SESSION_COOKIE);
  });

  it('is single-use — the same code cannot be replayed', async () => {
    const email = 'replay@example.test';
    const requested = await request(app).post('/api/auth/otp/request').send({ email });
    const { challengeId } = bodyOf<CodeRequestResponse>(requested).data;
    const code = codeFromOutbox(email);

    await request(app).post('/api/auth/otp/verify').send({ challengeId, code }).expect(200);
    const second = await request(app).post('/api/auth/otp/verify').send({ challengeId, code });

    expect(second.status).toBe(400);
    expect(bodyOf<ErrorResponse>(second).error.message).toMatch(/expired/i);
  });

  it('counts wrong attempts down and destroys the challenge at five', async () => {
    const email = 'fumbling@example.test';
    const requested = await request(app).post('/api/auth/otp/request').send({ email });
    const { challengeId } = bodyOf<CodeRequestResponse>(requested).data;
    const real = codeFromOutbox(email);
    const wrong = real === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await request(app)
        .post('/api/auth/otp/verify')
        .send({ challengeId, code: wrong })
        .expect(400);
      expect(bodyOf<ErrorResponse>(res).error.details).toEqual({
        attemptsRemaining: 5 - attempt,
      });
    }

    const locked = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId, code: wrong })
      .expect(429);
    expect(bodyOf<ErrorResponse>(locked).error.code).toBe('RATE_LIMITED');

    // The challenge is gone, so the *correct* code no longer works either. Burning it
    // is the point: five wrong guesses means this challenge is compromised or confused.
    await request(app).post('/api/auth/otp/verify').send({ challengeId, code: real }).expect(400);
  });

  it('will not verify a code against a different challenge', async () => {
    const first = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'a@example.test' });
    const code = codeFromOutbox('a@example.test');
    clearOutbox();
    const second = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'b@example.test' });

    void first;
    const res = await request(app)
      .post('/api/auth/otp/verify')
      .send({ challengeId: bodyOf<CodeRequestResponse>(second).data.challengeId, code });

    // The hash covers the challenge id and the address, so a code observed anywhere
    // else is worthless here even if it happens to be the right six digits.
    expect(res.status).toBe(400);
  });

  it('rotates the session id, so a planted session is not a signed-in one', async () => {
    const planted = await signIn('rotates@example.test');
    await releaseCooldown('rotates@example.test');
    clearOutbox();

    const requested = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'rotates@example.test' });
    const verified = await request(app)
      .post('/api/auth/otp/verify')
      .set('Cookie', planted.cookie)
      .send({
        challengeId: bodyOf<CodeRequestResponse>(requested).data.challengeId,
        code: codeFromOutbox('rotates@example.test'),
      })
      .expect(200);

    const fresh = sessionCookieFrom(verified);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(planted.sessionId);
    // And the old id is dead, not merely superseded.
    await request(app).get('/api/auth/me').set('Cookie', planted.cookie).expect(401);
  });
});

describe('the session', () => {
  it('identifies the caller on a subsequent request', async () => {
    const { cookie } = await signIn('me@example.test');
    const res = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(bodyOf<VerifyResponse>(res).data.user.email).toBe('me@example.test');
  });

  it('is 401 without a cookie', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });

  it('is refused when the cookie names a session Redis does not have', async () => {
    await signIn('gone@example.test');
    await redis.flushdb();
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=not-a-real-session-id`)
      .expect(401);
  });

  it('dies instantly when sessionVersion is bumped — the nuclear revoke', async () => {
    const { cookie } = await signIn('revoked@example.test');
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);

    await User.updateOne({ email: 'revoked@example.test' }, { $inc: { sessionVersion: 1 } });

    // No Redis write was needed, and it takes effect on the very next request rather
    // than in thirty days. This is what makes an admin demotion immediate.
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
  });

  it('reflects a role granted a moment ago, because roles are not snapshotted', async () => {
    const { cookie } = await signIn('promoted@example.test');
    await User.updateOne({ email: 'promoted@example.test' }, { $addToSet: { roles: 'admin' } });

    const res = await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(bodyOf<VerifyResponse>(res).data.user.roles).toContain('admin');
  });

  it('ends on sign-out, and answers 204 when there was nothing to end', async () => {
    const { cookie } = await signIn('bye@example.test');
    await request(app).post('/api/auth/sign-out').set('Cookie', cookie).expect(204);
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(401);
    await request(app).post('/api/auth/sign-out').expect(204);
  });
});

describe('devices', () => {
  it('lists one row per session and marks the current one', async () => {
    const first = await signIn('devices@example.test');
    const second = await signIn('devices@example.test');

    const res = await request(app)
      .get('/api/auth/devices')
      .set('Cookie', second.cookie)
      .expect(200);
    const devices = bodyOf<DevicesResponse>(res).data;

    expect(devices).toHaveLength(2);
    expect(devices.filter((d) => d.current)).toHaveLength(1);
    expect(devices.find((d) => d.current)?.id).toBe(deviceIdOf(second.sessionId));
    void first;
  });

  it('never exposes a usable session id — the row id is a hash of it', async () => {
    const { cookie, sessionId } = await signIn('hash@example.test');
    const res = await request(app).get('/api/auth/devices').set('Cookie', cookie).expect(200);
    const [device] = bodyOf<DevicesResponse>(res).data;

    expect(device?.id).not.toBe(sessionId);
    expect(device?.id).toMatch(/^[0-9a-f]{64}$/);
    // Presenting the published id as a cookie must not authenticate anything.
    await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${SESSION_COOKIE}=${device?.id ?? ''}`)
      .expect(401);
  });

  it('revokes one device without touching the others', async () => {
    const keep = await signIn('one@example.test');
    const drop = await signIn('one@example.test');

    await request(app)
      .delete(`/api/auth/devices/${deviceIdOf(drop.sessionId)}`)
      .set('Cookie', keep.cookie)
      .expect(204);

    await request(app).get('/api/auth/me').set('Cookie', drop.cookie).expect(401);
    await request(app).get('/api/auth/me').set('Cookie', keep.cookie).expect(200);
  });

  it('refuses a device belonging to someone else', async () => {
    const mine = await signIn('mine@example.test');
    const theirs = await signIn('theirs@example.test');

    await request(app)
      .delete(`/api/auth/devices/${deviceIdOf(theirs.sessionId)}`)
      .set('Cookie', mine.cookie)
      .expect(404);

    await request(app).get('/api/auth/me').set('Cookie', theirs.cookie).expect(200);
  });

  it('signs out everywhere else, keeping the device that asked', async () => {
    const here = await signIn('everywhere@example.test');
    const elsewhere = await signIn('everywhere@example.test');
    const alsoElsewhere = await signIn('everywhere@example.test');

    await request(app).post('/api/auth/sign-out-everywhere').set('Cookie', here.cookie).expect(200);

    await request(app).get('/api/auth/me').set('Cookie', here.cookie).expect(200);
    await request(app).get('/api/auth/me').set('Cookie', elsewhere.cookie).expect(401);
    await request(app).get('/api/auth/me').set('Cookie', alsoElsewhere.cookie).expect(401);
  });
});

describe('the admin surface', () => {
  it('is 401 signed out — the state every admin route was left in by Phase 2', async () => {
    await request(app).get('/api/admin/catalog/attributes').expect(401);
  });

  it('is 404 for a signed-in shopper, so its existence is not discoverable', async () => {
    const { cookie } = await signIn('shopper@example.test');
    await request(app).get('/api/admin/catalog/attributes').set('Cookie', cookie).expect(404);
  });

  it('opens for an address on the ADMIN_EMAILS allowlist, with no seeded password', async () => {
    const { cookie } = await signIn('keeper@haestore.test');
    const res = await request(app)
      .get('/api/admin/catalog/attributes')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toHaveProperty('data');
  });

  it('never reads a role from the request', async () => {
    const { cookie } = await signIn('forger@example.test');
    await request(app)
      .get('/api/admin/catalog/attributes')
      .set('Cookie', cookie)
      .set('x-roles', 'admin')
      .query({ roles: 'admin', item_password: 'letmein' })
      .expect(404);
  });
});

describe('step-up', () => {
  it('re-verifies without replacing the session', async () => {
    const { cookie, sessionId } = await signIn('stepup@example.test');
    await releaseCooldown('stepup@example.test');
    clearOutbox();

    const requested = await request(app)
      .post('/api/auth/step-up/request')
      .set('Cookie', cookie)
      .expect(202);

    const verified = await request(app)
      .post('/api/auth/step-up/verify')
      .set('Cookie', cookie)
      .send({
        challengeId: bodyOf<CodeRequestResponse>(requested).data.challengeId,
        code: codeFromOutbox('stepup@example.test'),
      })
      .expect(200);

    // The session id must survive: re-proving identity in the middle of a destructive
    // action must not discard the action.
    expect(sessionCookieFrom(verified)).toBeUndefined();
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
    void sessionId;
  });

  it('refuses a code minted for another account', async () => {
    const { cookie } = await signIn('victim@example.test');
    clearOutbox();
    const attacker = await request(app)
      .post('/api/auth/otp/request')
      .send({ email: 'attacker@example.test' });

    const res = await request(app)
      .post('/api/auth/step-up/verify')
      .set('Cookie', cookie)
      .send({
        challengeId: bodyOf<CodeRequestResponse>(attacker).data.challengeId,
        code: codeFromOutbox('attacker@example.test'),
      });

    expect(res.status).toBe(400);
  });

  it('needs a session at all', async () => {
    await request(app).post('/api/auth/step-up/request').expect(401);
  });
});

describe('step-up on a destructive admin action', () => {
  /**
   * The guard has a real call site rather than a mechanism nobody calls: deleting a
   * category cannot be undone, so `requireRole` answering "is this an admin" is not
   * enough — it also has to be an admin who is *here, now*. A valid session left open
   * on an unattended laptop is still a valid session.
   */
  let doomed = 0;

  async function aCategory(): Promise<string> {
    const { createCategory } = await import('../catalog/category.service.js');
    // Numbered, because a test that deletes twice would otherwise collide on the path
    // and fail for a reason that has nothing to do with step-up.
    doomed += 1;
    const category = await createCategory({
      name: `Doomed ${doomed}`,
      parent: null,
      order: 0,
      validationMode: 'lenient',
      status: 'active',
    });
    return String(category._id);
  }

  it('allows the delete while the session is freshly verified', async () => {
    const { cookie } = await signIn('keeper@haestore.test');
    await request(app)
      .delete(`/api/admin/catalog/categories/${await aCategory()}`)
      .set('Cookie', cookie)
      .expect(204);
  });

  it('refuses once the last verification is stale, and says so specifically', async () => {
    const { cookie, sessionId } = await signIn('keeper@haestore.test');

    // Thirteen hours ago, against a twelve-hour window.
    await redis.hset(`sess:${deviceIdOf(sessionId)}`, {
      authAt: String(Date.now() - 13 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .delete(`/api/admin/catalog/categories/${await aCategory()}`)
      .set('Cookie', cookie)
      .expect(403);

    // 403, not 401: the session is valid and must survive the re-verification, or
    // re-proving identity mid-action would discard the action.
    expect(bodyOf<ErrorResponse>(res).error.code).toBe('STEP_UP_REQUIRED');
    await request(app).get('/api/auth/me').set('Cookie', cookie).expect(200);
  });

  it('lets the same session through again after a step-up, with no new session id', async () => {
    const { cookie, sessionId } = await signIn('keeper@haestore.test');
    await redis.hset(`sess:${deviceIdOf(sessionId)}`, {
      authAt: String(Date.now() - 13 * 60 * 60 * 1000),
    });
    await request(app)
      .delete(`/api/admin/catalog/categories/${await aCategory()}`)
      .set('Cookie', cookie)
      .expect(403);

    await releaseCooldown('keeper@haestore.test');
    clearOutbox();
    const requested = await request(app)
      .post('/api/auth/step-up/request')
      .set('Cookie', cookie)
      .expect(202);
    await request(app)
      .post('/api/auth/step-up/verify')
      .set('Cookie', cookie)
      .send({
        challengeId: bodyOf<CodeRequestResponse>(requested).data.challengeId,
        code: codeFromOutbox('keeper@haestore.test'),
      })
      .expect(200);

    await request(app)
      .delete(`/api/admin/catalog/categories/${await aCategory()}`)
      .set('Cookie', cookie)
      .expect(204);
  });

  it('is not a way around the role check', async () => {
    const { cookie } = await signIn('not-an-admin@example.test');
    // 404, from requireRole, before requireStepUp is ever reached — the admin surface
    // must not become discoverable by asking a non-admin to step up.
    await request(app)
      .delete(`/api/admin/catalog/categories/${await aCategory()}`)
      .set('Cookie', cookie)
      .expect(404);
  });
});

describe('the dev outbox', () => {
  it('serves the codes locally, which is what makes E2E possible without a mailbox', async () => {
    await request(app).post('/api/auth/otp/request').send({ email: 'outbox@example.test' });
    const res = await request(app).get('/api/dev/outbox').expect(200);
    expect(JSON.stringify(res.body)).toContain('outbox@example.test');
  });
});
