import { describe, expect, it } from 'vitest';
import {
  ACTION_TARGETS,
  ADMIN_CANCELABLE_FROM,
  ORDER_STATUSES,
  adminActionsFor,
  canTransition,
  isPaidState,
} from './order-status.js';

/**
 * The buttons the admin console offers on an order.
 *
 * They are derived from the status machine rather than listed per status, and these tests
 * pin the derivation from both sides: nothing offered is illegal, and the one deliberate
 * narrowing — no cancel once money has moved — holds for every paid state.
 */

describe('adminActionsFor', () => {
  it('offers only transitions the machine allows, for every status', () => {
    for (const status of ORDER_STATUSES) {
      for (const paymentStarted of [true, false]) {
        for (const action of adminActionsFor({ status, paymentStarted })) {
          if (action === 'reconcile') continue;
          expect(canTransition(status, ACTION_TARGETS[action]), `${status} → ${action}`).toBe(true);
        }
      }
    }
  });

  it('never offers cancel on an order that has been paid for', () => {
    for (const status of ORDER_STATUSES.filter(isPaidState)) {
      expect(adminActionsFor({ status, paymentStarted: true })).not.toContain('cancel');
    }
    expect(ADMIN_CANCELABLE_FROM).toEqual(['pending_payment']);
  });

  it('offers a refund wherever the machine allows one', () => {
    for (const status of ORDER_STATUSES) {
      const offered = adminActionsFor({ status, paymentStarted: true }).includes('record_refund');
      expect(offered, status).toBe(canTransition(status, 'refunded'));
    }
  });

  it('offers reconcile only on an unpaid order with a payment to ask about', () => {
    expect(adminActionsFor({ status: 'pending_payment', paymentStarted: true })).toEqual([
      'reconcile',
      'cancel',
    ]);
    // Abandoned before the payment step: the provider has nothing to say.
    expect(adminActionsFor({ status: 'pending_payment', paymentStarted: false })).toEqual([
      'cancel',
    ]);
    expect(adminActionsFor({ status: 'paid', paymentStarted: true })).not.toContain('reconcile');
  });

  it('reads as the forward path for each paid state', () => {
    // Not straight to shipped: the machine has no paid → shipped edge, so an order is
    // packed before it goes out, and the console cannot skip the step.
    expect(adminActionsFor({ status: 'paid', paymentStarted: true })).toEqual([
      'start_processing',
      'record_refund',
    ]);
    expect(adminActionsFor({ status: 'processing', paymentStarted: true })).toEqual([
      'mark_shipped',
      'record_refund',
    ]);
    expect(adminActionsFor({ status: 'shipped', paymentStarted: true })).toEqual([
      'mark_delivered',
      'record_refund',
    ]);
  });

  it('offers nothing on a terminal order', () => {
    expect(adminActionsFor({ status: 'canceled', paymentStarted: true })).toEqual([]);
    expect(adminActionsFor({ status: 'refunded', paymentStarted: true })).toEqual([]);
  });
});
