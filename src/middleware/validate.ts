import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../lib/errors.js';

/**
 * Parses and **replaces** the request part with the validated result.
 *
 * Replacing rather than merely checking is the point: everything downstream then reads
 * coerced, defaulted, trimmed values with a static type, and there is no way to reach
 * past the schema to the raw input. Unknown keys are gone because the schemas are
 * strict where it matters.
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(
        new AppError(422, 'VALIDATION_FAILED', 'The request body failed validation.', {
          details: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }),
      );
      return;
    }
    // Assigned so nothing downstream can reach the raw input, and stashed so `body<T>()`
    // can hand it back with a real type. Express types `req.body` as `any`, which means
    // a route reading it directly loses every guarantee this middleware just established.
    req.body = result.data;
    Object.defineProperty(req, 'validatedBody', { value: result.data, configurable: true });
    next();
  };
}

export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(
        new AppError(400, 'BAD_REQUEST', 'One or more query parameters are not valid.', {
          details: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        }),
      );
      return;
    }
    // Express 5 makes req.query a getter, so it is stashed rather than assigned.
    Object.defineProperty(req, 'validatedQuery', { value: result.data, configurable: true });
    next();
  };
}

/** Reads what validateQuery stashed, with the type the caller expects. */
export function query<T>(req: Request): T {
  return (req as Request & { validatedQuery: T }).validatedQuery;
}

/**
 * Reads what validateBody stashed.
 *
 * Pass the schema's inferred type — `body<CreateProductInput>(req)` — so the handler
 * works against the parsed shape rather than Express's `any`.
 */
export function body<T>(req: Request): T {
  return (req as Request & { validatedBody: T }).validatedBody;
}

/**
 * Reads a route parameter as a string.
 *
 * Express 5 types `req.params[name]` as `string | string[] | undefined`, which is
 * honest — a wildcard route can produce an array. Rather than cast at every call site,
 * this narrows once and fails with a real error instead of a TypeError further in.
 */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(400, 'BAD_REQUEST', `Missing route parameter "${name}".`);
  }
  return value;
}

/**
 * The same, for parameters that address a document.
 *
 * Checking the shape here means a malformed id gets a 400 that says so, rather than a
 * Mongoose CastError surfacing as a 500 several frames away — and it keeps ids out of
 * queries where they would only ever match nothing.
 */
export function idParam(req: Request, name = 'id'): string {
  const value = param(req, name);
  if (!/^[0-9a-fA-F]{24}$/.test(value)) {
    throw new AppError(400, 'BAD_REQUEST', `"${name}" is not a valid id.`);
  }
  return value;
}
