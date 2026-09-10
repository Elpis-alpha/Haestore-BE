import type { Request } from 'express';

/**
 * The authenticated caller, attached by the session middleware in Phase 5.
 *
 * Declared now because the authorisation guards are written now, and a guard that
 * reads an untyped `any` off the request is how a role check quietly stops checking.
 *
 * Nothing populates this yet, which means every guard below currently denies. That is
 * the correct failure direction: the admin surface is unreachable until real
 * authentication exists, rather than open until someone remembers to close it.
 */
export type AuthContext = {
  userId: string;
  email: string;
  roles: string[];
  /** When the session last proved possession of a code, for step-up checks. */
  authAt: Date;
  sessionId: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function currentAuth(req: Request): AuthContext | undefined {
  return req.auth;
}
