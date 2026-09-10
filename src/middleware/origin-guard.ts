import type { RequestHandler } from 'express';
import { env, isProduction } from '../config/env.js';
import { forbidden } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence.
 *
 * Session cookies are SameSite=Lax, which already blocks cross-site POSTs in every
 * current browser. This is the belt to that pair of braces: any state-changing request
 * must present an Origin we recognise.
 *
 * No token plumbing is needed, and because the frontend reaches the API through a
 * same-origin Next rewrite (see docs/ARCHITECTURE.md), Origin is reliably present.
 */
export const originGuard: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');

  // Non-browser callers (curl, the Stripe CLI, server-to-server) send no Origin at
  // all. There is nothing to forge in that case: CSRF requires a browser that
  // attaches cookies automatically, and a browser always sends Origin on non-GET.
  if (!origin) return next();

  if (env.ALLOWED_ORIGINS.includes(origin.toLowerCase())) return next();

  // In development an empty allowlist means "not configured yet"; do not make that
  // an unexplained wall of 403s.
  if (!isProduction && env.ALLOWED_ORIGINS.length === 0) return next();

  return next(forbidden('Request origin is not allowed.'));
};
