import { describe, expect, it } from 'vitest';
import { routePatternOf, targetOf } from './audit.js';

describe('routePatternOf', () => {
  it('names the declared route, so rows for one action group together', () => {
    expect(
      routePatternOf({
        baseUrl: '/api/admin/orders',
        route: { path: '/:id/status' },
        originalUrl: '/api/admin/orders/66aa/status?x=1',
      }),
    ).toBe('/api/admin/orders/:id/status');
  });

  it('does not add a trailing slash for a router-root route', () => {
    expect(
      routePatternOf({
        baseUrl: '/api/admin/catalog',
        route: { path: '/' },
        originalUrl: '/api/admin/catalog',
      }),
    ).toBe('/api/admin/catalog');
  });

  it('falls back to the concrete path, without the query, when no route matched', () => {
    expect(
      routePatternOf({ baseUrl: '', route: undefined, originalUrl: '/api/admin/nowhere?q=1' }),
    ).toBe('/api/admin/nowhere');
  });
});

describe('targetOf', () => {
  it('prefers a document id', () => {
    expect(targetOf({ id: '66aa', key: 'roast' })).toBe('66aa');
  });

  it('names a storefront version by handle and number', () => {
    expect(targetOf({ handle: 'home', version: '3' })).toBe('home@v3');
    expect(targetOf({ handle: 'home' })).toBe('home');
  });

  it('is null for a route that targets nothing in particular', () => {
    expect(targetOf({})).toBeNull();
    expect(targetOf(undefined)).toBeNull();
  });
});
