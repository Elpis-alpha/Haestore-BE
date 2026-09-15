import type { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { ADMIN_EMAIL, ORIGIN, eventually, signIn } from '../../test/sign-in.js';
import { adminCatalogRouter } from '../catalog/admin-catalog.routes.js';
import { adminCustomerRouter } from '../customer/admin-customer.routes.js';
import { adminOrderRouter } from '../order/admin-order.routes.js';
import { adminStorefrontRouter } from '../storefront/storefront.routes.js';
import { adminReviewRouter } from '../review/review.routes.js';
import { adminSupportRouter } from '../support/support.routes.js';
import { adminMediaRouter } from '../media/media.routes.js';
import { adminRouter } from './admin.routes.js';
import { AdminAudit } from './audit.model.js';

/**
 * The admin surface as a whole: who can reach it, and what it remembers.
 *
 * The gate test does not list routes. It walks the admin router's own route table, so a
 * route added next year is covered the moment it is mounted — and it fails if a router is
 * mounted under the admin router that this file does not know how to walk, rather than
 * silently skipping it.
 */

const app = createApp();

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
};

const stackOf = (router: Router) => (router as unknown as { stack: Layer[] }).stack;

const MOUNTS: [string, Router][] = [
  ['', adminRouter],
  ['/catalog', adminCatalogRouter],
  ['/orders', adminOrderRouter],
  ['/customers', adminCustomerRouter],
  ['/storefront', adminStorefrontRouter],
  ['/reviews', adminReviewRouter],
  ['/support', adminSupportRouter],
  ['/media', adminMediaRouter],
];

/** Every route under /api/admin, with its parameters filled in with plausible values. */
function everyAdminRoute(): { method: string; path: string }[] {
  const routes: { method: string; path: string }[] = [];
  for (const [prefix, router] of MOUNTS) {
    for (const layer of stackOf(router)) {
      if (!layer.route) continue;
      const path = `/api/admin${prefix}${layer.route.path}`
        .replace(/:id\b/g, '66aa00000000000000000001')
        .replace(/:handle\b/g, 'home')
        .replace(/:version\b/g, '1')
        .replace(/:key\b/g, 'roast');
      for (const method of Object.keys(layer.route.methods)) routes.push({ method, path });
    }
  }
  return routes;
}

function send(method: string, path: string) {
  const agent = request(app) as unknown as Record<string, (url: string) => request.Test>;
  const call = agent[method];
  if (!call) throw new Error(`supertest has no method ${method}`);
  return call.call(request(app), path).set('Origin', ORIGIN);
}

describe('the admin gate', () => {
  it('knows every router mounted under the admin router', () => {
    const mounted = stackOf(adminRouter)
      .filter((layer) => !layer.route && Array.isArray(layer.handle.stack))
      .map((layer) => layer.handle);
    expect(mounted).toHaveLength(MOUNTS.length - 1);
    for (const router of mounted) {
      expect(MOUNTS.some(([, known]) => (known as unknown) === router)).toBe(true);
    }
  });

  it('finds enough routes that the next two tests mean something', () => {
    expect(everyAdminRoute().length).toBeGreaterThan(45);
  });

  it('answers 401 on every admin route to a caller with no session', async () => {
    for (const { method, path } of everyAdminRoute()) {
      const res = await send(method, path);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  /**
   * 404, not 403. A signed-in shopper probing the admin surface learns nothing a probe of
   * any unrouted path would not also tell them.
   */
  it('answers 404 on every admin route to a signed-in shopper', async () => {
    const { cookie } = await signIn(app, 'shopper@example.test');
    for (const { method, path } of everyAdminRoute()) {
      const res = await send(method, path).set('Cookie', cookie);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(404);
    }
  });

  it('lets an admin in', async () => {
    const { cookie } = await signIn(app, ADMIN_EMAIL);
    const res = await request(app).get('/api/admin/dashboard').set('Cookie', cookie).expect(200);
    expect(res.body).toMatchObject({ data: { orders: { toFulfil: 0 } } });
  });
});

describe('the audit log', () => {
  const definition = {
    key: 'glaze',
    label: 'Glaze',
    type: 'select',
    options: [{ value: 'celadon', label: 'Celadon' }],
  };

  it('records a successful mutation with who did it and the route that did it', async () => {
    const { cookie, userId } = await signIn(app, ADMIN_EMAIL);

    const created = await request(app)
      .post('/api/admin/catalog/attributes')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send(definition)
      .expect(201);
    const id = (created.body as { data: { _id: string } }).data._id;

    await request(app)
      .patch(`/api/admin/catalog/attributes/${id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({ label: 'Glaze finish' })
      .expect(200);

    const rows = await eventually(
      () => AdminAudit.find().sort({ at: 1 }).lean(),
      (found) => found.length === 2,
    );

    expect(rows.map((row) => [row.method, row.route, row.targetId])).toEqual([
      ['POST', '/api/admin/catalog/attributes', null],
      ['PATCH', '/api/admin/catalog/attributes/:id', id],
    ]);
    expect(String(rows[0]?.actor.userId)).toBe(userId);
    expect(rows[0]?.actor.email).toBe(ADMIN_EMAIL);
    expect(rows[1]?.requestId).toBeTruthy();
  });

  it('records nothing for a read or for a refused mutation', async () => {
    const { cookie } = await signIn(app, ADMIN_EMAIL);

    await request(app).get('/api/admin/catalog/attributes').set('Cookie', cookie).expect(200);
    await request(app)
      .post('/api/admin/catalog/attributes')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({ key: 'sort', label: 'Reserved', type: 'text' })
      .expect(422);

    // Give a stray write every chance to land before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await AdminAudit.countDocuments()).toBe(0);
  });

  it('is readable from the console, newest first', async () => {
    const { cookie } = await signIn(app, ADMIN_EMAIL);
    for (const key of ['finish', 'volume_ml']) {
      await request(app)
        .post('/api/admin/catalog/attributes')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .send({ ...definition, key, label: key })
        .expect(201);
    }
    await eventually(
      () => AdminAudit.countDocuments(),
      (n) => n === 2,
    );

    const res = await request(app).get('/api/admin/audit').set('Cookie', cookie).expect(200);
    const body = res.body as { data: { path: string; at: string }[]; page: { total: number } };
    expect(body.page.total).toBe(2);
    expect(body.data[0]!.at >= body.data[1]!.at).toBe(true);
  });
});
