import { logger } from '../../lib/logger.js';
import { fromDecimalString } from './money-decimal.js';
import { markOrderPaid, type MarkPaidResult } from '../order/order.service.js';
import type { OrderDoc } from '../order/order.model.js';
import { retrievePaymentIntent } from './stripe.js';
import { getPayPalOrder, verifyCapture } from './paypal.js';

/**
 * Asking the provider what actually happened, and funnelling the answer into
 * `markOrderPaid`.
 *
 * **This is what makes the demo work with no webhooks delivered at all.** The return
 * page calls it when the shopper comes back from the payment step; the webhook calls
 * `markOrderPaid` directly when it arrives. They are two deliveries of one idempotent
 * operation, not two implementations — whichever gets there first pays the order and the
 * other finds nothing to do.
 *
 * That property is worth more than the convenience. A webhook-only design is only ever
 * exercised in an environment where webhooks are reachable, which is never a developer's
 * laptop behind NAT, so the path that ships is the path nobody ran. Here the *reconcile*
 * path is the one exercised constantly in development, and the webhook is the
 * optimisation on top.
 *
 * It is also the repair path: an order stuck in `pending_payment` because a webhook was
 * lost is fixed by asking the provider, which an admin can trigger by hand in Phase 8.
 */

export async function reconcileOrderWithProvider(
  order: OrderDoc,
  by = 'reconcile',
): Promise<MarkPaidResult | { outcome: 'nothing_to_do'; reason: string }> {
  if (order.status !== 'pending_payment') {
    return { outcome: 'nothing_to_do', reason: `order is ${order.status}` };
  }

  const intentId = order.payment.intentId;
  if (!intentId) {
    return { outcome: 'nothing_to_do', reason: 'no payment has been started for this order' };
  }

  return order.payment.provider === 'stripe'
    ? reconcileStripe(order, intentId, by)
    : reconcilePayPal(order, intentId, by);
}

async function reconcileStripe(
  order: OrderDoc,
  intentId: string,
  by: string,
): Promise<MarkPaidResult | { outcome: 'nothing_to_do'; reason: string }> {
  const intent = await retrievePaymentIntent(intentId);

  if (intent.status !== 'succeeded') {
    // Entirely normal: the shopper is back on the return page while the intent is still
    // `processing`, or they abandoned it. Not an error, and not something to retry.
    return { outcome: 'nothing_to_do', reason: `payment intent is ${intent.status}` };
  }

  /**
   * `amount_received`, not `amount`. The former is what Stripe actually took; the latter
   * is what the intent was created for. They differ on a partial capture, and reading
   * the wrong one would accept an underpayment — the same mistake the PayPal check
   * avoids by reading the capture rather than the purchase unit.
   */
  return markOrderPaid({
    orderId: String(order._id),
    provider: 'stripe',
    intentId: intent.id,
    captureId: intent.latest_charge,
    amountCaptured: { amount: intent.amount_received, currency: intent.currency.toUpperCase() },
    providerStatus: intent.status,
    by,
  });
}

async function reconcilePayPal(
  order: OrderDoc,
  paypalOrderId: string,
  by: string,
): Promise<MarkPaidResult | { outcome: 'nothing_to_do'; reason: string }> {
  const remote = await getPayPalOrder(paypalOrderId);

  /**
   * The same five checks the capture path runs, against the same function.
   *
   * There is deliberately no relaxed variant here. A reconcile is not a more trusted
   * context than a capture — if anything it is less, because it can be triggered by a
   * shopper landing on a URL — so it gets the identical verification.
   */
  const verified = verifyCapture(remote, {
    orderId: String(order._id),
    amount: order.totals.grandTotal,
  });

  if (!verified.ok) {
    logger.warn(
      { orderId: String(order._id), orderNumber: order.orderNumber, reason: verified.reason },
      'reconcile: paypal order did not verify',
    );
    return { outcome: 'nothing_to_do', reason: verified.reason };
  }

  return markOrderPaid({
    orderId: String(order._id),
    provider: 'paypal',
    intentId: remote.id,
    captureId: verified.captureId,
    amountCaptured: verified.amount,
    providerStatus: remote.status,
    by,
  });
}

/** Re-exported so the webhook handlers parse amounts the same way the capture path does. */
export { fromDecimalString };
