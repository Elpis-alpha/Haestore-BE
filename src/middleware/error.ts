import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import mongoose from 'mongoose';
import { AppError, notFound } from '../lib/errors.js';
import { isProduction } from '../config/env.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(notFound('No route matches this path.'));
};

/**
 * The single global error handler.
 *
 * The 2022 backend had exactly one of these, inline on the avatar upload route, so a
 * multer failure anywhere else returned an HTML stack trace. Express 5 forwards
 * rejected promises here automatically, so `catch (e) { next(e) }` is no longer needed
 * in every handler.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const normalised = normalise(err);

  const log = req.log ?? console;
  if (normalised.expected) {
    log.warn({ code: normalised.code, status: normalised.status }, normalised.message);
  } else {
    log.error({ err, code: normalised.code }, 'unhandled error');
  }

  res.status(normalised.status).json({
    error: {
      code: normalised.code,
      message: normalised.message,
      ...(normalised.details !== undefined ? { details: normalised.details } : {}),
      requestId: req.id,
    },
  });
};

function normalise(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(422, 'VALIDATION_FAILED', 'The request failed validation.', {
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return new AppError(422, 'VALIDATION_FAILED', 'The document failed validation.', {
      details: Object.entries(err.errors).map(([path, e]) => ({ path, message: e.message })),
    });
  }

  if (err instanceof mongoose.Error.CastError) {
    return new AppError(400, 'BAD_REQUEST', `"${String(err.value)}" is not a valid ${err.kind}.`);
  }

  // Duplicate key. Surfaced as a conflict rather than the old app's generic 500.
  if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
    const keys = Object.keys((err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {});
    return new AppError(409, 'CONFLICT', `That ${keys.join(' + ') || 'value'} is already taken.`);
  }

  // Anything else is our fault. Never leak the message to the client in production.
  return new AppError(
    500,
    'INTERNAL',
    isProduction
      ? 'Something went wrong on our end.'
      : ((err as Error)?.message ?? 'Unknown error'),
    { cause: err, expected: false },
  );
}
