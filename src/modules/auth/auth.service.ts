import { env } from '../../config/env.js';
import { rateLimited, serviceUnavailable, AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../mail/transport.js';
import { signInCodeMessage } from '../../mail/templates.js';
import { consumeChallenge, createChallenge, discardChallenge } from './otp.js';
import { cooldownRemaining, throttleCodeRequest } from './throttle.js';
import { User, type UserDoc } from './user.model.js';
import { randomUUID } from 'node:crypto';

/**
 * The account shape the storefront sees. Everything else on the document is either
 * internal bookkeeping or a security control, and neither belongs in a response.
 */
export type PublicUser = {
  id: string;
  email: string;
  name?: string;
  roles: string[];
  createdAt: string;
};

export function toPublicUser(user: {
  _id: unknown;
  email: string;
  name?: string | null;
  roles: string[];
  createdAt?: Date;
}): PublicUser {
  return {
    id: String(user._id),
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    roles: user.roles,
    createdAt: (user.createdAt ?? new Date()).toISOString(),
  };
}

/**
 * Sends a code, or convincingly does not.
 *
 * **This function must do the same observable work for every address.** There is no
 * "does this user exist" query anywhere in it — not because the lookup would be slow,
 * but because a branch is a timing difference and a timing difference is an
 * enumeration oracle. The 2022 app shipped the oracle outright, as
 * `GET /api/users/user/exists?email=`.
 *
 * A throttled request returns a well-formed challenge id that no challenge stands
 * behind. Verifying against it answers "expired", exactly as a real challenge would
 * after ten minutes, so the throttle is invisible from outside.
 */
export async function requestSignInCode(
  email: string,
  ip: string,
  purpose: 'sign-in' | 'step-up' = 'sign-in',
): Promise<{ challengeId: string; cooldownSeconds: number }> {
  const verdict = await throttleCodeRequest(email, ip);

  if (verdict !== 'send') {
    logger.info({ verdict, ip }, 'auth: code request withheld');
    return { challengeId: randomUUID(), cooldownSeconds: await cooldownRemaining(email) };
  }

  const { challengeId, code } = await createChallenge(email);

  try {
    await sendMail(signInCodeMessage(email, code, purpose));
  } catch (err) {
    // The challenge goes with the failed send: leaving it would mean a code exists
    // that nobody was told, which can only ever be guessed at.
    await discardChallenge(challengeId).catch(() => undefined);
    logger.error({ err: (err as Error).message }, 'auth: could not send the sign-in code');
    // 503 rather than a comforting 202. This is our fault, not the caller's, it is
    // identical for a known and an unknown address, and telling someone a code is on
    // its way when it is not leaves them staring at an empty inbox blaming themselves.
    throw serviceUnavailable('We could not send the code just now. Try again in a moment.');
  }

  return { challengeId, cooldownSeconds: await cooldownRemaining(email) };
}

/**
 * Turns a correct code into an account.
 *
 * The first successful verification **creates** the user with `emailVerifiedAt` set —
 * possession of a code mailed to the address is the verification, so a separate
 * confirm-your-email step would only be asking the same question twice.
 */
export async function verifySignInCode(challengeId: string, code: string): Promise<UserDoc> {
  const result = await consumeChallenge(challengeId, code);

  if (result.outcome === 'expired') {
    throw new AppError(400, 'BAD_REQUEST', 'That code has expired. Ask for a new one.');
  }
  if (result.outcome === 'locked') {
    throw rateLimited('Too many attempts. Ask for a new code.');
  }
  if (result.outcome === 'wrong') {
    throw new AppError(400, 'BAD_REQUEST', 'That code is not right.', {
      details: { attemptsRemaining: result.attemptsRemaining },
    });
  }

  return upsertVerifiedUser(result.email);
}

/**
 * Finds or creates the account, and applies the admin allowlist.
 *
 * `findOneAndUpdate` with `upsert` rather than find-then-create: two tabs verifying two
 * codes for the same new address at the same moment would otherwise both find nothing
 * and both insert, and the loser gets E11000 in the middle of a successful sign-in.
 */
async function upsertVerifiedUser(email: string): Promise<UserDoc> {
  const now = new Date();

  /**
   * The admin bootstrap. An address in ADMIN_EMAILS is granted `admin` here, which is
   * what makes a fresh database yield a working administrator with no seeded password
   * — replacing the 2022 app's shared `?item_password=` in the query string of every
   * mutating request.
   *
   * It grants and never revokes: roles are also editable from the admin console in
   * Phase 8, and a bootstrap that reset them on every sign-in would silently undo
   * that. Removing an address from the list stops it *becoming* an admin; taking the
   * role away is `$inc sessionVersion` plus a role edit, which is deliberate.
   */
  const grantsAdmin = env.ADMIN_EMAILS.includes(email);

  const user = await User.findOneAndUpdate(
    { email },
    {
      $setOnInsert: { email, emailVerifiedAt: now, sessionVersion: 0 },
      ...(grantsAdmin ? { $addToSet: { roles: 'admin' } } : {}),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return user;
}
