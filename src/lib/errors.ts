/**
 * Error taxonomy.
 *
 * The 2022 backend had two parallel switch statements over HTTP codes and no global
 * error handler at all, so an unhandled throw in most routes returned an HTML stack
 * trace. Here every failure is an AppError with a stable machine-readable `code`, and
 * anything else that escapes is a 500 with the details logged but never returned.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'STEP_UP_REQUIRED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'GONE'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_STOCK'
  | 'PAYMENT_FAILED'
  | 'INTERNAL'
  | 'SERVICE_UNAVAILABLE';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  /** True for errors the client caused and can act on; false for our faults. */
  readonly expected: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { details?: unknown; expected?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.expected = options.expected ?? status < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, { details });

export const validationFailed = (details: unknown) =>
  new AppError(422, 'VALIDATION_FAILED', 'The request body failed validation.', { details });

export const unauthenticated = (message = 'Sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

/**
 * Admin surfaces respond 404 rather than 403 so their existence is not discoverable.
 * The 2022 app's `GET /api/items/verify` was an unthrottled oracle that confirmed
 * whether a guessed admin password was correct.
 */
export const notFound = (message = 'Not found.') => new AppError(404, 'NOT_FOUND', message);

export const forbidden = (message = 'You do not have access to this.') =>
  new AppError(403, 'FORBIDDEN', message);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, { details });

export const rateLimited = (message = 'Too many requests. Try again shortly.') =>
  new AppError(429, 'RATE_LIMITED', message);

export const internal = (message = 'Something went wrong on our end.', cause?: unknown) =>
  new AppError(500, 'INTERNAL', message, { cause, expected: false });

export const serviceUnavailable = (message: string, cause?: unknown) =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message, { cause, expected: false });
