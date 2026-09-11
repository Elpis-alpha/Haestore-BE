import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './stripe.js';

/**
 * The webhook signature verifier is the boundary between "Stripe told us this order was
 * paid" and "somebody told us this order was paid". It is hand-written rather than
 * taken from the SDK (see the file header), so it is tested against every way it could
 * wrongly accept — not merely against the happy path.
 *
 * The fixture body is a real delivery captured from the Stripe CLI; the implementation
 * was checked against Stripe's own signature over those bytes at capture time. See
 * __fixtures__/stripe-webhook.json.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/stripe-webhook.json', import.meta.url), 'utf8'),
) as {
  secret: string;
  signature: string;
  rawBodyBase64: string;
  timestampSeconds: number;
};

const rawBody = Buffer.from(fixture.rawBodyBase64, 'base64');
const nowMs = fixture.timestampSeconds * 1000;
const opts = { secret: fixture.secret, nowMs };

/** Signs arbitrary bytes the way Stripe does, for the cases the fixture cannot cover. */
function sign(
  body: Buffer | string,
  secret = fixture.secret,
  timestamp = fixture.timestampSeconds,
) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const digest = createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

describe('a genuine delivery', () => {
  it('verifies and returns the parsed event', () => {
    const event = verifyWebhookSignature(rawBody, fixture.signature, opts);
    expect(event.id).toMatch(/^evt_/);
    expect(event.type).toBeTypeOf('string');
    expect(event.data.object).toBeTypeOf('object');
  });

  it('accepts a string body identically to a Buffer', () => {
    const asString = rawBody.toString('utf8');
    expect(verifyWebhookSignature(asString, fixture.signature, opts).id).toBe(
      verifyWebhookSignature(rawBody, fixture.signature, opts).id,
    );
  });

  /**
   * Stripe sends several v1 signatures while a signing secret is being rotated. The
   * fixture's header carries two, and only the *second* matches our secret — so a
   * verifier that checked just the first would break every rollover, and the symptom
   * would look like a wrong secret rather than like a parsing bug.
   */
  it('matches a v1 that is not the first one in the header', () => {
    expect(fixture.signature.match(/v1=/g)).toHaveLength(2);
    expect(() => verifyWebhookSignature(rawBody, fixture.signature, opts)).not.toThrow();
  });

  /** The v0 scheme is a different algorithm. Reading it as a v1 would reject valid calls. */
  it('ignores the v0 signature', () => {
    expect(fixture.signature).toContain('v0=');
    expect(() => verifyWebhookSignature(rawBody, fixture.signature, opts)).not.toThrow();
  });
});

describe('refusals', () => {
  /** The one that matters: the body must be the bytes that were signed. */
  it('refuses a tampered body', () => {
    const tampered = Buffer.from(rawBody.toString('utf8').replace('"amount"', '"amonut"'), 'utf8');
    expect(() => verifyWebhookSignature(tampered, fixture.signature, opts)).toThrow(
      /invalid signature/i,
    );
  });

  /**
   * A re-serialised body is what you get if the webhook route is mounted below
   * express.json(). It is byte-different from what Stripe signed even though it is the
   * same JSON, which is why app.ts mounts the raw parser above the JSON one.
   */
  it('refuses a body that has been through JSON.parse and JSON.stringify', () => {
    const round = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString('utf8'))), 'utf8');
    expect(round.equals(rawBody)).toBe(false);
    expect(() => verifyWebhookSignature(round, fixture.signature, opts)).toThrow();
  });

  it('refuses a signature made with a different secret', () => {
    const header = sign(rawBody, 'whsec_some_other_secret_entirely_0000000000000000');
    expect(() => verifyWebhookSignature(rawBody, header, opts)).toThrow();
  });

  it('refuses a timestamp outside the tolerance window', () => {
    // Six minutes late, against Stripe's documented five-minute tolerance.
    expect(() =>
      verifyWebhookSignature(rawBody, fixture.signature, { ...opts, nowMs: nowMs + 360_000 }),
    ).toThrow();
  });

  it('refuses a timestamp too far in the future', () => {
    expect(() =>
      verifyWebhookSignature(rawBody, fixture.signature, { ...opts, nowMs: nowMs - 360_000 }),
    ).toThrow();
  });

  it('accepts one just inside the window, so the boundary is not off by an order', () => {
    expect(() =>
      verifyWebhookSignature(rawBody, fixture.signature, { ...opts, nowMs: nowMs + 299_000 }),
    ).not.toThrow();
  });

  /**
   * The signed payload is `${t}.${body}`, so moving the timestamp must invalidate the
   * digest. If this passed, `t` would be decorative and every capture replayable.
   */
  it('refuses a header whose timestamp was edited to look fresh', () => {
    const moved = fixture.signature.replace(
      `t=${fixture.timestampSeconds}`,
      `t=${fixture.timestampSeconds + 60}`,
    );
    expect(() =>
      verifyWebhookSignature(rawBody, moved, { ...opts, nowMs: nowMs + 60_000 }),
    ).toThrow();
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no timestamp', 'v1=abc'],
    ['no v1', 't=1700000000'],
    ['garbage', 'not-a-signature-header'],
    ['non-numeric timestamp', 't=yesterday,v1=abc'],
    ['v1 that is not hex', 't=1789108067,v1=zzzz'],
    ['empty v1', 't=1789108067,v1='],
  ])('refuses a %s header', (_label, header) => {
    expect(() => verifyWebhookSignature(rawBody, header, opts)).toThrow();
  });

  it('refuses a correctly signed body that is not JSON', () => {
    const body = Buffer.from('this is signed, and is still not an event', 'utf8');
    expect(() => verifyWebhookSignature(body, sign(body), opts)).toThrow();
  });

  /** Never say which check failed — the endpoint is public and would be an oracle. */
  it('says the same thing however it refused', () => {
    const messages = new Set<string>();
    const attempts: [Buffer, string | undefined][] = [
      [rawBody, 't=1789108067,v1=deadbeef'],
      [rawBody, undefined],
      [rawBody, 'garbage'],
      [Buffer.from('tampered'), fixture.signature],
    ];
    for (const [body, header] of attempts) {
      try {
        verifyWebhookSignature(body, header, opts);
      } catch (err) {
        messages.add((err as Error).message);
      }
    }
    expect(messages.size).toBe(1);
    expect([...messages][0]).toBe('Invalid signature.');
  });

  it('refuses when no signing secret is configured', () => {
    expect(() => verifyWebhookSignature(rawBody, fixture.signature, { secret: '', nowMs })).toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });
});
