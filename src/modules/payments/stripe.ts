import { createHmac, timingSafeEqual } from 'node:crypto';
import { env, requireConfigured } from '../../config/env.js';
import { AppError, serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { Money } from '../../lib/money.js';

/**
 * Stripe, over HTTPS with `fetch`. No SDK.
 *
 * The precedent is ADR-007's mail transport: `googleapis` for one POST was a lot of
 * dependency tree for two HTTP calls. The same argument holds here — this file makes
 * exactly two API calls and verifies one signature — and the same caveat applies, which
 * is that **the signature verifier is security-critical and is therefore tested against
 * failure, not only against success.** See stripe.test.ts: tampered payload, wrong
 * secret, stale timestamp, missing scheme, and a real Stripe CLI signature captured
 * from a live run.
 *
 * Stripe's API is form-encoded, not JSON, which is the one thing that surprises people
 * writing this without an SDK. Nested parameters are bracketed: `metadata[orderId]`.
 */

const API = 'https://api.stripe.com/v1';

/** Stripe's documented tolerance. A replayed signature older than this is refused. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

function secretKey(): string {
  requireConfigured('Stripe checkout', ['STRIPE_SECRET_KEY']);
  return env.STRIPE_SECRET_KEY as string;
}

/**
 * Flattens `{ metadata: { orderId: 'x' } }` into `metadata[orderId]=x`.
 *
 * One level of nesting plus booleans is all this integration needs; anything deeper
 * would be a sign that an SDK had become the right answer after all.
 */
function formEncode(params: Record<string, unknown>, prefix = ''): URLSearchParams {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;

    if (Array.isArray(value)) {
      // Stripe indexes array parameters: `items[0][price]`. Joining with a comma — which
      // is what String(array) would do — silently produces one malformed parameter.
      (value as unknown[]).forEach((item, index) => {
        for (const [k, v] of formEncode({ [String(index)]: item }, name)) body.append(k, v);
      });
    } else if (typeof value === 'object') {
      for (const [k, v] of formEncode(value as Record<string, unknown>, name)) body.append(k, v);
    } else if (typeof value === 'string') {
      body.append(name, value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      body.append(name, String(value));
    } else {
      // A symbol, a function, a bigint. None of these is a Stripe parameter, and the
      // default stringification of each is either '[object Object]' or a throw — both of
      // which would reach Stripe as a request that looks valid and means nothing.
      throw new Error(`Cannot encode ${typeof value} as a Stripe parameter: ${name}`);
    }
  }

  return body;
}

async function call<T>(
  path: string,
  options: { method: 'GET' | 'POST'; body?: Record<string, unknown>; idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    // Pinning the API version means Stripe changing a default shape is a deliberate
    // upgrade here rather than a surprise in production.
    'Stripe-Version': '2024-06-20',
  };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: options.method,
      headers,
      body: options.body ? formEncode(options.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    // A network failure is ours, not the shopper's. 503 so the client may retry with
    // the same idempotency key and reach the same intent.
    throw serviceUnavailable('Could not reach Stripe.', cause);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string; type?: string };
  };

  if (!response.ok) {
    const message = payload.error?.message ?? `Stripe returned ${response.status}`;
    logger.error(
      { status: response.status, code: payload.error?.code, type: payload.error?.type },
      'stripe: api call failed',
    );
    // A 4xx from Stripe is a request we built wrong, which is our bug and not something
    // the shopper can fix by trying again.
    throw new AppError(response.status >= 500 ? 503 : 502, 'PAYMENT_FAILED', message, {
      expected: false,
      cause: payload.error,
    });
  }

  return payload as T;
}

export type StripePaymentIntent = {
  id: string;
  status: string;
  amount: number;
  amount_received: number;
  currency: string;
  client_secret: string | null;
  latest_charge: string | null;
  metadata?: Record<string, string>;
};

/**
 * Creates the PaymentIntent for an order.
 *
 * **Called outside the checkout transaction, never inside it.** A transaction held open
 * across a third-party HTTP call holds its locks for as long as Stripe takes to answer,
 * and a Stripe timeout becomes a MongoDB transaction timeout, which surfaces as a write
 * conflict somewhere unrelated.
 *
 * The idempotency key is **deterministic — `pi:{orderId}`** — which is what makes the
 * retry safe: a request that timed out after Stripe had already created the intent
 * returns *that same intent* rather than creating a second one for the same order. Left
 * to a random key, a flaky connection produces two intents for one order and the
 * partial unique index on `payment.intentId` then refuses the second, correctly but
 * after the customer has already been charged.
 */
export async function createPaymentIntent(input: {
  orderId: string;
  orderNumber: string;
  amount: Money;
  email: string;
}): Promise<StripePaymentIntent> {
  return call<StripePaymentIntent>('/payment_intents', {
    method: 'POST',
    idempotencyKey: `pi:${input.orderId}`,
    body: {
      amount: input.amount.amount,
      currency: input.amount.currency.toLowerCase(),
      // Lets Stripe offer whatever the account has enabled, rather than hardcoding
      // 'card' and silently excluding the wallets that are most of mobile checkout.
      automatic_payment_methods: { enabled: true },
      receipt_email: input.email,
      description: `Hæstore ${input.orderNumber}`,
      // The webhook resolves the order from here. It is a cross-check, not the source
      // of truth: the handler looks the order up by intent id and only uses metadata to
      // detect a mismatch worth logging.
      metadata: { orderId: input.orderId, orderNumber: input.orderNumber },
    },
  });
}

/**
 * Reads an intent back from Stripe.
 *
 * This is the return page's path, and it is what lets the demo run **with no webhook
 * delivered at all**: the browser comes back from the payment step, the server asks
 * Stripe what actually happened, and the answer funnels into the same `markOrderPaid`
 * the webhook would have called. Two deliveries of one idempotent operation.
 */
export async function retrievePaymentIntent(intentId: string): Promise<StripePaymentIntent> {
  return call<StripePaymentIntent>(`/payment_intents/${encodeURIComponent(intentId)}`, {
    method: 'GET',
  });
}

export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

/**
 * Verifies a webhook signature against the **raw request bytes**.
 *
 * The header looks like `t=1700000000,v1=<hex>,v1=<hex>`, and the signed payload is
 * `${t}.${rawBody}` — so a body that has been through `express.json()` and back out via
 * `JSON.stringify` will not verify, because key order and whitespace are not preserved.
 * That is why the webhook route mounts above the JSON parser in app.ts, with a comment
 * saying so that has been there since Phase 0.
 *
 * Three things here are deliberate:
 *
 * - **Every `v1` is checked, not just the first.** Stripe sends more than one while a
 *   signing secret is being rotated, and verifying only the first breaks the rollover
 *   in a way that looks like a bad secret.
 * - **The comparison is `timingSafeEqual`.** The digests are the same length by
 *   construction, so the length check below is about malformed input, not about timing.
 * - **The timestamp tolerance is enforced.** Without it a signature stays valid
 *   forever, and an attacker who ever captures one body can replay it indefinitely.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  options: { secret?: string; toleranceSeconds?: number; nowMs?: number } = {},
): StripeEvent {
  const secret = options.secret ?? env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'STRIPE_WEBHOOK_SECRET is not configured.', {
      expected: false,
    });
  }
  if (!signatureHeader) throw badSignature('missing Stripe-Signature header');

  const parts = new Map<string, string[]>();
  for (const segment of signatureHeader.split(',')) {
    const index = segment.indexOf('=');
    if (index === -1) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    parts.set(key, [...(parts.get(key) ?? []), value]);
  }

  const timestamp = parts.get('t')?.[0];
  const signatures = parts.get('v1') ?? [];
  if (!timestamp || signatures.length === 0)
    throw badSignature('malformed Stripe-Signature header');

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) throw badSignature('non-numeric timestamp');

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    throw badSignature('timestamp outside the tolerance window');
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest();

  const matched = signatures.some((candidate) => {
    let provided: Buffer;
    try {
      provided = Buffer.from(candidate, 'hex');
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });

  if (!matched) throw badSignature('no signature matched');

  try {
    return JSON.parse(body.toString('utf8')) as StripeEvent;
  } catch (cause) {
    throw badSignature('body is not JSON', cause);
  }
}

/**
 * 400, always, and the message never says which check failed.
 *
 * Stripe treats any non-2xx as a delivery to retry, which is correct — but a verifier
 * that reported *why* it refused would be an oracle for anyone probing the endpoint.
 */
function badSignature(reason: string, cause?: unknown): AppError {
  logger.warn({ reason }, 'stripe: webhook signature rejected');
  return new AppError(400, 'BAD_REQUEST', 'Invalid signature.', { cause });
}
