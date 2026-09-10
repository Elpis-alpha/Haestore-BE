import { describe, expect, it } from 'vitest';
import { AppError, badRequest, internal, notFound, rateLimited } from './errors.js';

describe('AppError', () => {
  it('marks 4xx as expected and 5xx as ours', () => {
    expect(badRequest('nope').expected).toBe(true);
    expect(notFound().expected).toBe(true);
    expect(rateLimited().expected).toBe(true);
    expect(internal().expected).toBe(false);
  });

  it('carries a stable machine-readable code alongside the human message', () => {
    const err = badRequest('Quantity must be at least 1.', { field: 'qty' });
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.details).toEqual({ field: 'qty' });
  });

  it('defaults admin-surface misses to 404 rather than 403, so they are not discoverable', () => {
    expect(notFound().status).toBe(404);
  });

  it('preserves the cause chain for logging without exposing it', () => {
    const root = new Error('ECONNREFUSED');
    expect(internal('down', root).cause).toBe(root);
  });
});
