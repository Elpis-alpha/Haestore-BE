import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { ADMIN_EMAIL, ORIGIN, signIn, staleStepUp, type TestSession } from '../../test/sign-in.js';
import { User } from '../auth/user.model.js';
import { Order } from '../order/order.model.js';

/**
 * Customers from behind the counter: the list, and the two things an admin can do to a
 * person's access — end their sessions, and change their role.
 */

const app = createApp();
let admin: TestSession;

beforeEach(async () => {
  admin = await signIn(app, ADMIN_EMAIL);
});

const as = (session: TestSession, verb: 'post' | 'put', path: string) =>
  request(app)[verb](path).set('Origin', ORIGIN).set('Cookie', session.cookie);

async function orderFor(userId: string, status: string, amount: number) {
  const tag = new mongoose.Types.ObjectId().toHexString().slice(-7).toUpperCase();
  await Order.create({
    orderNumber: `HAE-C${tag}`,
    user: new mongoose.Types.ObjectId(userId),
    email: 'x@example.test',
    status,
    lines: [
      {
        lineKey: 'k',
        product: new mongoose.Types.ObjectId(),
        variantId: new mongoose.Types.ObjectId(),
        sku: 'SKU',
        title: 'Thing',
        slug: 'thing',
        unitPrice: { amount, currency: 'USD' },
        quantity: 1,
      },
    ],
    totals: { subtotal: { amount, currency: 'USD' }, grandTotal: { amount, currency: 'USD' } },
    shippingAddress: { name: 'X', line1: '1 St', city: 'Town', country: 'IS' },
    payment: { provider: 'stripe' },
  });
}

describe('the customer list', () => {
  it('counts orders and money kept, leaving out what was never paid or was refunded', async () => {
    const shopper = await signIn(app, 'regular@example.test');
    await orderFor(shopper.userId, 'delivered', 4200);
    await orderFor(shopper.userId, 'paid', 1800);
    await orderFor(shopper.userId, 'refunded', 9900);
    await orderFor(shopper.userId, 'pending_payment', 5000);

    const res = await request(app)
      .get('/api/admin/customers')
      .query({ q: 'REGULAR@' })
      .set('Cookie', admin.cookie)
      .expect(200);

    const body = res.body as {
      data: { email: string; orderCount: number; spent: { amount: number; currency: string }[] }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      email: 'regular@example.test',
      orderCount: 4,
      spent: [{ amount: 6000, currency: 'USD' }],
    });
  });
});

describe('ending a customer’s sessions', () => {
  it('signs them out on every device at once', async () => {
    const shopper = await signIn(app, 'lost-phone@example.test');
    await request(app).get('/api/auth/me').set('Cookie', shopper.cookie).expect(200);

    const res = await as(
      admin,
      'post',
      `/api/admin/customers/${shopper.userId}/revoke-sessions`,
    ).expect(200);
    expect(res.body).toMatchObject({ data: { revoked: 1 } });

    await request(app).get('/api/auth/me').set('Cookie', shopper.cookie).expect(401);
  });

  it('refuses to do it to the admin pressing the button', async () => {
    await as(admin, 'post', `/api/admin/customers/${admin.userId}/revoke-sessions`).expect(400);
    await request(app).get('/api/auth/me').set('Cookie', admin.cookie).expect(200);
  });
});

describe('the admin role', () => {
  it('needs a fresh verification to grant', async () => {
    const shopper = await signIn(app, 'hopeful@example.test');
    await staleStepUp(admin.sessionId);

    await as(admin, 'put', `/api/admin/customers/${shopper.userId}/roles`)
      .send({ admin: true })
      .expect(403);
    expect((await User.findById(shopper.userId).lean())!.roles).toEqual([]);
  });

  /**
   * The grant ends the person's existing sessions. That is the only session rotation an
   * admin can perform on somebody else's browser, and it means a session id planted
   * before the grant is not an admin session after it.
   */
  it('grants it, ends the sessions that existed before, and works on the next sign-in', async () => {
    const colleague = await signIn(app, 'colleague@example.test');

    const res = await as(admin, 'put', `/api/admin/customers/${colleague.userId}/roles`)
      .send({ admin: true })
      .expect(200);
    expect(res.body).toMatchObject({ data: { changed: true, customer: { roles: ['admin'] } } });

    await request(app).get('/api/admin/dashboard').set('Cookie', colleague.cookie).expect(401);

    const fresh = await signIn(app, 'colleague@example.test');
    await request(app).get('/api/admin/dashboard').set('Cookie', fresh.cookie).expect(200);
  });

  it('is a no-op that signs nobody out when nothing would change', async () => {
    const colleague = await signIn(app, 'already@example.test');
    await User.updateOne({ _id: colleague.userId }, { $set: { roles: ['admin'] } });

    const res = await as(admin, 'put', `/api/admin/customers/${colleague.userId}/roles`)
      .send({ admin: true })
      .expect(200);
    expect(res.body).toMatchObject({ data: { changed: false } });
    await request(app).get('/api/admin/dashboard').set('Cookie', colleague.cookie).expect(200);
  });

  it('removes it, and the removal is in force on their very next request', async () => {
    const colleague = await signIn(app, 'demoted@example.test');
    await User.updateOne({ _id: colleague.userId }, { $set: { roles: ['admin'] } });
    await request(app).get('/api/admin/dashboard').set('Cookie', colleague.cookie).expect(200);

    await as(admin, 'put', `/api/admin/customers/${colleague.userId}/roles`)
      .send({ admin: false })
      .expect(200);

    const fresh = await signIn(app, 'demoted@example.test');
    await request(app).get('/api/admin/dashboard').set('Cookie', fresh.cookie).expect(404);
  });

  it('refuses to remove it from an address the allowlist would restore it to', async () => {
    const colleague = await signIn(app, 'second-admin@example.test');
    await User.updateOne({ _id: colleague.userId }, { $set: { roles: ['admin'] } });

    const res = await as(colleague, 'put', `/api/admin/customers/${admin.userId}/roles`)
      .send({ admin: false })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('ADMIN_EMAILS');
  });

  it('refuses to let an admin change their own role', async () => {
    await as(admin, 'put', `/api/admin/customers/${admin.userId}/roles`)
      .send({ admin: false })
      .expect(400);
  });
});
