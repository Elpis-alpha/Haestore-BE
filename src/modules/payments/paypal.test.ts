import { describe, expect, it } from 'vitest';
import { verifyCapture, type PayPalOrder } from './paypal.js';

/**
 * The five checks, each tested by breaking it.
 *
 * The plan lists these as a named security regression: "PayPal capture rejects a
 * mismatched amount and a mismatched custom_id". The 2022 app performed none of them —
 * it stored whatever the browser posted — so each test here corresponds to a way that
 * app could be given a free order.
 */

const ORDER_ID = '65f000000000000000000001';
const expected = { orderId: ORDER_ID, amount: { amount: 7400, currency: 'USD' } };

/** A response that passes all five, which every case below then breaks one of. */
function goodResponse(): PayPalOrder {
  return {
    id: '5O190127TN364715T',
    status: 'COMPLETED',
    purchase_units: [
      {
        custom_id: ORDER_ID,
        invoice_id: 'HAE-8KDM2P4Q',
        amount: { currency_code: 'USD', value: '74.00' },
        payments: {
          captures: [
            {
              id: '3C679366HH908993F',
              status: 'COMPLETED',
              amount: { currency_code: 'USD', value: '74.00' },
            },
          ],
        },
      },
    ],
  };
}

describe('a genuine capture', () => {
  it('passes and reports the capture id and amount', () => {
    const result = verifyCapture(goodResponse(), expected);
    expect(result).toEqual({
      ok: true,
      captureId: '3C679366HH908993F',
      amount: { amount: 7400, currency: 'USD' },
    });
  });

  it('is the only arrangement that passes — the fixture is not trivially true', () => {
    expect(verifyCapture(goodResponse(), expected).ok).toBe(true);
  });
});

describe('check 1 — the order completed', () => {
  it.each(['APPROVED', 'CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED', 'VOIDED'])(
    'refuses an order in status %s',
    (status) => {
      const result = verifyCapture({ ...goodResponse(), status }, expected);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/order status/);
    },
  );
});

describe('check 2 — it is our order', () => {
  /**
   * The attack this stops: presenting a real, genuinely completed capture that belongs
   * to a different order — a cheap one, or somebody else's — against an expensive order
   * of ours. Every other check would pass.
   */
  it('refuses a capture for a different order id', () => {
    const response = goodResponse();
    response.purchase_units![0]!.custom_id = '65f0000000000000000000ff';
    const result = verifyCapture(response, expected);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/custom_id/);
  });

  it('refuses a capture with no custom_id at all', () => {
    const response = goodResponse();
    delete response.purchase_units![0]!.custom_id;
    expect(verifyCapture(response, expected).ok).toBe(false);
  });

  it('refuses a response with no purchase unit', () => {
    expect(verifyCapture({ id: 'x', status: 'COMPLETED' }, expected).ok).toBe(false);
    expect(verifyCapture({ id: 'x', status: 'COMPLETED', purchase_units: [] }, expected).ok).toBe(
      false,
    );
  });
});

describe('check 3 — the capture itself completed', () => {
  /**
   * An order can be COMPLETED while its capture is PENDING or DECLINED. Reading only
   * the order status is the subtle version of the 2022 bug: the response looks
   * successful and the money has not moved.
   */
  it.each(['PENDING', 'DECLINED', 'FAILED', 'REFUNDED'])(
    'refuses a capture in status %s even when the order says COMPLETED',
    (status) => {
      const response = goodResponse();
      response.purchase_units![0]!.payments!.captures![0]!.status = status;
      const result = verifyCapture(response, expected);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toMatch(/capture status/);
    },
  );

  it('refuses a completed order carrying no capture', () => {
    const response = goodResponse();
    response.purchase_units![0]!.payments = {};
    expect(verifyCapture(response, expected).ok).toBe(false);
  });
});

describe('checks 4 and 5 — the exact amount, in the right currency', () => {
  it.each([
    ['73.99', 'a cent short'],
    ['74.01', 'a cent over'],
    ['7.40', 'a decimal point out'],
    ['740.00', 'ten times'],
    ['0.00', 'nothing at all'],
  ])('refuses %s (%s)', (value) => {
    const response = goodResponse();
    response.purchase_units![0]!.payments!.captures![0]!.amount!.value = value;
    const result = verifyCapture(response, expected);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/captured/);
  });

  it('refuses the right number in the wrong currency', () => {
    const response = goodResponse();
    response.purchase_units![0]!.payments!.captures![0]!.amount!.currency_code = 'EUR';
    expect(verifyCapture(response, expected).ok).toBe(false);
  });

  /**
   * The amount is read from the **capture**, not from the purchase unit. A partial
   * capture leaves the unit's requested amount intact while capturing less, so a check
   * that read the unit would accept it.
   */
  it('reads the capture amount, not the requested amount', () => {
    const response = goodResponse();
    response.purchase_units![0]!.amount!.value = '74.00';
    response.purchase_units![0]!.payments!.captures![0]!.amount!.value = '1.00';
    expect(verifyCapture(response, expected).ok).toBe(false);
  });

  it('refuses an unparseable amount rather than coercing it', () => {
    const response = goodResponse();
    response.purchase_units![0]!.payments!.captures![0]!.amount!.value = '74,00';
    const result = verifyCapture(response, expected);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/unparseable/);
  });

  it('refuses a capture with no amount', () => {
    const response = goodResponse();
    delete response.purchase_units![0]!.payments!.captures![0]!.amount;
    expect(verifyCapture(response, expected).ok).toBe(false);
  });

  it('accepts an equal amount written differently', () => {
    const response = goodResponse();
    response.purchase_units![0]!.payments!.captures![0]!.amount!.value = '74.0';
    expect(verifyCapture(response, expected).ok).toBe(true);
  });
});

describe('the refusal reason', () => {
  it('names which check failed, for the operator', () => {
    const reasons = new Set<string>();
    const breakers: ((r: PayPalOrder) => void)[] = [
      (r) => (r.status = 'APPROVED'),
      (r) => (r.purchase_units![0]!.custom_id = 'other'),
      (r) => (r.purchase_units![0]!.payments!.captures![0]!.status = 'DECLINED'),
      (r) => (r.purchase_units![0]!.payments!.captures![0]!.amount!.value = '1.00'),
    ];
    for (const breaker of breakers) {
      const response = goodResponse();
      breaker(response);
      const result = verifyCapture(response, expected);
      expect(result.ok).toBe(false);
      if (!result.ok) reasons.add(result.reason);
    }
    // Four different failures must not collapse into one message — unlike the webhook
    // verifier, this one is never shown to a client, so it can and should be specific.
    expect(reasons.size).toBe(4);
  });
});
