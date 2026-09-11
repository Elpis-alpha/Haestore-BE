import { Router, type Request, type Response } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { Order } from '../order/order.model.js';
import { cancelOrder, markOrderPaid } from '../order/order.service.js';
import { fromDecimalString } from './money-decimal.js';
import { isDuplicateKeyError, PaymentEvent } from './payment-event.model.js';
import { verifyWebhookSignature as verifyPayPal } from './paypal.js';
import { verifyWebhookSignature as verifyStripe, type StripeEvent } from './stripe.js';

export const webhooksRouter: Router = Router();

/**
 * Payment webhooks.
 *
 * **This router mounts above `express.json()`** — see the comment in app.ts that has
 * been marking the spot since Phase 0. Stripe signs the exact request bytes, and a JSON
 * parser that has already consumed and re-serialised the body invalidates every
 * signature. The resulting 400s look like a credentials problem rather than a parsing
 * one, which is why the note was written before there was anything to mount.
 *
 * Two rules govern every handler here:
 *
 * **Answer 200 for anything that is not a signature failure.** A non-2xx tells the
 * provider to redeliver, and redelivering an event we have already applied — or one we
 * deliberately ignore — achieves nothing except more of the same. The only thing worth
 * a retry is a genuine outage on our side.
 *
 * **Nothing here is the source of truth.** Every handler funnels into `markOrderPaid`,
 * which is also what the return page's reconcile calls. A webhook is one delivery of an
 * idempotent operation, not a privileged path.
 */

/**
 * Records the event, and reports whether we have seen it before.
 *
 * The insert *is* the check: a duplicate-key error on `{provider, eventId}` is the
 * answer. `exists()` followed by `create()` would let two concurrent redeliveries — and
 * redeliveries arrive in bursts — both pass before either insert lands.
 */
async function recordEvent(
  provider: 'stripe' | 'paypal',
  eventId: string,
  type: string,
): Promise<boolean> {
  try {
    await PaymentEvent.create({ provider, eventId, type, outcome: 'applied' });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      logger.info({ provider, eventId, type }, 'webhook: duplicate delivery ignored');
      return false;
    }
    throw err;
  }
}

async function annotate(
  provider: 'stripe' | 'paypal',
  eventId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await PaymentEvent.updateOne({ provider, eventId }, { $set: patch }).catch(() => undefined);
}

/**
 * Stripe.
 *
 * `express.raw` rather than `express.json`, so `req.body` is the Buffer Stripe signed.
 */
webhooksRouter.post(
  '/stripe',
  (req, res, next) => {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      // Configured off. Refusing beats accepting an unverifiable event, and 503 tells
      // Stripe to try again later rather than to give up on the endpoint.
      logger.error('webhook: STRIPE_WEBHOOK_SECRET is not set, refusing the delivery');
      res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Not configured.' } });
      return;
    }
    next();
  },
  async (req: Request, res: Response) => {
    let event: StripeEvent;
    try {
      event = verifyStripe(req.body as Buffer, req.get('stripe-signature'));
    } catch {
      // The one case that is *not* 200. An unsigned or mis-signed body is either an
      // attacker or a misconfiguration, and neither should be acknowledged as accepted.
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid signature.' } });
      return;
    }

    const first = await recordEvent('stripe', event.id, event.type);
    if (!first) {
      res.json({ received: true, duplicate: true });
      return;
    }

    try {
      await handleStripeEvent(event);
    } catch (err) {
      // Logged loudly and still acknowledged. A redelivery would hit the same bug, and
      // the order is recoverable through the reconcile path either way.
      logger.error(
        { err: (err as Error).message, eventId: event.id, type: event.type },
        'webhook: stripe handler threw',
      );
      await annotate('stripe', event.id, { outcome: 'failed', note: (err as Error).message });
    }

    res.json({ received: true });
  },
);

async function handleStripeEvent(event: StripeEvent): Promise<void> {
  const object = event.data.object as {
    id?: string;
    amount_received?: number;
    currency?: string;
    status?: string;
    latest_charge?: string | null;
    metadata?: Record<string, string>;
  };

  if (event.type === 'payment_intent.succeeded') {
    const order = await Order.findOne({ 'payment.intentId': object.id });
    if (!order) {
      logger.warn({ intentId: object.id }, 'webhook: no order for this payment intent');
      await annotate('stripe', event.id, { outcome: 'ignored', note: 'no matching order' });
      return;
    }

    /**
     * The metadata is a cross-check, never the lookup. The order was found by the intent
     * id this server stored; if the metadata disagrees, something has gone wrong that is
     * worth knowing about, but the *lookup* must not be steerable by a field that
     * travelled through the provider.
     */
    if (object.metadata?.orderId && object.metadata.orderId !== String(order._id)) {
      logger.error(
        {
          intentId: object.id,
          metadataOrderId: object.metadata.orderId,
          orderId: String(order._id),
        },
        'webhook: payment intent metadata names a different order',
      );
    }

    const result = await markOrderPaid({
      orderId: String(order._id),
      provider: 'stripe',
      intentId: String(object.id),
      captureId: object.latest_charge ?? null,
      amountCaptured: {
        amount: object.amount_received ?? 0,
        currency: (object.currency ?? order.currency).toUpperCase(),
      },
      providerStatus: object.status ?? 'succeeded',
      by: 'webhook',
    });

    await annotate('stripe', event.id, {
      order: order._id,
      outcome:
        result.outcome === 'paid'
          ? 'applied'
          : result.outcome === 'already_settled'
            ? 'duplicate'
            : 'failed',
      note: result.outcome,
    });
    return;
  }

  if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
    const order = await Order.findOne({ 'payment.intentId': object.id, status: 'pending_payment' });
    if (!order) {
      await annotate('stripe', event.id, { outcome: 'ignored', note: 'no pending order' });
      return;
    }

    /**
     * A failed payment is **not** a cancellation. The shopper can try another card on
     * the same intent, and canceling here would release their stock mid-attempt and
     * hand it to somebody else. The reservation's expiry is what ends an abandoned
     * checkout, on a timer long enough to retry within.
     */
    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          'payment.providerStatus': object.status ?? event.type,
          'payment.lastError': event.type,
        },
      },
    );
    await annotate('stripe', event.id, {
      order: order._id,
      outcome: 'applied',
      note: 'recorded, order left pending',
    });
    return;
  }

  await annotate('stripe', event.id, { outcome: 'ignored', note: 'event type not handled' });
}

/**
 * PayPal.
 *
 * Verification is a call back to PayPal rather than a local HMAC (see paypal.ts), and it
 * needs `PAYPAL_WEBHOOK_ID`. Without that there is no way to verify, so this refuses
 * rather than trusting — and the demo does not depend on it, because the return page
 * reconciles through the same `markOrderPaid`.
 *
 * The raw body is still used, because PayPal's verification API wants the event exactly
 * as delivered.
 */
webhooksRouter.post('/paypal', async (req: Request, res: Response) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);

  if (!env.PAYPAL_WEBHOOK_ID) {
    logger.error('webhook: PAYPAL_WEBHOOK_ID is not set, refusing the delivery');
    res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Not configured.' } });
    return;
  }

  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }

  const verified = await verifyPayPal({ headers, rawBody: raw });
  if (!verified) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid signature.' } });
    return;
  }

  let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid body.' } });
    return;
  }

  if (!event.id || !event.event_type) {
    res.json({ received: true, ignored: true });
    return;
  }

  const first = await recordEvent('paypal', event.id, event.event_type);
  if (!first) {
    res.json({ received: true, duplicate: true });
    return;
  }

  try {
    await handlePayPalEvent(event as Required<typeof event>);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, eventId: event.id, type: event.event_type },
      'webhook: paypal handler threw',
    );
    await annotate('paypal', event.id, { outcome: 'failed', note: (err as Error).message });
  }

  res.json({ received: true });
});

async function handlePayPalEvent(event: {
  id: string;
  event_type: string;
  resource: Record<string, unknown>;
}): Promise<void> {
  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const resource = event.resource as {
      id?: string;
      custom_id?: string;
      status?: string;
      amount?: { currency_code?: string; value?: string };
    };

    /**
     * `custom_id` carries our order id, and here it *is* the lookup — a PayPal capture
     * webhook does not carry the order id we stored. That makes this the one place a
     * provider-supplied field steers a lookup, which is why the amount is still verified
     * against the order that comes back: naming an order is not the same as being owed
     * one, and `markOrderPaid` refuses any amount that is not exactly ours.
     */
    if (!resource.custom_id) {
      await annotate('paypal', event.id, { outcome: 'ignored', note: 'no custom_id' });
      return;
    }

    const order = await Order.findById(resource.custom_id).catch(() => null);
    if (!order) {
      await annotate('paypal', event.id, { outcome: 'ignored', note: 'no matching order' });
      return;
    }

    if (
      resource.status !== 'COMPLETED' ||
      !resource.amount?.value ||
      !resource.amount.currency_code
    ) {
      await annotate('paypal', event.id, {
        order: order._id,
        outcome: 'ignored',
        note: `capture status ${String(resource.status)}`,
      });
      return;
    }

    let amountCaptured;
    try {
      amountCaptured = fromDecimalString(resource.amount.value, resource.amount.currency_code);
    } catch (err) {
      await annotate('paypal', event.id, {
        order: order._id,
        outcome: 'failed',
        note: (err as Error).message,
      });
      return;
    }

    const result = await markOrderPaid({
      orderId: String(order._id),
      provider: 'paypal',
      intentId: order.payment.intentId ?? String(resource.id),
      captureId: resource.id ?? null,
      amountCaptured,
      providerStatus: resource.status,
      by: 'webhook',
    });

    await annotate('paypal', event.id, {
      order: order._id,
      outcome:
        result.outcome === 'paid'
          ? 'applied'
          : result.outcome === 'already_settled'
            ? 'duplicate'
            : 'failed',
      note: result.outcome,
    });
    return;
  }

  if (
    event.event_type === 'PAYMENT.CAPTURE.DENIED' ||
    event.event_type === 'CHECKOUT.ORDER.VOIDED'
  ) {
    const customId = (event.resource as { custom_id?: string }).custom_id;
    if (!customId) {
      await annotate('paypal', event.id, { outcome: 'ignored', note: 'no custom_id' });
      return;
    }
    const order = await Order.findById(customId).catch(() => null);
    if (!order || order.status !== 'pending_payment') {
      await annotate('paypal', event.id, { outcome: 'ignored', note: 'no pending order' });
      return;
    }

    // A denied PayPal capture, unlike a failed card, is the end of that attempt — the
    // approval is spent. Canceling returns the stock rather than holding it to expiry.
    await cancelOrder(order._id, 'webhook', `paypal ${event.event_type}`);
    await annotate('paypal', event.id, { order: order._id, outcome: 'applied', note: 'canceled' });
    return;
  }

  await annotate('paypal', event.id, { outcome: 'ignored', note: 'event type not handled' });
}
