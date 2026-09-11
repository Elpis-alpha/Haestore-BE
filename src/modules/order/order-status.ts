/**
 * The order status machine.
 *
 * ```
 * pending_payment → paid → processing → shipped → delivered
 *        ↓           ↓          ↓          ↓
 *     canceled  ←————┴——————————┴——————————┴——→ refunded
 * ```
 *
 * **The machine is data, and it is enforced in the query filter — never in an
 * application `if`.** A transition is performed as
 *
 *     findOneAndUpdate({ _id, status: { $in: predecessorsOf(next) } }, { $set: { status: next } })
 *
 * and a `null` return *is* the answer: the transition was illegal, which in practice
 * almost always means a duplicate or late delivery of something that already happened.
 *
 * Doing it the obvious way instead —
 *
 *     const order = await Order.findById(id);
 *     if (canTransition(order.status, next)) { order.status = next; await order.save(); }
 *
 * — reads identically and is wrong, because two webhook deliveries can both pass the
 * `if` before either saves. Stripe retries on any non-2xx and PayPal redelivers for
 * three days; a payment provider *will* deliver the same event three times, out of
 * order, hours late. Making the check part of the write is what makes that harmless
 * rather than a double-fulfilled order.
 *
 * This file is pure so the whole machine can be unit-tested without a database.
 */

export const ORDER_STATUSES = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'canceled',
  'refunded',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The edges, written as "what may come next", because that is how the domain reads.
 * `predecessorsOf` inverts it, because that is how a query filter reads.
 */
const SUCCESSORS: Record<OrderStatus, readonly OrderStatus[]> = {
  // Money has not moved. It can arrive, or the shopper can give up (or the sweeper can
  // give up on their behalf and return the stock to the shelf).
  pending_payment: ['paid', 'canceled'],
  // Paid but not yet picked. Refundable, and cancelable — canceling a paid order is a
  // real operation that refunds and restocks, not an error.
  paid: ['processing', 'canceled', 'refunded'],
  processing: ['shipped', 'canceled', 'refunded'],
  // Once it is with the carrier it cannot be canceled, only refunded on return.
  shipped: ['delivered', 'refunded'],
  delivered: ['refunded'],
  // Both terminal. An order that has been refunded is not re-payable: the shopper buys
  // again and gets a new order, which is what keeps the history truthful.
  canceled: [],
  refunded: [],
};

/** Statuses an order may legally be in for `next` to be a valid transition. */
export function predecessorsOf(next: OrderStatus): OrderStatus[] {
  return ORDER_STATUSES.filter((from) => SUCCESSORS[from].includes(next));
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return SUCCESSORS[from].includes(to);
}

/** Nothing further can happen to these, so a failed transition to one is not a surprise. */
export function isTerminal(status: OrderStatus): boolean {
  return SUCCESSORS[status].length === 0;
}

/** The order has been paid for, whatever has happened to it since. */
export function isPaidState(status: OrderStatus): boolean {
  return (
    status === 'paid' || status === 'processing' || status === 'shipped' || status === 'delivered'
  );
}

/**
 * Whether stock reserved for this order is still being held.
 *
 * Reservation is released on exactly two occasions: the order is canceled (back to the
 * shelf) or it is fulfilled (`onHand` comes down and the hold with it). Everything in
 * between still holds its stock, which is what stops a paid order's items being sold
 * out from under it.
 */
export function holdsReservation(status: OrderStatus): boolean {
  return status === 'pending_payment' || status === 'paid' || status === 'processing';
}
