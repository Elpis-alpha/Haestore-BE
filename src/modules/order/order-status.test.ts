import { describe, expect, it } from 'vitest';
import {
  ORDER_STATUSES,
  canTransition,
  holdsReservation,
  isPaidState,
  isTerminal,
  predecessorsOf,
  type OrderStatus,
} from './order-status.js';

/**
 * The plan names this machine as a unit-test target by itself, because it is the one
 * piece of Phase 7 where being wrong is silent: an over-permissive edge does not throw,
 * it fulfils an order twice.
 */

describe('the happy path', () => {
  const path: OrderStatus[] = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered'];

  it('walks end to end one step at a time', () => {
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('refuses to skip a step', () => {
    expect(canTransition('pending_payment', 'processing')).toBe(false);
    expect(canTransition('pending_payment', 'shipped')).toBe(false);
    expect(canTransition('paid', 'shipped')).toBe(false);
    expect(canTransition('paid', 'delivered')).toBe(false);
  });

  it('refuses to walk backwards', () => {
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransition(path[i]!, path[i - 1]!)).toBe(false);
    }
  });
});

describe('the money-moving transition', () => {
  /**
   * This is the assertion the idempotency story rests on. `markOrderPaid` filters on
   * `status: 'pending_payment'`; if any other status could also reach `paid`, a late
   * webhook arriving after an admin had already processed the order would move it
   * back and fulfil it a second time.
   */
  it('is reachable from pending_payment and from nowhere else', () => {
    expect(predecessorsOf('paid')).toEqual(['pending_payment']);
  });

  it('cannot be re-entered from itself, so a replayed event matches nothing', () => {
    expect(canTransition('paid', 'paid')).toBe(false);
  });
});

describe('cancellation and refunds', () => {
  it('cancels only before the carrier has it', () => {
    expect(predecessorsOf('canceled')).toEqual(['pending_payment', 'paid', 'processing']);
    expect(canTransition('shipped', 'canceled')).toBe(false);
    expect(canTransition('delivered', 'canceled')).toBe(false);
  });

  it('refunds only what was paid for', () => {
    expect(predecessorsOf('refunded')).toEqual(['paid', 'processing', 'shipped', 'delivered']);
    // Nothing was captured, so there is nothing to send back.
    expect(canTransition('pending_payment', 'refunded')).toBe(false);
  });

  it('treats both endings as final', () => {
    expect(isTerminal('canceled')).toBe(true);
    expect(isTerminal('refunded')).toBe(true);
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, 'pending_payment')).toBe(false);
    }
  });
});

describe('self-transitions', () => {
  it('are illegal for every status', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });
});

describe('predecessorsOf is the inverse of canTransition', () => {
  it('agrees with the edge table in both directions', () => {
    for (const to of ORDER_STATUSES) {
      const predecessors = predecessorsOf(to);
      for (const from of ORDER_STATUSES) {
        expect(predecessors.includes(from)).toBe(canTransition(from, to));
      }
    }
  });

  it('never returns a status twice, so $in cannot widen a filter', () => {
    for (const to of ORDER_STATUSES) {
      const predecessors = predecessorsOf(to);
      expect(new Set(predecessors).size).toBe(predecessors.length);
    }
  });
});

describe('derived predicates', () => {
  it('counts every post-payment status as paid', () => {
    expect(ORDER_STATUSES.filter(isPaidState)).toEqual([
      'paid',
      'processing',
      'shipped',
      'delivered',
    ]);
  });

  /**
   * Reservation is held from the moment the order is written until it is canceled or
   * handed to the carrier. Getting this wrong in the permissive direction lets the
   * sweeper release stock out from under a paid order.
   */
  it('holds stock until the order ships or is canceled', () => {
    expect(ORDER_STATUSES.filter(holdsReservation)).toEqual([
      'pending_payment',
      'paid',
      'processing',
    ]);
  });
});
