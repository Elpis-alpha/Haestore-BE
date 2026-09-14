import mongoose from 'mongoose';
import { Order, type OrderDoc } from './order.model.js';
import { appendOrderOutbox } from './order-outbox.model.js';
import { predecessorsOf, type OrderStatus } from './order-status.js';
import { normaliseOrderNumber } from './order-number.js';
import { consumeAll, releaseAll, type ReservationRequest } from '../checkout/reservation.js';
import { notFound } from '../../lib/errors.js';
import { escapeRegExp } from '../../lib/regex.js';
import { logger } from '../../lib/logger.js';
import type { Money } from '../../lib/money.js';

/**
 * Everything that moves an order between states.
 *
 * The rule the whole file obeys: **a transition is a guarded write, and a `null` result
 * is an answer rather than an error.** Nothing here reads a status, decides in
 * JavaScript, and writes — that shape is racy by construction, and the things calling
 * these functions are webhooks, which arrive concurrently, repeatedly and late.
 */

/** The reservation shape an order's lines imply, for release and consumption. */
export function reservationsOf(order: Pick<OrderDoc, 'lines'>): ReservationRequest[] {
  return order.lines.map((line) => ({
    productId: String(line.product),
    variantId: String(line.variantId),
    quantity: line.quantity,
  }));
}

export type TransitionResult =
  { moved: true; order: OrderDoc } | { moved: false; reason: 'not_found' | 'illegal_transition' };

/**
 * The generic guarded transition.
 *
 * `status: { $in: predecessorsOf(next) }` is the entire enforcement of the state
 * machine. There is no `if` anywhere that duplicates it, because a second copy of the
 * rule is a second copy that can disagree with the first.
 */
export async function transition(
  orderId: string | mongoose.Types.ObjectId,
  next: OrderStatus,
  by: string,
  note?: string,
  options: {
    /**
     * Narrows the legal predecessors further, never widens them. The admin console
     * cancels only unpaid orders although the machine allows canceling a paid one, and
     * that narrowing belongs in the same filter as the machine rather than in an `if`
     * in front of it.
     */
    from?: readonly OrderStatus[];
  } = {},
): Promise<TransitionResult> {
  const { from } = options;
  const allowed = from
    ? predecessorsOf(next).filter((status) => from.includes(status))
    : predecessorsOf(next);

  const order = await Order.findOneAndUpdate(
    { _id: orderId, status: { $in: allowed } },
    {
      $set: { status: next, ...(next === 'canceled' ? { canceledAt: new Date() } : {}) },
      $push: { history: { status: next, at: new Date(), by, ...(note ? { note } : {}) } },
    },
    { new: true },
  );

  if (order) return { moved: true, order };

  // Distinguishing the two is worth one extra read on a path that is, by definition,
  // not the hot one: "this order does not exist" and "this order was already shipped"
  // are very different things to find in a log at 3 a.m.
  const exists = await Order.exists({ _id: orderId });
  return { moved: false, reason: exists ? 'illegal_transition' : 'not_found' };
}

export type MarkPaidInput = {
  orderId: string;
  provider: 'stripe' | 'paypal';
  intentId: string;
  captureId: string | null;
  amountCaptured: Money;
  providerStatus: string;
  /** `webhook`, `reconcile`, or `admin:<userId>` — recorded in the order's history. */
  by: string;
};

export type MarkPaidResult =
  | { outcome: 'paid'; order: OrderDoc }
  /** Already paid, or in some later state. A replayed or late delivery. Not an error. */
  | { outcome: 'already_settled'; order: OrderDoc }
  | { outcome: 'not_found' }
  /** The provider's amount did not equal ours. The order is left unpaid, deliberately. */
  | { outcome: 'amount_mismatch'; expected: Money; actual: Money };

/**
 * **The only function that moves an order into a paid state.**
 *
 * Three callers — the Stripe webhook, the PayPal capture, and the return page's
 * reconcile — and they are three deliveries of one idempotent operation rather than
 * three code paths that each need to be correct.
 *
 * The idempotency is one clause: `status: 'pending_payment'` matches exactly once,
 * because nothing can return to `pending_payment` (asserted in order-status.test.ts).
 * The second delivery matches no document, and that is the whole story — there is no
 * "have we already processed this?" lookup to race.
 *
 * **The amount is verified before the write, not after.** An order whose provider
 * reports a different amount is left in `pending_payment` with the discrepancy recorded,
 * because the alternative — marking it paid and raising an alert — ships goods against
 * money that did not arrive. This is the check the 2022 app had no equivalent of.
 */
export async function markOrderPaid(input: MarkPaidInput): Promise<MarkPaidResult> {
  const order = await Order.findById(input.orderId);
  if (!order) return { outcome: 'not_found' };

  const expected = order.totals.grandTotal;

  if (
    input.amountCaptured.amount !== expected.amount ||
    input.amountCaptured.currency.toUpperCase() !== expected.currency.toUpperCase()
  ) {
    logger.error(
      {
        orderId: input.orderId,
        orderNumber: order.orderNumber,
        expected,
        actual: input.amountCaptured,
        provider: input.provider,
      },
      'order: provider reported an amount that is not ours — NOT marking paid',
    );

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          'payment.lastError': `amount mismatch: provider reported ${input.amountCaptured.amount} ${input.amountCaptured.currency}, order is ${expected.amount} ${expected.currency}`,
          'payment.providerStatus': input.providerStatus,
        },
      },
    );

    return { outcome: 'amount_mismatch', expected, actual: input.amountCaptured };
  }

  const session = await mongoose.startSession();
  try {
    let result: MarkPaidResult | null = null;

    await session.withTransaction(async () => {
      const paid = await Order.findOneAndUpdate(
        { _id: order._id, status: 'pending_payment' },
        {
          $set: {
            status: 'paid',
            paidAt: new Date(),
            'payment.provider': input.provider,
            'payment.intentId': input.intentId,
            'payment.captureId': input.captureId,
            'payment.amountCaptured': input.amountCaptured,
            'payment.providerStatus': input.providerStatus,
            'payment.capturedAt': new Date(),
            'payment.lastError': null,
            // The hold stops expiring the moment it is paid for. Leaving this set would
            // let the sweeper cancel a paid order, which is the worst bug in the phase.
            reservationExpiresAt: null,
          },
          $push: { history: { status: 'paid', at: new Date(), by: input.by } },
        },
        { new: true, session },
      );

      if (!paid) {
        // Somebody else got there first: the webhook and the reconcile both arrived, or
        // the event was redelivered. Correct and expected — return 200 and do nothing.
        const current = await Order.findById(order._id).session(session);
        result = { outcome: 'already_settled', order: current! };
        return;
      }

      // The receipt's intent commits with the payment, so it cannot be lost by a crash
      // between them and cannot be sent for a payment that was rolled back.
      await appendOrderOutbox(session, { kind: 'order-confirmation', orderId: paid._id });

      result = { outcome: 'paid', order: paid };
    });

    return result!;
  } finally {
    await session.endSession();
  }
}

/**
 * Cancels an order and gives its stock back.
 *
 * The release is guarded on `stockReserved` flipping true → false in a single write, so
 * the sweeper, an admin and a webhook can all try to cancel the same order and the
 * stock is returned exactly once. Deriving "is it still held?" from the status instead
 * would let two concurrent cancels both decide yes.
 */
export async function cancelOrder(
  orderId: string | mongoose.Types.ObjectId,
  by: string,
  note?: string,
  options: { from?: readonly OrderStatus[] } = {},
): Promise<TransitionResult> {
  const result = await transition(orderId, 'canceled', by, note, options);
  if (!result.moved) return result;

  await releaseReservation(result.order, by);
  return result;
}

/**
 * Hands an order to the carrier, and turns its hold into stock that has left the building.
 *
 * **The status change and the stock consumption are one transaction, and the consumption
 * is claimed in the same write as the status.** The update flips `status` to `shipped`
 * and `stockReserved` to false together and returns the document as it was *before*, so
 * "was the stock still held?" is answered by the write that took it — not by a read that
 * a second press of the button could also pass. Two admins shipping the same order at
 * once produce one shipment and one decrement of `onHand`; the other gets a `null`, which
 * is the machine saying the order is already shipped.
 *
 * This is the one place `onHand` moves outside an admin correction, which is why
 * `consumeAll` waited from Phase 7 for this caller rather than being wired to something
 * earlier.
 */
export async function shipOrder(
  orderId: string | mongoose.Types.ObjectId,
  by: string,
  note?: string,
): Promise<TransitionResult> {
  const outcome: { order: OrderDoc | null } = { order: null };

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      outcome.order = null;

      const before = await Order.findOneAndUpdate(
        { _id: orderId, status: { $in: predecessorsOf('shipped') } },
        {
          $set: { status: 'shipped', stockReserved: false },
          $push: { history: { status: 'shipped', at: new Date(), by, ...(note ? { note } : {}) } },
        },
        { new: false, session },
      );
      if (!before) return;

      if (before.stockReserved) await consumeAll(reservationsOf(before), session);

      outcome.order = await Order.findById(before._id).session(session);
    });
  } finally {
    await session.endSession();
  }

  if (outcome.order) {
    logger.info(
      { orderId: String(outcome.order._id), orderNumber: outcome.order.orderNumber, by },
      'order: shipped, reserved stock consumed',
    );
    return { moved: true, order: outcome.order };
  }

  const exists = await Order.exists({ _id: orderId });
  return { moved: false, reason: exists ? 'illegal_transition' : 'not_found' };
}

/**
 * Records that an order's money has been returned.
 *
 * **It does not return the money.** This shop reaches its providers for three and five
 * operations respectively (ADR-012), and a refund would be a new kind of call with its
 * own idempotency story — so the refund itself is issued in the Stripe or PayPal
 * dashboard, and this is the record that it was. The note is required for exactly that
 * reason: it is where the admin says so.
 *
 * Stock still held for the order goes back on the shelf, because the goods never left.
 * A shipped or delivered order has no hold, and the release is a no-op: whether returned
 * goods are fit to sell again is a decision about the goods, made by a person holding
 * them, and is a stock correction on the product rather than a side effect here.
 */
export async function recordRefund(
  orderId: string | mongoose.Types.ObjectId,
  by: string,
  note: string,
): Promise<TransitionResult> {
  const result = await transition(orderId, 'refunded', by, note);
  if (!result.moved) return result;

  await releaseReservation(result.order, by);
  return result;
}

/**
 * Returns an order's stock to the shelf, at most once.
 *
 * Separated from `cancelOrder` because the sweeper reaches it by a different route and
 * because the flag, not the status, is the thing being claimed.
 */
export async function releaseReservation(order: OrderDoc, by: string): Promise<boolean> {
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, stockReserved: true },
    { $set: { stockReserved: false } },
    { new: true },
  );
  if (!claimed) return false;

  await releaseAll(reservationsOf(order));
  logger.info(
    { orderId: String(order._id), orderNumber: order.orderNumber, by },
    'order: stock reservation released',
  );
  return true;
}

/**
 * Attaches a new account's prior guest orders to it, at OTP verification.
 *
 * Safe precisely *because* authentication is an emailed code: possession of the code is
 * a strictly stronger claim on the address than the guest cookie ever was. The 2022 app
 * had no guest orders at all, so there is no defect being repaired here — only the
 * Phase 6 placeholder being filled in.
 *
 * `claimTokenHash` is cleared with the claim: once the order is reachable from an
 * account, the emailed link that authorised it without one should stop working.
 */
export async function claimGuestOrders(userId: string, email: string): Promise<number> {
  const result = await Order.updateMany(
    { email: email.toLowerCase().trim(), user: null },
    { $set: { user: new mongoose.Types.ObjectId(userId), claimTokenHash: null } },
  );

  if (result.modifiedCount > 0) {
    logger.info({ userId, count: result.modifiedCount }, 'order: guest orders claimed');
  }
  return result.modifiedCount;
}

/** One page of an account's order history, newest first. */
export async function listOrdersForUser(
  userId: string,
  options: { page?: number; perPage?: number } = {},
) {
  const perPage = Math.min(Math.max(options.perPage ?? 12, 1), 60);
  const page = Math.max(options.page ?? 1, 1);

  const filter = { user: new mongoose.Types.ObjectId(userId) };
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage)
      .lean(),
    Order.countDocuments(filter),
  ]);

  return { orders, page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) };
}

/**
 * The admin order list.
 *
 * `q` is either an order number or the start of an email address, tried together — an
 * admin with a customer on the phone has one or the other and should not have to say
 * which. The order number goes through the same normaliser the shopper's own lookup
 * uses, so `hae cj0rthpk` read down a phone line finds the order.
 *
 * `.skip()` pagination, capped at 60, like the account history: this list is read a page
 * or two deep by a person, not walked by a crawler.
 */
export async function listOrdersForAdmin(options: {
  status?: OrderStatus;
  q?: string;
  page: number;
  perPage: number;
}) {
  const filter: Record<string, unknown> = {};
  if (options.status) filter.status = options.status;
  if (options.q) {
    const q = options.q.trim();
    filter.$or = [
      { orderNumber: normaliseOrderNumber(q) },
      { email: { $regex: `^${escapeRegExp(q.toLowerCase())}` } },
    ];
  }

  const perPage = Math.min(Math.max(options.perPage, 1), 60);
  const page = Math.max(options.page, 1);

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * perPage)
      .limit(perPage),
    Order.countDocuments(filter),
  ]);

  return { orders, page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) };
}

export async function getOrderById(orderId: string): Promise<OrderDoc> {
  if (!mongoose.isValidObjectId(orderId)) throw notFound('Order not found.');
  const order = await Order.findById(orderId);
  if (!order) throw notFound('Order not found.');
  return order;
}

export async function findByOrderNumber(orderNumber: string): Promise<OrderDoc | null> {
  return Order.findOne({ orderNumber: normaliseOrderNumber(orderNumber) });
}
