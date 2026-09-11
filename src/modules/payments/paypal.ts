import { env, requireConfigured } from '../../config/env.js';
import { AppError, serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { Money } from '../../lib/money.js';
import { fromDecimalString, isExactAmount, toDecimalString } from './money-decimal.js';

/**
 * PayPal — the direct repair of the 2022 app's worst defect.
 *
 * The old `POST /api/order/add-paypal` took a payment blob from the browser and stored
 * it. It never contacted PayPal. Any authenticated user could `curl` themselves a
 * completed order for anything in the shop, for free, and the server would file it as
 * paid. Nothing in that flow was a bug in the ordinary sense — every line did what it
 * said; the design simply trusted the client to report its own payment.
 *
 * So the rule this file exists to enforce: **the browser's word is never evidence.** The
 * client tells us only an order id. Everything else — that it completed, that it is
 * *our* order, in the right currency, for the exact amount, and that the capture itself
 * completed — is read out of PayPal's own response to our own server-to-server call.
 * All five, or the order is not marked paid. See `verifyCapture`.
 */

const HOSTS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

function host(): string {
  return HOSTS[env.PAYPAL_ENV];
}

function credentials(): { id: string; secret: string } {
  requireConfigured('PayPal checkout', ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET']);
  return { id: env.PAYPAL_CLIENT_ID as string, secret: env.PAYPAL_CLIENT_SECRET as string };
}

/**
 * The access token, cached in process.
 *
 * PayPal's tokens last nine hours and minting one is a round trip, so fetching a fresh
 * token per call would double the latency of every checkout. Cached with a 60-second
 * safety margin, so a token is never used in the window where it might expire mid-flight
 * — an expiry race presents as a sporadic 401 on capture, which is precisely the moment
 * it is most expensive to debug.
 *
 * Process-local rather than in Redis on purpose: it is cheap to re-mint per process, and
 * a shared cache would put a bearer token for the merchant account into a store whose
 * stated contract (ARCHITECTURE.md) is that it must be safe to flush and safe to lose.
 */
let cachedToken: { value: string; expiresAtMs: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAtMs > Date.now()) return cachedToken.value;

  const { id, secret } = credentials();
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');

  let response: Response;
  try {
    response = await fetch(`${host()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw serviceUnavailable('Could not reach PayPal.', cause);
  }

  if (!response.ok) {
    logger.error({ status: response.status }, 'paypal: could not obtain an access token');
    throw serviceUnavailable('PayPal authentication failed.');
  }

  const body = (await response.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: body.access_token,
    expiresAtMs: Date.now() + (body.expires_in - 60) * 1000,
  };
  return cachedToken.value;
}

/** Exported for tests and for an operator forcing a re-auth after rotating credentials. */
export function clearTokenCache(): void {
  cachedToken = null;
}

async function call<T>(
  path: string,
  options: { method: 'GET' | 'POST'; body?: unknown; requestId?: string },
): Promise<T> {
  const token = await accessToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  // PayPal's own idempotency header. On capture it is what makes a retried request
  // return the original capture instead of taking the money twice.
  if (options.requestId) headers['PayPal-Request-Id'] = options.requestId;

  let response: Response;
  try {
    response = await fetch(`${host()}${path}`, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    throw serviceUnavailable('Could not reach PayPal.', cause);
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    logger.error(
      { status: response.status, path, name: payload.name, details: payload.details },
      'paypal: api call failed',
    );
    throw new AppError(
      response.status >= 500 ? 503 : 502,
      'PAYMENT_FAILED',
      'PayPal refused the request.',
      {
        expected: false,
        cause: payload,
      },
    );
  }

  return payload as T;
}

export type PayPalOrder = {
  id: string;
  status: string;
  purchase_units?: {
    custom_id?: string;
    invoice_id?: string;
    amount?: { currency_code?: string; value?: string };
    payments?: {
      captures?: {
        id: string;
        status: string;
        amount?: { currency_code?: string; value?: string };
      }[];
    };
  }[];
};

/**
 * Creates the PayPal order, server-side.
 *
 * `custom_id` carries **our** order id and is the thread the verification pulls on: it
 * is echoed back in the capture response, so a capture that does not name our order is
 * refused. `invoice_id` carries the order number and is PayPal's own duplicate guard —
 * PayPal refuses a second order with an invoice id it has already captured, which stops
 * a double payment one layer before our own checks.
 */
export async function createPayPalOrder(input: {
  orderId: string;
  orderNumber: string;
  amount: Money;
  returnUrl: string;
  cancelUrl: string;
}): Promise<PayPalOrder> {
  return call<PayPalOrder>('/v2/checkout/orders', {
    method: 'POST',
    requestId: `order:${input.orderId}`,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: input.orderNumber,
          custom_id: input.orderId,
          invoice_id: input.orderNumber,
          amount: {
            currency_code: input.amount.currency.toUpperCase(),
            value: toDecimalString(input.amount),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Hæstore',
            user_action: 'PAY_NOW',
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
          },
        },
      },
    },
  });
}

/** Captures an approved order. `PayPal-Request-Id` makes a retry return the same capture. */
export async function capturePayPalOrder(
  paypalOrderId: string,
  ourOrderId: string,
): Promise<PayPalOrder> {
  return call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
    method: 'POST',
    requestId: `capture:${ourOrderId}`,
    body: {},
  });
}

/** Reads an order back. The reconcile path's question: what actually happened here? */
export async function getPayPalOrder(paypalOrderId: string): Promise<PayPalOrder> {
  return call<PayPalOrder>(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
    method: 'GET',
  });
}

export type CaptureVerification =
  { ok: true; captureId: string; amount: Money } | { ok: false; reason: string };

/**
 * **The five checks.** All of them, from PayPal's own response, or it is not paid.
 *
 * This function is deliberately pure and takes the response as data, so every branch is
 * unit-testable without a network — including the ones that should never happen, which
 * are exactly the ones that went unwritten in 2022.
 *
 * It reports *which* check failed, because an operator looking at a refused payment
 * needs to distinguish "the customer's card was declined" from "someone is posting us
 * other people's order ids". The reason is logged and stored on the order; it is never
 * returned to the client, for the same reason the signature verifier is silent.
 */
export function verifyCapture(
  response: PayPalOrder,
  expected: { orderId: string; amount: Money },
): CaptureVerification {
  // 1. The order itself completed.
  if (response.status !== 'COMPLETED') {
    return { ok: false, reason: `order status is ${response.status}, expected COMPLETED` };
  }

  const unit = response.purchase_units?.[0];
  if (!unit) return { ok: false, reason: 'no purchase unit in the response' };

  // 2. It is our order. Without this, a capture for somebody else's PayPal order — or
  //    one manufactured in a sandbox — could be presented against our order id.
  if (unit.custom_id !== expected.orderId) {
    return {
      ok: false,
      reason: `custom_id ${String(unit.custom_id)} does not match order ${expected.orderId}`,
    };
  }

  const capture = unit.payments?.captures?.[0];
  if (!capture) return { ok: false, reason: 'no capture in the response' };

  // 3. The capture itself completed. An order can be COMPLETED with a capture that is
  //    PENDING or DECLINED, and treating that as paid ships goods against money that
  //    has not moved.
  if (capture.status !== 'COMPLETED') {
    return { ok: false, reason: `capture status is ${capture.status}, expected COMPLETED` };
  }

  const captured = capture.amount;
  if (!captured?.value || !captured.currency_code) {
    return { ok: false, reason: 'capture carries no amount' };
  }

  // 4 & 5. The right money, in the right currency, to the minor unit. Parsed strictly:
  //        a shape we do not recognise is a refusal, never a coerced number.
  let amount: Money;
  try {
    amount = fromDecimalString(captured.value, captured.currency_code);
  } catch (err) {
    return { ok: false, reason: `unparseable capture amount: ${(err as Error).message}` };
  }

  if (!isExactAmount(expected.amount, amount)) {
    return {
      ok: false,
      reason:
        `captured ${captured.value} ${captured.currency_code}, ` +
        `expected ${toDecimalString(expected.amount)} ${expected.amount.currency}`,
    };
  }

  return { ok: true, captureId: capture.id, amount };
}

/**
 * Verifies a webhook by asking PayPal.
 *
 * Unlike Stripe's local HMAC, PayPal signs with a certificate chain and expects the
 * signature to be checked by calling them back. That is a round trip per webhook, which
 * is not free — but the alternative is fetching and caching their signing certificate
 * and implementing the chain verification here, which is a great deal more code to get
 * subtly wrong on the one path where being wrong means accepting a forged payment.
 *
 * **Requires `PAYPAL_WEBHOOK_ID`**, which is issued when the webhook is registered in
 * the PayPal dashboard. Without it there is no way to verify, so the route refuses
 * rather than accepting unverified events — see webhooks.routes.ts. The demo does not
 * depend on this path: the return page reconciles through the same `markOrderPaid`.
 */
export async function verifyWebhookSignature(input: {
  headers: Record<string, string | undefined>;
  rawBody: string;
}): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) {
    logger.error('paypal: PAYPAL_WEBHOOK_ID is not set, cannot verify a webhook');
    return false;
  }

  const get = (name: string) => input.headers[name] ?? input.headers[name.toLowerCase()];

  const required = {
    auth_algo: get('paypal-auth-algo'),
    cert_url: get('paypal-cert-url'),
    transmission_id: get('paypal-transmission-id'),
    transmission_sig: get('paypal-transmission-sig'),
    transmission_time: get('paypal-transmission-time'),
  };

  if (Object.values(required).some((value) => !value)) {
    logger.warn(
      { present: Object.keys(required).filter((k) => required[k as keyof typeof required]) },
      'paypal: webhook is missing signature headers',
    );
    return false;
  }

  try {
    const result = await call<{ verification_status: string }>(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: {
          ...required,
          webhook_id: env.PAYPAL_WEBHOOK_ID,
          // The event must be sent as a parsed object, and PayPal re-serialises it on
          // their side to check the signature. This is why the PayPal webhook route,
          // unlike Stripe's, can tolerate a JSON round trip.
          webhook_event: JSON.parse(input.rawBody) as unknown,
        },
      },
    );
    return result.verification_status === 'SUCCESS';
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'paypal: webhook verification call failed');
    return false;
  }
}
