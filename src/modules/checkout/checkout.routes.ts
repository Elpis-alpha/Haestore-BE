import { Router, type Request, type Response } from 'express';
import { env } from '../../config/env.js';
import { body, validateBody } from '../../middleware/validate.js';
import { conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { guestKeyHash, readGuestCookie, setBagCount } from '../cart/guest-cookie.js';
import type { CartOwner } from '../cart/cart.service.js';
import { Order } from '../order/order.model.js';
import { markOrderPaid } from '../order/order.service.js';
import { capturePayPalOrder, createPayPalOrder, verifyCapture } from '../payments/paypal.js';
import { reconcileOrderWithProvider } from '../payments/reconcile.js';
import { createPaymentIntent } from '../payments/stripe.js';
import {
  capturePayPalSchema,
  createCheckoutSchema,
  reconcileSchema,
  type CapturePayPalInput,
  type CreateCheckoutInput,
  type ReconcileInput,
} from './checkout.schema.js';
import { assertPayable, createOrderFromCart } from './checkout.service.js';
import { idempotent } from './idempotency.js';
import { toOrderResponse } from '../order/order.presenter.js';
import { claimTokenMatches, normaliseOrderNumber } from '../order/order-number.js';

export const checkoutRouter: Router = Router();

/**
 * Checkout.
 *
 * Works signed in or signed out — guest checkout is a first-class path, and the order
 * is attached to an account later if one is ever created for that address
 * (`claimGuestOrders`). `attachSession` has already decided who is calling; the absence
 * of a session means "guest", not "denied".
 *
 * **Every POST here carries an `Idempotency-Key`.** See idempotency.ts for why that is
 * the outermost of the three guards rather than the innermost.
 */

function ownerOf(req: Request): CartOwner | null {
  if (req.auth) return { userId: req.auth.userId };
  const token = readGuestCookie(req);
  return token ? { guestKey: guestKeyHash(token) } : null;
}

/**
 * Whether this caller may see this order.
 *
 * Three ways in, in descending order of strength: it is your account's order; you hold
 * the claim token that was emailed to you; or you are an admin. A bare order number
 * authorises nothing, which is what lets the number be printed on a packing slip.
 */
function mayRead(req: Request, order: { user?: { toString(): string } | null }): boolean {
  if (req.auth && order.user && order.user.toString() === req.auth.userId) return true;
  if (req.auth?.roles.includes('admin')) return true;
  return false;
}

/**
 * Creates the order, then the payment.
 *
 * **The split between these two steps is the most load-bearing thing on this route.**
 * `createOrderFromCart` re-prices, reserves stock and inserts the order inside one
 * transaction. The provider call happens *after* that transaction has committed,
 * because a transaction held open across a third-party HTTP call holds its locks for as
 * long as the provider takes to answer — and a Stripe timeout then surfaces as a
 * MongoDB write conflict somewhere unrelated, which is a genuinely horrible thing to
 * debug.
 *
 * The cost of splitting is a window where an order exists with no payment attached. That
 * is deliberate and cheap: such an order is `pending_payment` holding a reservation that
 * the sweeper reclaims. The alternative failure — a payment with no order — is the one
 * that cannot be swept, because nothing points at it.
 */
checkoutRouter.post(
  '/session',
  idempotent('POST /api/checkout/session'),
  validateBody(createCheckoutSchema),
  async (req: Request, res: Response) => {
    const owner = ownerOf(req);
    if (!owner) throw notFound('There is no bag to check out.');

    const input = body<CreateCheckoutInput>(req);
    const { order, claimToken } = await createOrderFromCart(owner, input);

    // The bag is retired, so the header's readable badge must stop showing its count.
    setBagCount(res, 0);

    if (input.provider === 'stripe') {
      const intent = await createPaymentIntent({
        orderId: String(order._id),
        orderNumber: order.orderNumber,
        amount: order.totals.grandTotal,
        email: order.email,
      });

      await Order.updateOne(
        { _id: order._id },
        { $set: { 'payment.intentId': intent.id, 'payment.providerStatus': intent.status } },
      );

      res.status(201).json({
        data: {
          order: toOrderResponse(order, { claimToken }),
          /**
           * The client secret authorises confirming *this intent* from the browser, and
           * nothing else. It is not a credential for the order and cannot read or change
           * one — which is why it is safe to hand over here and why the amount it
           * confirms was fixed server-side before this response was written.
           */
          stripe: { clientSecret: intent.client_secret },
        },
      });
      return;
    }

    const paypal = await createPayPalOrder({
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      amount: order.totals.grandTotal,
      returnUrl: `${env.WEB_URL}/checkout/return?order=${order.orderNumber}`,
      cancelUrl: `${env.WEB_URL}/cart`,
    });

    await Order.updateOne(
      { _id: order._id },
      { $set: { 'payment.intentId': paypal.id, 'payment.providerStatus': paypal.status } },
    );

    res.status(201).json({
      data: {
        order: toOrderResponse(order, { claimToken }),
        paypal: { orderId: paypal.id },
      },
    });
  },
);

/**
 * Captures a PayPal order, server-side.
 *
 * The client sends only the PayPal order id. It sends no amount, no status and no payer
 * details, because none of those would be evidence — this is the exact route whose 2022
 * ancestor accepted a payment blob from the browser and filed it as paid.
 *
 * Everything that decides the outcome comes from PayPal's response to *our* call, and
 * all five checks must pass. A failure records which one and leaves the order unpaid.
 */
checkoutRouter.post(
  '/paypal/capture',
  idempotent('POST /api/checkout/paypal/capture'),
  validateBody(capturePayPalSchema),
  async (req: Request, res: Response) => {
    const { paypalOrderId } = body<CapturePayPalInput>(req);

    /**
     * The order is found **by the PayPal order id we stored**, not by an id the client
     * names. A client that could name the order could present a cheap order's capture
     * against an expensive one; here the only orders reachable are ones this server
     * already associated with that PayPal order.
     */
    const order = await Order.findOne({
      'payment.intentId': paypalOrderId,
      'payment.provider': 'paypal',
    });
    if (!order) throw notFound('That payment does not belong to an order.');

    assertPayable(order);

    const captured = await capturePayPalOrder(paypalOrderId, String(order._id));
    const verified = verifyCapture(captured, {
      orderId: String(order._id),
      amount: order.totals.grandTotal,
    });

    if (!verified.ok) {
      logger.error(
        { orderId: String(order._id), orderNumber: order.orderNumber, reason: verified.reason },
        'checkout: paypal capture failed verification',
      );
      await Order.updateOne(
        { _id: order._id },
        {
          $set: { 'payment.lastError': verified.reason, 'payment.providerStatus': captured.status },
        },
      );
      // The reason is logged, never returned: a caller probing this endpoint must not be
      // told which of the five checks it tripped.
      throw conflict('That payment could not be verified.');
    }

    const result = await markOrderPaid({
      orderId: String(order._id),
      provider: 'paypal',
      intentId: captured.id,
      captureId: verified.captureId,
      amountCaptured: verified.amount,
      providerStatus: captured.status,
      by: 'capture',
    });

    if (result.outcome === 'not_found') throw notFound('Order not found.');
    if (result.outcome === 'amount_mismatch') throw conflict('That payment could not be verified.');

    res.json({ data: { order: toOrderResponse(result.order) } });
  },
);

/**
 * The return page's reconcile.
 *
 * **This is the path the demo runs on, and it is exercised with webhooks disabled on
 * purpose.** The shopper comes back from the payment step, this asks the provider what
 * happened, and the answer goes through the same `markOrderPaid` a webhook would have
 * called. If the webhook has already arrived, this finds the order settled and says so.
 *
 * Deliberately not idempotency-keyed: it is safe to call any number of times by
 * construction, and requiring a key on the page a shopper might refresh would produce a
 * 409 on a refresh, which is the opposite of helpful.
 */
checkoutRouter.post(
  '/reconcile',
  validateBody(reconcileSchema),
  async (req: Request, res: Response) => {
    const { orderNumber, claimToken } = body<ReconcileInput>(req);

    const order = await Order.findOne({ orderNumber });
    if (!order) throw notFound('Order not found.');

    const authorised =
      mayRead(req, order) || (!!claimToken && claimTokenMatches(claimToken, order.claimTokenHash));
    if (!authorised) throw notFound('Order not found.');

    const result = await reconcileOrderWithProvider(order);

    // Whatever the reconcile decided, the caller gets the order as it now stands —
    // which is the only thing the return page actually needs in order to render.
    const current = await Order.findById(order._id);
    res.json({
      data: {
        order: toOrderResponse(current!),
        reconciled: result.outcome === 'paid',
      },
    });
  },
);

/**
 * Reads one order.
 *
 * Mounted here rather than on the order router because the return page reaches it with
 * a claim token rather than a session, and that is a checkout concern.
 */
checkoutRouter.get('/order/:orderNumber', async (req: Request, res: Response) => {
  const orderNumber = normaliseOrderNumber(String(req.params.orderNumber));
  const order = await Order.findOne({ orderNumber });
  if (!order) throw notFound('Order not found.');

  const token = typeof req.query.t === 'string' ? req.query.t : null;
  const authorised =
    mayRead(req, order) || (token !== null && claimTokenMatches(token, order.claimTokenHash));

  // 404 rather than 403, so a bare order number cannot be used to discover which
  // numbers exist. Same reasoning as the admin routes in Phase 2.
  if (!authorised) throw notFound('Order not found.');

  res.json({ data: { order: toOrderResponse(order) } });
});
