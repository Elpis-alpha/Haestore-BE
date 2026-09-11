import { createHmac } from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as stripeModule from '../payments/stripe.js';

/**
 * Checkout over HTTP.
 *
 * The provider modules are mocked, and only the provider modules: everything between the
 * request and the database is the real thing. What is being tested here is the API edge —
 * the idempotency key, the webhook's raw-body mounting, and who is allowed to read an
 * order — none of which the service-level suite can reach.
 *
 * Mocking is confined to the two files that make outbound HTTP calls, so a mistake in
 * this file cannot make a route look correct when it is not: the routes, the services,
 * the transactions and the guards all run for real.
 */

vi.mock('../payments/stripe.js', async (importOriginal) => {
  // The real signature verifier is kept — it is the thing under test on the webhook
  // route, and replacing it would make the mounting test meaningless.
  const actual = await importOriginal<typeof stripeModule>();
  return {
    ...actual,
    createPaymentIntent: vi.fn((input: { orderId: string; amount: { amount: number } }) =>
      Promise.resolve({
        id: `pi_test_${input.orderId}`,
        status: 'requires_payment_method',
        amount: input.amount.amount,
        amount_received: 0,
        currency: 'usd',
        client_secret: `pi_test_${input.orderId}_secret_abc`,
        latest_charge: null,
      }),
    ),
    retrievePaymentIntent: vi.fn(),
  };
});

const { createApp } = await import('../../app.js');
const { Category } = await import('../catalog/category.model.js');
const { Product } = await import('../catalog/product.model.js');
const { Cart } = await import('../cart/cart.model.js');
const { Order } = await import('../order/order.model.js');
const { OrderOutbox } = await import('../order/order-outbox.model.js');
const { PaymentEvent } = await import('../payments/payment-event.model.js');
const { IdempotencyKey } = await import('./idempotency.model.js');
const { lineKeyOf } = await import('../cart/line-key.js');
const { GUEST_COOKIE, guestKeyHash } = await import('../cart/guest-cookie.js');

const app = createApp();
const ORIGIN = 'http://localhost:3000';

/**
 * Supertest types `res.body` as `any`. Naming the shapes we actually assert on keeps
 * the lint rule against unchecked member access meaningful everywhere else.
 */
type OrderBody = {
  data: {
    order: {
      id: string;
      orderNumber: string;
      claimToken?: string;
      totals: { grandTotal: { amount: number; currency: string } };
      payment: Record<string, unknown>;
    };
    stripe?: { clientSecret: string };
  };
};
type ErrorBody = { error: { code: string; message: string } };
type WebhookBody = { received: boolean; duplicate?: boolean };

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

const GUEST_TOKEN = 'a-guest-token-for-the-integration-suite';
const guestCookie = `${GUEST_COOKIE}=${GUEST_TOKEN}`;

async function seedCartWithProduct(quantity = 2, price = 1800) {
  const suffix = new mongoose.Types.ObjectId().toHexString().slice(-6);
  const category = await Category.create({
    name: 'Beans',
    slug: `beans-${suffix}`,
    path: `coffee/beans-${suffix}`,
    ancestors: [],
    depth: 0,
    order: 0,
  });
  const product = await Product.create({
    title: 'House Blend',
    slug: `house-blend-${suffix}`,
    category: category._id,
    categoryAncestors: [category._id],
    status: 'active',
    variantAxes: [],
    variants: [
      {
        sku: `SKU-${suffix}`.toUpperCase(),
        axisValues: [],
        price: { amount: price, currency: 'USD' },
        stock: {
          onHand: 10,
          reserved: 0,
          available: 10,
          lowStockThreshold: 3,
          backorderable: false,
        },
        status: 'active',
        position: 0,
      },
    ],
    inStock: true,
  });
  const variant = product.variants[0]!;

  await Cart.create({
    guestKeyHash: guestKeyHash(GUEST_TOKEN),
    status: 'active',
    currency: 'USD',
    lines: [
      {
        lineKey: lineKeyOf(String(product._id), String(variant._id)),
        product: product._id,
        variantId: variant._id,
        sku: variant.sku,
        title: 'House Blend',
        slug: product.slug,
        axisValues: [],
        unitPrice: { amount: price, currency: 'USD' },
        quantity,
        addedAt: new Date(),
      },
    ],
    savedForLater: [],
  });

  return { productId: String(product._id), variantId: String(variant._id) };
}

const checkoutBody = {
  email: 'shopper@haestore.test',
  shippingAddress: {
    name: 'A Shopper',
    line1: '1 Market Street',
    city: 'Reykjavík',
    country: 'IS',
  },
  provider: 'stripe' as const,
};

const post = (path: string) =>
  request(app).post(path).set('Origin', ORIGIN).set('Cookie', guestCookie);

describe('POST /api/checkout/session', () => {
  it('creates the order and returns a client secret, never an amount from the client', async () => {
    await seedCartWithProduct(2, 1800);

    const res = await post('/api/checkout/session')
      .set('Idempotency-Key', 'key-1')
      .send(checkoutBody)
      .expect(201);

    expect(bodyOf<OrderBody>(res).data.order.totals.grandTotal).toEqual({
      amount: 3600,
      currency: 'USD',
    });
    expect(bodyOf<OrderBody>(res).data.stripe?.clientSecret).toMatch(/_secret_/);
    expect(bodyOf<OrderBody>(res).data.order.claimToken).toBeTruthy();

    // The response must not carry anything that authorises more than reading this order.
    expect(bodyOf<OrderBody>(res).data.order).not.toHaveProperty('claimTokenHash');
    expect(bodyOf<OrderBody>(res).data.order.payment).not.toHaveProperty('intentId');
  });

  /** A body carrying an amount is refused outright — the schema is strict. */
  it('refuses a request that tries to supply its own total', async () => {
    await seedCartWithProduct();
    await post('/api/checkout/session')
      .set('Idempotency-Key', 'key-amount')
      .send({ ...checkoutBody, totals: { grandTotal: { amount: 1, currency: 'USD' } } })
      .expect(422);
  });

  it('refuses without an Idempotency-Key', async () => {
    await seedCartWithProduct();
    const res = await post('/api/checkout/session').send(checkoutBody).expect(400);
    expect(bodyOf<ErrorBody>(res).error.message).toMatch(/Idempotency-Key/);
  });
});

describe('the idempotency key', () => {
  it('replays the stored response instead of placing a second order', async () => {
    await seedCartWithProduct();

    const first = await post('/api/checkout/session')
      .set('Idempotency-Key', 'double-tap')
      .send(checkoutBody)
      .expect(201);
    const second = await post('/api/checkout/session')
      .set('Idempotency-Key', 'double-tap')
      .send(checkoutBody)
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(await Order.countDocuments()).toBe(1);
  });

  /**
   * The third case, which is the one usually missing. Replaying the first response here
   * would tell somebody their order succeeded when the order they just described was
   * never created.
   */
  it('refuses the same key with a different body', async () => {
    await seedCartWithProduct();

    await post('/api/checkout/session')
      .set('Idempotency-Key', 'reused')
      .send(checkoutBody)
      .expect(201);

    const res = await post('/api/checkout/session')
      .set('Idempotency-Key', 'reused')
      .send({ ...checkoutBody, email: 'someone.else@haestore.test' })
      .expect(422);

    expect(bodyOf<ErrorBody>(res).error.code).toBe('UNPROCESSABLE');
    expect(await Order.countDocuments()).toBe(1);
  });

  it('matches a body whose keys are in a different order', async () => {
    await seedCartWithProduct();

    const first = await post('/api/checkout/session')
      .set('Idempotency-Key', 'reordered')
      .send(checkoutBody)
      .expect(201);

    const reordered = {
      provider: checkoutBody.provider,
      shippingAddress: {
        country: 'IS',
        city: 'Reykjavík',
        line1: '1 Market Street',
        name: 'A Shopper',
      },
      email: checkoutBody.email,
    };
    const second = await post('/api/checkout/session')
      .set('Idempotency-Key', 'reordered')
      .send(reordered)
      .expect(201);

    expect(second.body).toEqual(first.body);
  });

  /** One client's key must never replay another's order. */
  it('scopes a key to its owner', async () => {
    await seedCartWithProduct();
    await post('/api/checkout/session')
      .set('Idempotency-Key', 'shared-key')
      .send(checkoutBody)
      .expect(201);

    // A different caller, same key, no cart of their own: the key must not be found.
    const res = await request(app)
      .post('/api/checkout/session')
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', 'shared-key')
      .send(checkoutBody);

    expect(res.status).not.toBe(201);
    expect(res.body).not.toHaveProperty('data.stripe');
  });

  /** A failed attempt must stay retryable, or a transient failure becomes permanent. */
  it('does not store a failed response', async () => {
    // No cart at all, so the route fails.
    await post('/api/checkout/session')
      .set('Idempotency-Key', 'failed-then-retried')
      .send(checkoutBody)
      .expect(404);

    expect(await IdempotencyKey.countDocuments({ key: 'failed-then-retried' })).toBe(0);

    await seedCartWithProduct();
    await post('/api/checkout/session')
      .set('Idempotency-Key', 'failed-then-retried')
      .send(checkoutBody)
      .expect(201);
  });
});

describe('the Stripe webhook', () => {
  const SECRET = process.env.STRIPE_WEBHOOK_SECRET!;

  function signed(payload: object, secret = SECRET) {
    const body = JSON.stringify(payload);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return { body, header: `t=${t},v1=${sig}` };
  }

  async function placeOrder() {
    await seedCartWithProduct(2, 1800);
    const res = await post('/api/checkout/session')
      .set('Idempotency-Key', `k-${Date.now()}-${Math.random()}`)
      .send(checkoutBody)
      .expect(201);
    return Order.findById(bodyOf<OrderBody>(res).data.order.id);
  }

  const succeededEvent = (
    order: { _id: unknown; payment: { intentId?: string | null } },
    id: string,
  ) => ({
    id,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: order.payment.intentId,
        amount_received: 3600,
        currency: 'usd',
        status: 'succeeded',
        latest_charge: 'ch_test_webhook',
        metadata: { orderId: String(order._id) },
      },
    },
  });

  it('pays the order on a correctly signed delivery', async () => {
    const order = await placeOrder();
    const { body, header } = signed(succeededEvent(order!, 'evt_ok'));

    await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const stored = await Order.findById(order!._id);
    expect(stored!.status).toBe('paid');
    expect(await OrderOutbox.countDocuments({ order: order!._id })).toBe(1);
  });

  /**
   * The route is mounted above express.json() precisely so this works. If it were
   * mounted below, req.body would be a parsed object and the signature would never
   * verify — so this test failing means the mounting order in app.ts has been changed.
   */
  it('verifies against the raw bytes', async () => {
    const order = await placeOrder();
    const { body, header } = signed(succeededEvent(order!, 'evt_raw'));

    // Re-serialised with different whitespace: same JSON, different bytes, must fail.
    const respaced = JSON.stringify(JSON.parse(body), null, 2);
    await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(respaced)
      .expect(400);

    expect((await Order.findById(order!._id))!.status).toBe('pending_payment');
  });

  it('refuses an unsigned delivery and does not pay the order', async () => {
    const order = await placeOrder();
    const { body } = signed(succeededEvent(order!, 'evt_unsigned'));

    await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(400);

    await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', 't=1,v1=deadbeef')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(400);

    expect((await Order.findById(order!._id))!.status).toBe('pending_payment');
  });

  /** Redelivery is recorded and ignored, and answered 200 so the provider stops. */
  it('dedupes a redelivered event on its id', async () => {
    const order = await placeOrder();
    const event = succeededEvent(order!, 'evt_repeat');

    const first = signed(event);
    await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', first.header)
      .set('Content-Type', 'application/json')
      .send(first.body)
      .expect(200);

    const second = signed(event);
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', second.header)
      .set('Content-Type', 'application/json')
      .send(second.body)
      .expect(200);

    expect(bodyOf<WebhookBody>(res).duplicate).toBe(true);
    expect(await PaymentEvent.countDocuments({ eventId: 'evt_repeat' })).toBe(1);
    expect(await OrderOutbox.countDocuments({ order: order!._id })).toBe(1);
  });

  /** A forged amount must not pay the order, even with a valid signature. */
  it('refuses to pay when the event reports the wrong amount', async () => {
    const order = await placeOrder();
    const event = succeededEvent(order!, 'evt_wrong_amount');
    event.data.object.amount_received = 1;

    const { body, header } = signed(event);
    await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const stored = await Order.findById(order!._id);
    expect(stored!.status).toBe('pending_payment');
    expect(stored!.payment.lastError).toMatch(/amount mismatch/);
  });

  /**
   * A failed card is not a cancellation: the shopper can try another card on the same
   * intent, and releasing their stock mid-attempt would hand it to somebody else.
   */
  it('records a failed payment without cancelling the order', async () => {
    const order = await placeOrder();
    const event = {
      id: 'evt_failed',
      type: 'payment_intent.payment_failed',
      data: { object: { id: order!.payment.intentId, status: 'requires_payment_method' } },
    };
    const { body, header } = signed(event);

    await request(app)
      .post('/api/webhooks/stripe')
      .set('Stripe-Signature', header)
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(200);

    const stored = await Order.findById(order!._id);
    expect(stored!.status).toBe('pending_payment');
    expect(stored!.stockReserved).toBe(true);
  });
});

describe('reading an order', () => {
  it('lets a guest read theirs with the claim token, and nobody else without it', async () => {
    await seedCartWithProduct();
    const created = await post('/api/checkout/session')
      .set('Idempotency-Key', 'read-me')
      .send(checkoutBody)
      .expect(201);

    const { orderNumber, claimToken } = bodyOf<OrderBody>(created).data.order;

    await request(app)
      .get(`/api/checkout/order/${orderNumber}?t=${claimToken}`)
      .set('Origin', ORIGIN)
      .expect(200);

    // A bare order number authorises nothing — and answers 404, not 403, so it cannot
    // be used to discover which numbers exist.
    await request(app).get(`/api/checkout/order/${orderNumber}`).set('Origin', ORIGIN).expect(404);

    await request(app)
      .get(`/api/checkout/order/${orderNumber}?t=not-the-token`)
      .set('Origin', ORIGIN)
      .expect(404);
  });

  /**
   * The defect a rendered confirmation page exposed: an unslashed zero in the shop's
   * face is indistinguishable from a capital O, so the number a customer types back is
   * not the number that was generated. Without the Crockford fold they are told their
   * order does not exist.
   */
  it('finds an order from the misread spelling of its number', async () => {
    await seedCartWithProduct();
    const created = await post('/api/checkout/session')
      .set('Idempotency-Key', 'misread')
      .send(checkoutBody)
      .expect(201);

    const { orderNumber, claimToken } = bodyOf<OrderBody>(created).data.order;
    const misread = orderNumber.replace(/0/g, 'O').replace(/1/g, 'I').toLowerCase();
    expect(misread).not.toBe(orderNumber);

    const res = await request(app)
      .get(`/api/checkout/order/${misread}?t=${String(claimToken)}`)
      .set('Origin', ORIGIN)
      .expect(200);

    expect(bodyOf<OrderBody>(res).data.order.orderNumber).toBe(orderNumber);
  });

  it('never returns the payment ids or the verification error text', async () => {
    await seedCartWithProduct();
    const created = await post('/api/checkout/session')
      .set('Idempotency-Key', 'no-leaks')
      .send(checkoutBody)
      .expect(201);

    const res = await request(app)
      .get(
        `/api/checkout/order/${bodyOf<OrderBody>(created).data.order.orderNumber}?t=${String(bodyOf<OrderBody>(created).data.order.claimToken)}`,
      )
      .set('Origin', ORIGIN)
      .expect(200);

    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain('pi_test');
    expect(serialised).not.toContain('claimTokenHash');
    expect(serialised).not.toContain('lastError');
  });
});

beforeEach(async () => {
  await Promise.all([
    Order.deleteMany({}),
    OrderOutbox.deleteMany({}),
    Cart.deleteMany({}),
    PaymentEvent.deleteMany({}),
    IdempotencyKey.deleteMany({}),
  ]);
});
