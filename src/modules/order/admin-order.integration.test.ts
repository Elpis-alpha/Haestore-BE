import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as stripeModule from '../payments/stripe.js';

/**
 * Orders from behind the counter, over HTTP, against a real replica set.
 *
 * Only the Stripe module is mocked, and only its retrieve call — the reconcile button is
 * the one admin action that talks to a provider. Everything else runs for real: the gate,
 * step-up, the guarded writes and the stock arithmetic.
 */

vi.mock('../payments/stripe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof stripeModule>();
  return { ...actual, retrievePaymentIntent: vi.fn() };
});

const { createApp } = await import('../../app.js');
const stripe = await import('../payments/stripe.js');
const { Category } = await import('../catalog/category.model.js');
const { Product } = await import('../catalog/product.model.js');
const { Order } = await import('./order.model.js');
const { reserveAll } = await import('../checkout/reservation.js');
const { ADMIN_EMAIL, ORIGIN, signIn, staleStepUp } = await import('../../test/sign-in.js');

const app = createApp();

type OrderStatus =
  'pending_payment' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'canceled' | 'refunded';

type AdminOrder = {
  id: string;
  status: OrderStatus;
  actions: string[];
  stockReserved: boolean;
  history: { status: string; by: string; note?: string }[];
};
type OrderBody = { data: { order: AdminOrder } };
type ErrorBody = { error: { code: string; details?: { status?: string } } };

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const suffix = () =>
  Array.from({ length: 7 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

async function seedOrder(
  status: OrderStatus,
  options: { quantity?: number; onHand?: number } = {},
) {
  const quantity = options.quantity ?? 2;
  const onHand = options.onHand ?? 10;
  const tag = suffix();

  const category = await Category.create({
    name: 'Beans',
    slug: `beans-${tag.toLowerCase()}`,
    path: `beans-${tag.toLowerCase()}`,
    ancestors: [],
    depth: 0,
    order: 0,
  });
  const product = await Product.create({
    title: 'House Blend',
    slug: `house-blend-${tag.toLowerCase()}`,
    category: category._id,
    categoryAncestors: [category._id],
    status: 'active',
    variants: [
      {
        sku: `HB-${tag}`,
        axisValues: [],
        price: { amount: 1800, currency: 'USD' },
        stock: { onHand, reserved: 0, available: onHand, lowStockThreshold: 3 },
        status: 'active',
        position: 0,
      },
    ],
    inStock: true,
  });
  const variant = product.variants[0]!;

  const holds = ['pending_payment', 'paid', 'processing'].includes(status);
  if (holds) {
    await reserveAll([
      { productId: String(product._id), variantId: String(variant._id), quantity },
    ]);
  }

  const order = await Order.create({
    orderNumber: `HAE-Q${tag}`,
    email: 'buyer@haestore.test',
    status,
    currency: 'USD',
    lines: [
      {
        lineKey: `${String(product._id)}_${String(variant._id)}`,
        product: product._id,
        variantId: variant._id,
        sku: variant.sku,
        title: 'House Blend',
        slug: product.slug,
        axisValues: [],
        unitPrice: { amount: 1800, currency: 'USD' },
        quantity,
      },
    ],
    totals: {
      subtotal: { amount: 1800 * quantity, currency: 'USD' },
      grandTotal: { amount: 1800 * quantity, currency: 'USD' },
    },
    shippingAddress: {
      name: 'A Buyer',
      line1: '1 Market Street',
      city: 'Reykjavík',
      country: 'IS',
    },
    payment: { provider: 'stripe', intentId: `pi_${tag}` },
    claimTokenHash: 'a'.repeat(64),
    stockReserved: holds,
    reservationExpiresAt: status === 'pending_payment' ? new Date(Date.now() + 60_000) : null,
    paidAt: status === 'pending_payment' ? null : new Date(),
    history: [{ status, at: new Date(), by: 'checkout' }],
  });

  return { order, productId: String(product._id) };
}

const stockOf = async (productId: string) =>
  (await Product.findById(productId).lean())!.variants[0]!.stock;

let admin: { cookie: string; sessionId: string; userId: string };

beforeEach(async () => {
  admin = await signIn(app, ADMIN_EMAIL);
});

const post = (path: string, body: object = {}) =>
  request(app).post(path).set('Origin', ORIGIN).set('Cookie', admin.cookie).send(body);

describe('the forward path', () => {
  it('ships a packed order: onHand and reserved come down, available does not', async () => {
    const { order, productId } = await seedOrder('processing', { quantity: 2, onHand: 10 });
    expect(await stockOf(productId)).toMatchObject({ onHand: 10, reserved: 2, available: 8 });

    const res = await post(`/api/admin/orders/${String(order._id)}/status`, {
      to: 'shipped',
    }).expect(200);

    const shipped = bodyOf<OrderBody>(res).data.order;
    expect(shipped.status).toBe('shipped');
    expect(shipped.stockReserved).toBe(false);
    expect(shipped.history.at(-1)).toMatchObject({
      status: 'shipped',
      by: `admin:${admin.userId}`,
    });
    expect(await stockOf(productId)).toMatchObject({ onHand: 8, reserved: 0, available: 8 });
  });

  /**
   * The property `shipOrder` is written for. Two presses — two tabs, two admins — race to
   * the same order, and the stock leaves the building once.
   */
  it('ships once when two admins ship the same order at the same moment', async () => {
    const { order, productId } = await seedOrder('processing', { quantity: 3, onHand: 10 });
    const path = `/api/admin/orders/${String(order._id)}/status`;

    const results = await Promise.all([
      post(path, { to: 'shipped' }),
      post(path, { to: 'shipped' }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stockOf(productId)).toMatchObject({ onHand: 7, reserved: 0, available: 7 });
    const stored = await Order.findById(order._id).lean();
    expect(stored!.history.filter((h) => h.status === 'shipped')).toHaveLength(1);
  });

  it('refuses to ship an unpaid order, and says what state it is in', async () => {
    const { order, productId } = await seedOrder('pending_payment');
    const res = await post(`/api/admin/orders/${String(order._id)}/status`, {
      to: 'shipped',
    }).expect(409);
    expect(bodyOf<ErrorBody>(res).error.details?.status).toBe('pending_payment');
    expect(await stockOf(productId)).toMatchObject({ onHand: 10, reserved: 2 });
  });

  it('will not ship a paid order that has not been packed', async () => {
    const { order } = await seedOrder('paid');
    const res = await post(`/api/admin/orders/${String(order._id)}/status`, {
      to: 'shipped',
    }).expect(409);
    expect(bodyOf<ErrorBody>(res).error.details?.status).toBe('paid');
  });

  it('will not mark an order paid by hand — that is what reconcile is for', async () => {
    const { order } = await seedOrder('pending_payment');
    await post(`/api/admin/orders/${String(order._id)}/status`, { to: 'paid' }).expect(422);
  });

  it('returns the actions the machine allows, and never the claim token hash', async () => {
    const { order } = await seedOrder('paid');
    const res = await request(app)
      .get(`/api/admin/orders/${String(order._id)}`)
      .set('Cookie', admin.cookie)
      .expect(200);

    expect(bodyOf<OrderBody>(res).data.order.actions).toEqual([
      'start_processing',
      'record_refund',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('claimToken');
  });
});

describe('ending an order', () => {
  it('needs a fresh verification to cancel, and leaves the order alone without one', async () => {
    const { order } = await seedOrder('pending_payment');
    await staleStepUp(admin.sessionId);

    const res = await post(`/api/admin/orders/${String(order._id)}/cancel`).expect(403);
    expect(bodyOf<ErrorBody>(res).error.code).toBe('STEP_UP_REQUIRED');
    expect((await Order.findById(order._id).lean())!.status).toBe('pending_payment');
  });

  it('cancels an unpaid order and returns its stock exactly once', async () => {
    const { order, productId } = await seedOrder('pending_payment', { quantity: 2 });
    const path = `/api/admin/orders/${String(order._id)}/cancel`;

    await post(path).expect(200);
    await post(path).expect(409);

    expect(await stockOf(productId)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
  });

  /**
   * The narrowing that makes the console safer than the machine. `paid → canceled` is
   * legal, but it would release the stock and keep the money.
   */
  it('will not cancel a paid order, and leaves its stock held', async () => {
    const { order, productId } = await seedOrder('paid');
    const res = await post(`/api/admin/orders/${String(order._id)}/cancel`).expect(409);
    expect(bodyOf<ErrorBody>(res).error.details?.status).toBe('paid');
    expect(await stockOf(productId)).toMatchObject({ reserved: 2, available: 8 });
  });

  it('records a refund on a paid order and puts the held stock back on the shelf', async () => {
    const { order, productId } = await seedOrder('paid', { quantity: 2 });

    const res = await post(`/api/admin/orders/${String(order._id)}/refund`, {
      note: 'Refunded in the Stripe dashboard, re_123',
    }).expect(200);

    const refunded = bodyOf<OrderBody>(res).data.order;
    expect(refunded.status).toBe('refunded');
    expect(refunded.actions).toEqual([]);
    expect(refunded.history.at(-1)?.note).toContain('re_123');
    expect(await stockOf(productId)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
  });

  it('restocks nothing when the refunded goods have already shipped', async () => {
    const { order, productId } = await seedOrder('processing', { quantity: 2 });
    await post(`/api/admin/orders/${String(order._id)}/status`, { to: 'shipped' }).expect(200);

    await post(`/api/admin/orders/${String(order._id)}/refund`, {
      note: 'Returned damaged',
    }).expect(200);
    expect(await stockOf(productId)).toMatchObject({ onHand: 8, reserved: 0, available: 8 });
  });

  it('refuses a refund with no note, because the note is where the money is accounted for', async () => {
    const { order } = await seedOrder('paid');
    await post(`/api/admin/orders/${String(order._id)}/refund`, {}).expect(422);
  });
});

describe('reconcile', () => {
  it('pays a stranded order through markOrderPaid, and says who asked', async () => {
    const { order } = await seedOrder('pending_payment', { quantity: 2 });
    vi.mocked(stripe.retrievePaymentIntent).mockResolvedValueOnce({
      id: order.payment.intentId!,
      status: 'succeeded',
      amount: 3600,
      amount_received: 3600,
      currency: 'usd',
      client_secret: null,
      latest_charge: 'ch_1',
    });

    const res = await post(`/api/admin/orders/${String(order._id)}/reconcile`).expect(200);
    const body = bodyOf<{ data: { outcome: string; order: AdminOrder } }>(res);

    expect(body.data.outcome).toBe('paid');
    expect(body.data.order.status).toBe('paid');
    expect(body.data.order.history.at(-1)).toMatchObject({
      status: 'paid',
      by: `admin:${admin.userId}`,
    });

    // A second press asks nothing of the provider and changes nothing.
    const again = await post(`/api/admin/orders/${String(order._id)}/reconcile`).expect(200);
    expect(bodyOf<{ data: { outcome: string } }>(again).data.outcome).toBe('nothing_to_do');
  });

  it('does not pay an order whose payment did not go through', async () => {
    const { order } = await seedOrder('pending_payment');
    vi.mocked(stripe.retrievePaymentIntent).mockResolvedValueOnce({
      id: order.payment.intentId!,
      status: 'requires_payment_method',
      amount: 3600,
      amount_received: 0,
      currency: 'usd',
      client_secret: null,
      latest_charge: null,
    });

    const res = await post(`/api/admin/orders/${String(order._id)}/reconcile`).expect(200);
    const body = bodyOf<{ data: { outcome: string; reason: string; order: AdminOrder } }>(res);
    expect(body.data.outcome).toBe('nothing_to_do');
    expect(body.data.reason).toContain('requires_payment_method');
    expect(body.data.order.status).toBe('pending_payment');
  });
});

describe('finding an order', () => {
  it('by a number read down a phone line, or by the start of an address', async () => {
    const { order } = await seedOrder('paid');
    await seedOrder('paid');
    await Order.updateOne({ _id: order._id }, { $set: { email: 'jane.doe@example.test' } });

    const byNumber = await request(app)
      .get('/api/admin/orders')
      .query({ q: order.orderNumber.toLowerCase().replace('-', ' ') })
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(bodyOf<{ data: { id: string }[] }>(byNumber).data.map((o) => o.id)).toEqual([
      String(order._id),
    ]);

    const byEmail = await request(app)
      .get('/api/admin/orders')
      .query({ q: 'JANE.' })
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(bodyOf<{ data: { id: string }[] }>(byEmail).data).toHaveLength(1);

    // The dot is a literal, not "any character".
    const literal = await request(app)
      .get('/api/admin/orders')
      .query({ q: 'janexdoe' })
      .set('Cookie', admin.cookie)
      .expect(200);
    expect(bodyOf<{ data: unknown[] }>(literal).data).toHaveLength(0);
  });

  it('filters by status', async () => {
    await seedOrder('paid');
    await seedOrder('pending_payment');
    const res = await request(app)
      .get('/api/admin/orders?status=pending_payment')
      .set('Cookie', admin.cookie)
      .expect(200);
    const body = bodyOf<{ data: { status: string }[]; page: { total: number } }>(res);
    expect(body.page.total).toBe(1);
    expect(body.data[0]?.status).toBe('pending_payment');
    expect(mongoose.connection.readyState).toBe(1);
  });
});
