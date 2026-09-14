import type { OrderDoc } from './order.model.js';
import { toOrderResponse } from './order.presenter.js';
import { adminActionsFor } from './order-status.js';

/**
 * The order, as the admin console sees it.
 *
 * Built on the shopper's projection and adding to it, rather than starting from the
 * document, for the reason the shopper's presenter gives: a serialiser that removes fields
 * is one new field away from leaking. The additions are the ones an operator needs to
 * settle a dispute — the provider's ids, its verbatim status, which check refused a
 * payment, and the history — and `claimTokenHash` is still not among them.
 */

/**
 * How long an order may sit in `pending_payment` with a payment started before it looks
 * like a lost webhook rather than a shopper still on the payment page. The reservation
 * lasts thirty minutes; a quarter of an hour in, a real payment has long since landed.
 */
export const STUCK_PAYMENT_AFTER_MS = 15 * 60 * 1000;

export function isStuckPayment(
  order: Pick<OrderDoc, 'status' | 'createdAt'> & { payment: { intentId?: string | null } },
  now = Date.now(),
): boolean {
  return (
    order.status === 'pending_payment' &&
    Boolean(order.payment.intentId) &&
    now - order.createdAt.getTime() > STUCK_PAYMENT_AFTER_MS
  );
}

export function toAdminOrderSummary(order: OrderDoc) {
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    email: order.email,
    guest: order.user === null,
    itemCount: order.lines.reduce((n, line) => n + line.quantity, 0),
    grandTotal: order.totals.grandTotal,
    provider: order.payment.provider,
    placedAt: order.createdAt.toISOString(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    stuckPayment: isStuckPayment(order),
  };
}

export function toAdminOrderResponse(order: OrderDoc) {
  const base = toOrderResponse(order);

  return {
    ...base,
    status: order.status,
    userId: order.user ? String(order.user) : null,
    payment: {
      ...base.payment,
      intentId: order.payment.intentId ?? null,
      captureId: order.payment.captureId ?? null,
      providerStatus: order.payment.providerStatus ?? null,
      amountCaptured: order.payment.amountCaptured ?? null,
      capturedAt: order.payment.capturedAt ? order.payment.capturedAt.toISOString() : null,
      lastError: order.payment.lastError ?? null,
    },
    stockReserved: order.stockReserved,
    reservationExpiresAt: order.reservationExpiresAt
      ? order.reservationExpiresAt.toISOString()
      : null,
    canceledAt: order.canceledAt ? order.canceledAt.toISOString() : null,
    stuckPayment: isStuckPayment(order),
    history: order.history.map((entry) => ({
      status: entry.status,
      at: entry.at.toISOString(),
      by: entry.by,
      ...(entry.note ? { note: entry.note } : {}),
    })),
    /** Rendered as buttons. Derived from the status machine; see `adminActionsFor`. */
    actions: adminActionsFor({
      status: order.status,
      paymentStarted: Boolean(order.payment.intentId),
    }),
  };
}

export type AdminOrderResponse = ReturnType<typeof toAdminOrderResponse>;
