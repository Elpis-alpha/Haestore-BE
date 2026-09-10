import { Router, type Request } from 'express';
import { badRequest, notFound } from '../../lib/errors.js';
import { body, validateBody } from '../../middleware/validate.js';
import { requireSession } from '../../middleware/session.js';
import {
  requestCodeSchema,
  updateProfileSchema,
  verifyCodeSchema,
  type RequestCodeInput,
  type UpdateProfileInput,
  type VerifyCodeInput,
} from './auth.schema.js';
import { requestSignInCode, toPublicUser, verifySignInCode } from './auth.service.js';
import {
  createSession,
  deviceIdOf,
  destroyAllSessions,
  destroyDevice,
  destroySession,
  listDevices,
  refreshAuthAt,
} from './session.js';
import { clearSessionCookie, setSessionCookie } from './session-cookie.js';
import { User } from './user.model.js';
import { clientIp } from './client-ip.js';

export const authRouter: Router = Router();

const contextOf = (req: Request) => ({
  userAgent: req.get('user-agent') ?? '',
  ip: clientIp(req),
});

/**
 * Ask for a code.
 *
 * **202 always**, whatever happened: a known address, an unknown one, or a tripped
 * rate limit all produce the same body with the same shape. There is no signup and no
 * login, so there is no branch here to time or to read — the enumeration resistance is
 * structural rather than a matched pair of messages someone has to keep in sync.
 */
authRouter.post('/otp/request', validateBody(requestCodeSchema), async (req, res) => {
  const { email } = body<RequestCodeInput>(req);
  const { challengeId, cooldownSeconds } = await requestSignInCode(email, clientIp(req));

  res.status(202).json({ data: { challengeId, cooldownSeconds } });
});

/**
 * Verify a code, and become someone.
 *
 * The guess budget is worth stating, because it is the actual defence rather than the
 * hash: 5 attempts per challenge and 5 challenges per address per hour is **25 guesses
 * an hour** against a space of 10⁶. Exhausting it takes about four and a half years,
 * against a code that lives for ten minutes.
 */
authRouter.post('/otp/verify', validateBody(verifyCodeSchema), async (req, res) => {
  const { challengeId, code } = body<VerifyCodeInput>(req);
  const user = await verifySignInCode(challengeId, code);

  // Session fixation defence: whatever id the browser arrived holding is destroyed,
  // and the id it leaves with is new. An attacker who planted a session before
  // sign-in does not hold a signed-in one afterwards.
  const existing = req.auth?.sessionId;
  if (existing) await destroySession(existing);

  const sessionId = await createSession(String(user._id), user.sessionVersion, contextOf(req));
  setSessionCookie(res, sessionId);

  res.json({ data: { user: toPublicUser(user) } });
});

/**
 * Step-up: prove it is you again, without losing where you were.
 *
 * The session is deliberately **not** replaced — only `authAt` moves. Re-verifying in
 * the middle of a destructive admin action must not discard the action, and a full
 * sign-in would.
 */
authRouter.post('/step-up/request', requireSession, async (req, res) => {
  const auth = req.auth;
  if (!auth) throw badRequest('No session.');

  const { challengeId, cooldownSeconds } = await requestSignInCode(
    auth.email,
    clientIp(req),
    'step-up',
  );
  res.status(202).json({ data: { challengeId, cooldownSeconds } });
});

authRouter.post(
  '/step-up/verify',
  requireSession,
  validateBody(verifyCodeSchema),
  async (req, res) => {
    const auth = req.auth;
    if (!auth) throw badRequest('No session.');

    const { challengeId, code } = body<VerifyCodeInput>(req);
    const user = await verifySignInCode(challengeId, code);

    // The code proves possession of *a* mailbox. It has to be this session's mailbox,
    // or a step-up could be satisfied with a code sent to an address the attacker
    // controls — which would make the whole check decorative.
    if (String(user._id) !== auth.userId) {
      throw badRequest('That code was for a different account.');
    }

    await refreshAuthAt(auth.sessionId);
    res.json({ data: { authAt: new Date().toISOString() } });
  },
);

/** Who am I? 401 when signed out, which is how the frontend decides what to render. */
authRouter.get('/me', requireSession, async (req, res) => {
  const user = await User.findById(req.auth?.userId).lean();
  if (!user) throw notFound();
  res.json({ data: { user: toPublicUser(user), authAt: req.auth?.authAt.toISOString() } });
});

authRouter.patch('/me', requireSession, validateBody(updateProfileSchema), async (req, res) => {
  const { name } = body<UpdateProfileInput>(req);
  const user = await User.findByIdAndUpdate(
    req.auth?.userId,
    // An empty name unsets rather than storing "", so "has a name" is one check
    // everywhere downstream instead of two.
    name ? { $set: { name } } : { $unset: { name: 1 } },
    { new: true },
  ).lean();
  if (!user) throw notFound();
  res.json({ data: { user: toPublicUser(user) } });
});

/**
 * Sign out.
 *
 * Answers 204 whether or not there was a session, and clears the cookie either way.
 * Signing out is not an operation that can usefully fail, and a 401 here would be a
 * signed-out person being told to sign in before they may sign out.
 */
authRouter.post('/sign-out', async (req, res) => {
  if (req.auth) await destroySession(req.auth.sessionId);
  clearSessionCookie(res);
  res.status(204).end();
});

/**
 * Sign out everywhere else, keeping this device.
 *
 * Keeping the current session is the behaviour people expect from the button they
 * pressed: they are on the device they trust, revoking the ones they do not.
 */
authRouter.post('/sign-out-everywhere', requireSession, async (req, res) => {
  const auth = req.auth;
  if (!auth) throw badRequest('No session.');
  const revoked = await destroyAllSessions(auth.userId, { except: auth.sessionId });
  res.json({ data: { revoked } });
});

/** The device list. Ids here are session hashes, so showing them grants nothing. */
authRouter.get('/devices', requireSession, async (req, res) => {
  const auth = req.auth;
  if (!auth) throw badRequest('No session.');
  res.json({ data: await listDevices(auth.userId, auth.sessionId) });
});

authRouter.delete('/devices/:id', requireSession, async (req, res) => {
  const auth = req.auth;
  if (!auth) throw badRequest('No session.');

  const id = req.params.id;
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw notFound();

  // Scoped to this user's own set, so a device id cannot be revoked across accounts.
  const revoked = await destroyDevice(auth.userId, id);
  if (!revoked) throw notFound();

  // Revoking the device you are on is a sign-out, and must clear the cookie too —
  // otherwise the browser keeps presenting a credential that no longer resolves.
  if (id === deviceIdOf(auth.sessionId)) clearSessionCookie(res);

  res.status(204).end();
});
