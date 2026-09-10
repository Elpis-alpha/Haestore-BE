import { createHash, randomBytes } from 'node:crypto';
import { redis } from '../../cache/redis.js';

/**
 * Opaque server-side sessions in Redis. No JWTs anywhere — see ADR-004.
 *
 * The record holds only what cannot be derived: who, when, and from where. **Roles are
 * deliberately not snapshotted here.** A copy of the roles in the session is a copy
 * that goes stale, and the staleness window is exactly the thing an admin demotion
 * needs closed. They are read from the user document on each authenticated request
 * instead, which also makes a role *grant* land immediately rather than at next
 * sign-in. If that indexed lookup ever shows up in a profile, the answer is a version
 * key in Redis — not a longer-lived snapshot.
 */

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * How stale a session's TTL is allowed to get before a read renews it.
 *
 * "Sliding" does not have to mean a write on every request. Renewing once a day gives
 * the same practical behaviour — nobody's 30-day window is meaningfully shortened by
 * up to 24 hours — at one write per active day instead of one per page view.
 */
const RENEW_AFTER_SECONDS = 24 * 60 * 60;

/**
 * The Redis key is the **hash** of the session id, not the id.
 *
 * The cookie carries 256 bits of randomness; Redis stores SHA-256 of it. A dump of
 * Redis then yields no usable cookie values, the same way a password file of hashes
 * yields no passwords — and unlike a password, there is nothing to brute-force,
 * because the preimage is 256 random bits.
 *
 * It also makes the device list safe to publish: the id shown to the account page is
 * the hash, which identifies a session for revocation without being able to
 * impersonate it.
 */
export const deviceIdOf = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('hex');

const deviceId = deviceIdOf;

const sessionKey = (id: string) => `sess:${id}`;
const userSessionsKey = (userId: string) => `usess:${userId}`;

export type SessionRecord = {
  userId: string;
  /** When possession of a code was last proved. Step-up compares against this. */
  authAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
  /** Snapshot at creation, compared against the live user document on every request. */
  sessionVersion: number;
  userAgent: string;
  ip: string;
};

export type SessionContext = { userAgent: string; ip: string };

function toRecord(hash: Record<string, string>): SessionRecord | null {
  const { userId, authAt, createdAt, lastSeenAt, sessionVersion, userAgent, ip } = hash;
  if (!userId || !authAt) return null;
  return {
    userId,
    authAt: new Date(Number(authAt)),
    createdAt: new Date(Number(createdAt ?? authAt)),
    lastSeenAt: new Date(Number(lastSeenAt ?? authAt)),
    sessionVersion: Number(sessionVersion ?? 0),
    userAgent: userAgent ?? '',
    ip: ip ?? '',
  };
}

/**
 * 256 bits from the CSPRNG, base64url so it is cookie-safe without escaping.
 *
 * The 2022 app's session identity was a JWT signed with a secret that, when the env
 * file was missing, was `undefined` — `jwt.sign(payload, undefined)` does not throw.
 * There is no secret here to be undefined.
 */
function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export async function createSession(
  userId: string,
  sessionVersion: number,
  context: SessionContext,
): Promise<string> {
  const sessionId = newSessionId();
  const id = deviceId(sessionId);
  const now = Date.now();

  await redis
    .multi()
    .hset(sessionKey(id), {
      userId,
      authAt: String(now),
      createdAt: String(now),
      lastSeenAt: String(now),
      sessionVersion: String(sessionVersion),
      // Trimmed: a user agent is attacker-supplied and unbounded, and this is only
      // ever rendered as "which device is this" on the account page.
      userAgent: context.userAgent.slice(0, 300),
      ip: context.ip.slice(0, 45),
    })
    .expire(sessionKey(id), SESSION_TTL_SECONDS)
    .sadd(userSessionsKey(userId), id)
    .expire(userSessionsKey(userId), SESSION_TTL_SECONDS)
    .exec();

  return sessionId;
}

/**
 * Reads a session and slides its expiry, at most once a day.
 *
 * `renewed` is reported rather than kept private because the *cookie* has its own
 * 30-day Max-Age, and a Redis TTL that slides while the cookie does not would expire
 * the browser's copy on day 30 no matter how active the person had been. The caller
 * re-issues the cookie exactly when the server-side window moves, so the two stay in
 * step at one extra Set-Cookie per active day.
 */
export async function readSession(
  sessionId: string,
): Promise<(SessionRecord & { renewed: boolean }) | null> {
  const id = deviceId(sessionId);
  const record = toRecord(await redis.hgetall(sessionKey(id)));
  if (!record) return null;

  const ttl = await redis.ttl(sessionKey(id));
  if (ttl > 0 && ttl < SESSION_TTL_SECONDS - RENEW_AFTER_SECONDS) {
    const now = Date.now();
    await redis
      .multi()
      .hset(sessionKey(id), { lastSeenAt: String(now) })
      .expire(sessionKey(id), SESSION_TTL_SECONDS)
      .expire(userSessionsKey(record.userId), SESSION_TTL_SECONDS)
      .exec();
    record.lastSeenAt = new Date(now);
    return { ...record, renewed: true };
  }

  return { ...record, renewed: false };
}

/**
 * Issues a new id for the same session, carrying `createdAt` across.
 *
 * Session fixation defence: an attacker who plants a known session id in a victim's
 * browser before sign-in must not still hold a valid id afterwards. So the id changes
 * on **every privilege change** — verification, and later the guest-to-user upgrade
 * and a role grant. Rotating only at sign-in would leave the other two open.
 */
export async function rotateSession(
  currentSessionId: string,
  context: SessionContext,
  options: { refreshAuthAt?: boolean } = {},
): Promise<string | null> {
  const previous = deviceId(currentSessionId);
  const existing = toRecord(await redis.hgetall(sessionKey(previous)));
  if (!existing) return null;

  const nextSessionId = newSessionId();
  const next = deviceId(nextSessionId);
  const now = Date.now();

  await redis
    .multi()
    .hset(sessionKey(next), {
      userId: existing.userId,
      authAt: String(options.refreshAuthAt ? now : existing.authAt.getTime()),
      createdAt: String(existing.createdAt.getTime()),
      lastSeenAt: String(now),
      sessionVersion: String(existing.sessionVersion),
      userAgent: context.userAgent.slice(0, 300),
      ip: context.ip.slice(0, 45),
    })
    .expire(sessionKey(next), SESSION_TTL_SECONDS)
    .sadd(userSessionsKey(existing.userId), next)
    .srem(userSessionsKey(existing.userId), previous)
    .del(sessionKey(previous))
    .expire(userSessionsKey(existing.userId), SESSION_TTL_SECONDS)
    .exec();

  return nextSessionId;
}

/** Re-stamps `authAt` after a step-up, without changing the session id. */
export async function refreshAuthAt(sessionId: string): Promise<void> {
  await redis.hset(sessionKey(deviceId(sessionId)), { authAt: String(Date.now()) });
}

export async function destroySession(sessionId: string): Promise<void> {
  const id = deviceId(sessionId);
  const userId = await redis.hget(sessionKey(id), 'userId');
  const pipeline = redis.multi().del(sessionKey(id));
  if (userId) pipeline.srem(userSessionsKey(userId), id);
  await pipeline.exec();
}

/** Revokes by device id — what the account page's "sign out" button on a row sends. */
export async function destroyDevice(userId: string, id: string): Promise<boolean> {
  const owned = await redis.sismember(userSessionsKey(userId), id);
  // Membership is checked rather than assumed, so a device id from another account
  // cannot be revoked by guessing. It is a SHA-256 digest, so guessing is theoretical;
  // the check is here because "theoretical" is not a property to depend on.
  if (!owned) return false;
  await redis.multi().del(sessionKey(id)).srem(userSessionsKey(userId), id).exec();
  return true;
}

export async function destroyAllSessions(
  userId: string,
  options: { except?: string } = {},
): Promise<number> {
  const keep = options.except ? deviceId(options.except) : null;
  const ids = await redis.smembers(userSessionsKey(userId));
  const doomed = ids.filter((id) => id !== keep);
  if (doomed.length === 0) return 0;

  const pipeline = redis.multi();
  for (const id of doomed) pipeline.del(sessionKey(id));
  pipeline.srem(userSessionsKey(userId), ...doomed);
  await pipeline.exec();
  return doomed.length;
}

export type DeviceSummary = {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  userAgent: string;
  ip: string;
};

/**
 * The device list, sweeping expired members as it goes.
 *
 * Redis expires the session hash but cannot expire one member of a set, so `usess`
 * accumulates ids pointing at nothing. Cleaning them on read keeps the set bounded by
 * *active* sessions rather than by lifetime sign-ins, and needs no sweeper.
 */
export async function listDevices(
  userId: string,
  currentSessionId: string,
): Promise<DeviceSummary[]> {
  const ids = await redis.smembers(userSessionsKey(userId));
  if (ids.length === 0) return [];

  const pipeline = redis.multi();
  for (const id of ids) pipeline.hgetall(sessionKey(id));
  const results = (await pipeline.exec()) ?? [];

  const current = deviceId(currentSessionId);
  const devices: DeviceSummary[] = [];
  const stale: string[] = [];

  ids.forEach((id, index) => {
    const hash = results[index]?.[1] as Record<string, string> | undefined;
    const record = hash ? toRecord(hash) : null;
    if (!record) {
      stale.push(id);
      return;
    }
    devices.push({
      id,
      current: id === current,
      createdAt: record.createdAt.toISOString(),
      lastSeenAt: record.lastSeenAt.toISOString(),
      userAgent: record.userAgent,
      ip: record.ip,
    });
  });

  if (stale.length > 0) await redis.srem(userSessionsKey(userId), ...stale);

  return devices.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}
