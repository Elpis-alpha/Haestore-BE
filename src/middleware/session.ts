import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError, unauthenticated } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { User } from '../modules/auth/user.model.js';
import {
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../modules/auth/session-cookie.js';
import { destroySession, readSession } from '../modules/auth/session.js';

/**
 * How recently a session must have proved possession of a code to do something
 * destructive. Twelve hours is a working day: an admin signs in once and works, and a
 * session left open on an unattended laptop overnight cannot delete the catalogue.
 */
export const STEP_UP_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Written at most once a day; `lastSeenAt` on the account page is not a hit counter. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the session cookie into `req.auth`, or leaves it undefined.
 *
 * Mounted globally and **not** a guard: it decides who is calling, never whether they
 * may. Authorisation is `requireSession` and `requireRole` further in, which is what
 * lets one middleware serve the storefront (where being signed out is normal) and the
 * admin surface (where it is not).
 *
 * It fails open in the sense that matters: an infrastructure error means "no session",
 * so a Redis outage degrades an admin to signed-out rather than granting anything.
 */
export const attachSession: RequestHandler = async (req, res, next) => {
  try {
    await resolveSession(req, res);
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'session: could not resolve, continuing signed out',
    );
  }
  next();
};

async function resolveSession(req: Request, res: Response): Promise<void> {
  const sessionId = readSessionCookie(req);
  if (!sessionId) return;

  const session = await readSession(sessionId);
  if (!session) {
    // The cookie names a session Redis no longer has — expired, revoked, or flushed.
    // Clearing it stops the browser re-presenting a dead credential on every request.
    clearSessionCookie(res);
    return;
  }

  const user = await User.findById(session.userId)
    .select('email roles sessionVersion lastSeenAt')
    .lean();

  if (!user) {
    await destroySession(sessionId);
    clearSessionCookie(res);
    return;
  }

  /**
   * The nuclear revoke, checked here. `$inc User.sessionVersion` invalidates every
   * session for that user without touching Redis at all, which is what makes an admin
   * demotion take effect on the next request rather than in thirty days.
   */
  if (user.sessionVersion !== session.sessionVersion) {
    await destroySession(sessionId);
    clearSessionCookie(res);
    return;
  }

  // Re-issued only when the server-side window actually moved, so the cookie's Max-Age
  // and the Redis TTL slide together. See readSession.
  if (session.renewed) setSessionCookie(res, sessionId);

  req.auth = {
    userId: String(user._id),
    email: user.email,
    // Read live from the document rather than from a snapshot in the session, so a
    // role granted or removed a moment ago is in force now.
    roles: user.roles,
    authAt: session.authAt,
    sessionId,
  };

  const lastSeen = user.lastSeenAt?.getTime() ?? 0;
  if (Date.now() - lastSeen > TOUCH_AFTER_MS) {
    // Fire and forget: a failed bookkeeping write must not fail the request it was
    // riding along with.
    void User.updateOne({ _id: user._id }, { $set: { lastSeenAt: new Date() } }).catch(
      (err: Error) => logger.debug({ err: err.message }, 'session: lastSeenAt not written'),
    );
  }
}

/** 401 unless there is a session. The plain "you must be signed in" gate. */
export const requireSession: RequestHandler = (req, _res, next) => {
  if (!req.auth) {
    next(unauthenticated());
    return;
  }
  next();
};

/**
 * Step-up: a recent proof of possession, for actions that cannot be undone.
 *
 * It answers 403 `STEP_UP_REQUIRED` rather than 401, and the distinction is the whole
 * point — the session is valid and must **survive** the re-verification. Sending a 401
 * would tell the client to start a fresh sign-in, losing whatever the person was in
 * the middle of.
 */
export function requireStepUp(maxAgeMs = STEP_UP_MAX_AGE_MS): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) {
      next(unauthenticated());
      return;
    }
    if (Date.now() - auth.authAt.getTime() > maxAgeMs) {
      next(
        new AppError(403, 'STEP_UP_REQUIRED', 'Confirm it is you before making this change.', {
          details: { authAt: auth.authAt.toISOString(), maxAgeSeconds: maxAgeMs / 1000 },
        }),
      );
      return;
    }
    next();
  };
}
