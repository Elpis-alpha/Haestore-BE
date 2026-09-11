import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { Category } from '../catalog/category.model.js';
import { Product } from '../catalog/product.model.js';
import { Cart } from '../cart/cart.model.js';
import { lineKeyOf } from '../cart/line-key.js';
import { Order } from '../order/order.model.js';
import { OrderOutbox } from '../order/order-outbox.model.js';
import { sweepExpiredReservations } from '../order/order-jobs.js';
import { cancelOrder, markOrderPaid, transition } from '../order/order.service.js';
import { createOrderFromCart } from './checkout.service.js';
import { reserveAll, reserveOne, releaseOne } from './reservation.js';

/**
 * Checkout against a real replica set.
 *
 * The unit suites prove the state machine, the money conversion and the five PayPal
 * checks in isolation. What only an integration test can prove is the part that spans
 * documents and transactions: that stock actually moves, that it moves back, that a
 * replayed payment does not move it twice, and that an order and its reservation are
 * written atomically or not at all.
 *
 * The plan names one of these as a required test in so many words: **replaying the same
 * `payment_intent.succeeded` must not double-decrement stock or duplicate the order.**
 */

async function seedProduct(options: { available?: number; price?: number } = {}) {
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
        price: { amount: options.price ?? 1800, currency: 'USD' },
        stock: {
          onHand: options.available ?? 10,
          reserved: 0,
          available: options.available ?? 10,
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
  return {
    productId: String(product._id),
    variantId: String(variant._id),
    lineKey: lineKeyOf(String(product._id), String(variant._id)),
  };
}

async function seedCart(
  seed: { productId: string; variantId: string; lineKey: string },
  quantity = 2,
  owner: { userId?: string; guestKey?: string } = { guestKey: 'guest-key-hash' },
) {
  return Cart.create({
    ...(owner.userId ? { user: new mongoose.Types.ObjectId(owner.userId) } : {}),
    ...(owner.guestKey ? { guestKeyHash: owner.guestKey } : {}),
    status: 'active',
    currency: 'USD',
    lines: [
      {
        lineKey: seed.lineKey,
        product: new mongoose.Types.ObjectId(seed.productId),
        variantId: new mongoose.Types.ObjectId(seed.variantId),
        sku: 'SKU-TEST',
        title: 'House Blend',
        slug: 'house-blend',
        axisValues: [],
        unitPrice: { amount: 1800, currency: 'USD' },
        quantity,
        addedAt: new Date(),
      },
    ],
    savedForLater: [],
  });
}

const stockOf = async (productId: string) => {
  const product = await Product.findById(productId).lean();
  return product!.variants[0]!.stock;
};

const checkoutInput = {
  email: 'shopper@haestore.test',
  shippingAddress: {
    name: 'A Shopper',
    line1: '1 Market Street',
    city: 'Reykjavík',
    country: 'IS',
  },
  provider: 'stripe' as const,
};

describe('the reservation guard', () => {
  it('moves stock from available to reserved', async () => {
    const seed = await seedProduct({ available: 5 });

    expect(await reserveOne({ ...seed, quantity: 2 })).toBe(true);

    const stock = await stockOf(seed.productId);
    expect(stock.available).toBe(3);
    expect(stock.reserved).toBe(2);
    // onHand does not move on a reservation — nothing has left the building yet.
    expect(stock.onHand).toBe(5);
  });

  /**
   * The property Phase 0's probe established, re-asserted through our own code path:
   * the availability test is part of the write, so it cannot be raced.
   */
  it('refuses to over-reserve, and leaves the stock untouched when it refuses', async () => {
    const seed = await seedProduct({ available: 3 });

    expect(await reserveOne({ ...seed, quantity: 2 })).toBe(true);
    expect(await reserveOne({ ...seed, quantity: 2 })).toBe(false);

    const stock = await stockOf(seed.productId);
    expect(stock.available).toBe(1);
    expect(stock.reserved).toBe(2);
  });

  it('survives concurrent reservations without over-selling', async () => {
    const seed = await seedProduct({ available: 10 });

    // Twenty concurrent attempts at 1 each against 10 available. Exactly 10 must win.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveOne({ ...seed, quantity: 1 })),
    );

    expect(results.filter(Boolean)).toHaveLength(10);
    const stock = await stockOf(seed.productId);
    expect(stock.available).toBe(0);
    expect(stock.reserved).toBe(10);
  });

  it('gives stock back on release', async () => {
    const seed = await seedProduct({ available: 5 });
    await reserveOne({ ...seed, quantity: 2 });
    await releaseOne({ ...seed, quantity: 2 });

    const stock = await stockOf(seed.productId);
    expect(stock.available).toBe(5);
    expect(stock.reserved).toBe(0);
  });

  /**
   * All-or-nothing across lines. A partial reservation would hold stock for an order
   * that was never created — invisible, held forever, with nothing pointing at it.
   */
  it('rolls back every line it took when one cannot be filled', async () => {
    const plenty = await seedProduct({ available: 10 });
    const scarce = await seedProduct({ available: 1 });

    const result = await reserveAll([
      { ...plenty, quantity: 3 },
      { ...scarce, quantity: 5 },
    ]);

    expect(result).toEqual({ ok: false, failedAt: 1 });
    expect((await stockOf(plenty.productId)).available).toBe(10);
    expect((await stockOf(plenty.productId)).reserved).toBe(0);
  });
});

describe('creating an order from a cart', () => {
  it('reserves stock, writes the order and retires the cart, atomically', async () => {
    const seed = await seedProduct({ available: 10, price: 1800 });
    const cart = await seedCart(seed, 2);

    const { order, claimToken } = await createOrderFromCart(
      { guestKey: 'guest-key-hash' },
      checkoutInput,
    );

    expect(order.status).toBe('pending_payment');
    expect(order.lines).toHaveLength(1);
    expect(order.lines[0]!.quantity).toBe(2);
    expect(order.stockReserved).toBe(true);

    // The totals, with no shipping and no tax: grandTotal is the subtotal.
    expect(order.totals.subtotal.amount).toBe(3600);
    expect(order.totals.grandTotal.amount).toBe(3600);

    const stock = await stockOf(seed.productId);
    expect(stock.available).toBe(8);
    expect(stock.reserved).toBe(2);

    // The cart is retired, which is what releases the partial unique index so the
    // shopper's next cart can be created. Phase 6 left this value with nothing setting it.
    const retired = await Cart.findById(cart._id);
    expect(retired!.status).toBe('ordered');

    // A guest gets a claim token; only its HMAC is stored.
    expect(claimToken).toBeTruthy();
    expect(order.claimTokenHash).toBeTruthy();
    expect(order.claimTokenHash).not.toBe(claimToken);
  });

  /** The line total is never stored — the Phase 6 repair, carried into the order. */
  it('stores no line total on the order document', async () => {
    const seed = await seedProduct();
    await seedCart(seed, 3);
    const { order } = await createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput);

    const raw = await mongoose.connection
      .db!.collection<{ lines: Record<string, unknown>[] }>('orders')
      .findOne({ _id: order._id });
    expect(raw!.lines[0]).not.toHaveProperty('lineTotal');
    expect(raw!.lines[0]).toHaveProperty('unitPrice');
  });

  /**
   * The client sends no amounts, ever. Re-pricing from live data is what makes that
   * true in practice rather than only in the schema.
   */
  it('charges the live price, not the price stored on the cart line', async () => {
    const seed = await seedProduct({ price: 1800 });
    await seedCart(seed, 1);

    await Product.updateOne({ _id: seed.productId }, { $set: { 'variants.0.price.amount': 2500 } });

    const { order } = await createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput);
    expect(order.lines[0]!.unitPrice.amount).toBe(2500);
    expect(order.totals.grandTotal.amount).toBe(2500);
  });

  it('refuses when stock has run out, and reserves nothing', async () => {
    const seed = await seedProduct({ available: 1 });
    await seedCart(seed, 5);

    await expect(
      createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    const stock = await stockOf(seed.productId);
    expect(stock.available).toBe(1);
    expect(stock.reserved).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
  });

  it('refuses an empty bag', async () => {
    await Cart.create({
      guestKeyHash: 'guest-key-hash',
      status: 'active',
      currency: 'USD',
      lines: [],
      savedForLater: [],
    });
    await expect(
      createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput),
    ).rejects.toThrow(/empty/i);
  });

  it('gives an account order no claim token — the session already authorises it', async () => {
    const userId = new mongoose.Types.ObjectId().toHexString();
    const seed = await seedProduct();
    await seedCart(seed, 1, { userId });

    const { order, claimToken } = await createOrderFromCart({ userId }, checkoutInput);
    expect(claimToken).toBeNull();
    expect(order.claimTokenHash).toBeNull();
    expect(String(order.user)).toBe(userId);
  });
});

describe('markOrderPaid', () => {
  async function placeOrder(available = 10, quantity = 2) {
    const seed = await seedProduct({ available, price: 1800 });
    await seedCart(seed, quantity);
    const { order } = await createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput);
    return { seed, order };
  }

  const paidInput = (orderId: string, amount: number) => ({
    orderId,
    provider: 'stripe' as const,
    intentId: 'pi_test_123',
    captureId: 'ch_test_123',
    amountCaptured: { amount, currency: 'USD' },
    providerStatus: 'succeeded',
    by: 'webhook',
  });

  it('moves a pending order to paid and queues the receipt', async () => {
    const { order } = await placeOrder();

    const result = await markOrderPaid(paidInput(String(order._id), 3600));
    expect(result.outcome).toBe('paid');

    const stored = await Order.findById(order._id);
    expect(stored!.status).toBe('paid');
    expect(stored!.paidAt).toBeTruthy();
    // The hold stops expiring the instant it is paid for, or the sweeper could cancel
    // a paid order — the worst bug available in this phase.
    expect(stored!.reservationExpiresAt).toBeNull();

    const outbox = await OrderOutbox.find({ order: order._id });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.kind).toBe('order-confirmation');
  });

  /**
   * **The test the plan names.** Stripe retries any non-2xx for up to three days and
   * delivers at-least-once regardless, so this is not a hypothetical.
   */
  it('replaying the same payment does not pay twice, duplicate the order, or move stock again', async () => {
    const { seed, order } = await placeOrder();

    const stockAfterReserve = await stockOf(seed.productId);

    const first = await markOrderPaid(paidInput(String(order._id), 3600));
    const second = await markOrderPaid(paidInput(String(order._id), 3600));
    const third = await markOrderPaid(paidInput(String(order._id), 3600));

    expect(first.outcome).toBe('paid');
    expect(second.outcome).toBe('already_settled');
    expect(third.outcome).toBe('already_settled');

    expect(await Order.countDocuments()).toBe(1);

    // Stock is exactly where the reservation left it — three deliveries moved it once.
    expect(await stockOf(seed.productId)).toEqual(stockAfterReserve);

    // And exactly one receipt, not three.
    expect(await OrderOutbox.countDocuments({ order: order._id })).toBe(1);
  });

  it('handles concurrent deliveries of the same payment', async () => {
    const { order } = await placeOrder();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => markOrderPaid(paidInput(String(order._id), 3600))),
    );

    expect(results.filter((r) => r.outcome === 'paid')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_settled')).toHaveLength(4);
    expect(await OrderOutbox.countDocuments({ order: order._id })).toBe(1);
  });

  /**
   * The check the 2022 app had no equivalent of. An order whose provider reports a
   * different amount is left unpaid, deliberately — the alternative ships goods against
   * money that did not arrive.
   */
  it('refuses to mark paid when the provider reports a different amount', async () => {
    const { order } = await placeOrder();

    const result = await markOrderPaid(paidInput(String(order._id), 100));
    expect(result.outcome).toBe('amount_mismatch');

    const stored = await Order.findById(order._id);
    expect(stored!.status).toBe('pending_payment');
    expect(stored!.paidAt).toBeNull();
    expect(stored!.payment.lastError).toMatch(/amount mismatch/);
    expect(await OrderOutbox.countDocuments()).toBe(0);
  });

  it('refuses the right amount in the wrong currency', async () => {
    const { order } = await placeOrder();
    const result = await markOrderPaid({
      ...paidInput(String(order._id), 3600),
      amountCaptured: { amount: 3600, currency: 'EUR' },
    });
    expect(result.outcome).toBe('amount_mismatch');
    expect((await Order.findById(order._id))!.status).toBe('pending_payment');
  });

  /**
   * One PaymentIntent, one order — enforced by the database, not by the code. This is
   * the guard in the other direction from the status filter.
   */
  it('cannot attach one payment intent to two orders', async () => {
    const a = await placeOrder();
    await Cart.deleteMany({});
    const b = await placeOrder();

    await markOrderPaid(paidInput(String(a.order._id), 3600));
    await expect(markOrderPaid(paidInput(String(b.order._id), 3600))).rejects.toMatchObject({
      code: 11000,
    });

    expect((await Order.findById(b.order._id))!.status).toBe('pending_payment');
  });
});

describe('the status machine over real documents', () => {
  async function placeOrder() {
    const seed = await seedProduct({ available: 10 });
    await seedCart(seed, 2);
    const { order } = await createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput);
    return { seed, order };
  }

  it('refuses an illegal transition and says which kind of refusal it was', async () => {
    const { order } = await placeOrder();

    // pending_payment cannot go straight to shipped.
    const skipped = await transition(order._id, 'shipped', 'test');
    expect(skipped).toEqual({ moved: false, reason: 'illegal_transition' });
    expect((await Order.findById(order._id))!.status).toBe('pending_payment');

    const missing = await transition(new mongoose.Types.ObjectId(), 'paid', 'test');
    expect(missing).toEqual({ moved: false, reason: 'not_found' });
  });

  it('appends to the history on every move', async () => {
    const { order } = await placeOrder();
    await markOrderPaid({
      orderId: String(order._id),
      provider: 'stripe',
      intentId: 'pi_history',
      captureId: null,
      amountCaptured: { amount: 3600, currency: 'USD' },
      providerStatus: 'succeeded',
      by: 'webhook',
    });
    await transition(order._id, 'processing', 'admin:someone');

    const stored = await Order.findById(order._id);
    expect(stored!.history.map((h) => h.status)).toEqual(['pending_payment', 'paid', 'processing']);
    expect(stored!.history.at(-1)!.by).toBe('admin:someone');
  });

  it('returns stock to the shelf on cancellation, exactly once', async () => {
    const { seed, order } = await placeOrder();
    expect((await stockOf(seed.productId)).available).toBe(8);

    await cancelOrder(order._id, 'admin:someone');
    expect((await stockOf(seed.productId)).available).toBe(10);
    expect((await stockOf(seed.productId)).reserved).toBe(0);

    // A second cancel is refused by the status machine, and even if it were not, the
    // stockReserved flag makes the release idempotent.
    const again = await cancelOrder(order._id, 'admin:someone');
    expect(again.moved).toBe(false);
    expect((await stockOf(seed.productId)).available).toBe(10);
  });

  it('cannot cancel a shipped order', async () => {
    const { order } = await placeOrder();
    await Order.updateOne({ _id: order._id }, { $set: { status: 'shipped' } });

    const result = await transition(order._id, 'canceled', 'admin:someone');
    expect(result).toEqual({ moved: false, reason: 'illegal_transition' });
  });
});

describe('the reservation sweeper', () => {
  it('cancels an expired unpaid order and returns its stock', async () => {
    const seed = await seedProduct({ available: 10 });
    await seedCart(seed, 3);
    const { order } = await createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput);

    expect((await stockOf(seed.productId)).available).toBe(7);

    // Wind the hold back rather than waiting thirty minutes.
    await Order.updateOne(
      { _id: order._id },
      { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } },
    );

    expect(await sweepExpiredReservations()).toBe(1);

    const stored = await Order.findById(order._id);
    expect(stored!.status).toBe('canceled');
    expect(stored!.stockReserved).toBe(false);
    expect((await stockOf(seed.productId)).available).toBe(10);
  });

  /** The worst bug available in this phase, asserted against. */
  it('never touches a paid order, even one whose hold has passed', async () => {
    const seed = await seedProduct({ available: 10 });
    await seedCart(seed, 3);
    const { order } = await createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput);

    await markOrderPaid({
      orderId: String(order._id),
      provider: 'stripe',
      intentId: 'pi_sweeper',
      captureId: null,
      amountCaptured: { amount: 5400, currency: 'USD' },
      providerStatus: 'succeeded',
      by: 'webhook',
    });

    // Force the stale hold back on, which markOrderPaid clears — so this tests the
    // status filter itself rather than only the cleared timestamp.
    await Order.updateOne(
      { _id: order._id },
      { $set: { reservationExpiresAt: new Date(Date.now() - 60_000) } },
    );

    expect(await sweepExpiredReservations()).toBe(0);

    const stored = await Order.findById(order._id);
    expect(stored!.status).toBe('paid');
    expect((await stockOf(seed.productId)).available).toBe(7);
  });

  it('leaves an order whose hold has not expired alone', async () => {
    const seed = await seedProduct({ available: 10 });
    await seedCart(seed, 1);
    await createOrderFromCart({ guestKey: 'guest-key-hash' }, checkoutInput);

    expect(await sweepExpiredReservations()).toBe(0);
    expect((await stockOf(seed.productId)).available).toBe(9);
  });
});

beforeEach(async () => {
  await Promise.all([Order.deleteMany({}), OrderOutbox.deleteMany({}), Cart.deleteMany({})]);
});
