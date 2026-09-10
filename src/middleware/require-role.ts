import type { NextFunction, Request, Response } from 'express';
import { notFound, unauthenticated } from '../lib/errors.js';

/**
 * Role gate, mounted **once on a router** rather than per handler.
 *
 * Per-handler guards are the shape that leaks: one route added without the line and
 * the whole surface is open, with nothing to notice it. Mounting on the router means
 * a new route is protected by existing, not by remembering.
 *
 * It answers 404 rather than 403, so the admin surface is not discoverable by probing.
 * The 2022 app's `GET /api/items/verify` was an unthrottled oracle that confirmed
 * whether a guessed admin password was right.
 *
 * The role is read only from the server-side session. Never from a body, a query
 * parameter or a header — all three are attacker-controlled.
 */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;

    if (!auth) {
      // No session at all is a genuine 401: it tells an ordinary signed-out visitor to
      // sign in, and reveals nothing, because it is the same answer every unauthenticated
      // request to any route gets.
      next(unauthenticated());
      return;
    }

    if (!roles.some((role) => auth.roles.includes(role))) {
      next(notFound());
      return;
    }

    next();
  };
}
