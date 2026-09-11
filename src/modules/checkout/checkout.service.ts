import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { Money } from '../../lib/money.js';
import { Cart, type CartDoc } from '../cart/cart.model.js';
import { loadLiveCatalogue } from '../cart/live-catalogue.js';
import { repriceCart, type PricedCart, type PricedLine } from '../cart/repricing.js';
import type { CartOwner } from '../cart/cart.service.js';
import { Order, type OrderDoc } from '../order/order.model.js';
import { generateClaimToken, generateOrderNumber, hashClaimToken } from '../order/order-number.js';
import { reserveAll, type ReservationRequest } from './reservation.js';

/**
 * Turning a cart into an order.
 *
 * Three things happen here and the plan is emphatic about all three:
 *
 * 1. **Re-price from live data.** The client sends no amounts, ever — not the total, not
 *    a line price, not a quantity it worked out itself. Everything charged is computed
 *    here from the catalogue, which is the only arrangement where a tampered request
 *    body cannot change what somebody pays.
 * 2. **Reserve stock and insert the order in one transaction.** Either the order exists
 *    holding its stock, or neither happened.
 * 3. **Create the PaymentIntent outside it.** Never hold a transaction open across a
 *    third-party HTTP call — see `checkout.routes.ts`, which is where that happens.
 */

/** What the shopper supplies. Notably: no money, and no line data. */
export type CheckoutInput = {
  email: string;
  shippingAddress: {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    region?: string;
    postalCode?: string;
    country: string;
    phone?: string;
  };
  provider: 'stripe' | 'paypal';
};

export type DraftOrder = {
  order: OrderDoc;
  /** Returned once, in the response, and only for a guest. Never stored in the clear. */
  claimToken: string | null;
};

/**
 * Refuses a checkout that cannot be fulfilled as asked.
 *
 * Phase 6 left a note that this had to exist: `repriceCart` reports `sellableQuantity`
 * and `maxQuantity: 0` on a line that has become unavailable, and the frontend carries
 * an `isBlocking` flag that nothing consumed. This is what consumes it. The cart is
 * deliberately permissive — it shows you what you asked for and flags the problem —
 * and checkout is deliberately strict, because this is the point where a wrong answer
 * takes somebody's money.
 */
function assertSellable(priced: PricedCart): void {
  if (priced.lines.length === 0) throw badRequest('Your bag is empty.');

  const blocking = priced.lines.filter(
    (line) => line.maxQuantity === 0 || line.sellableQuantity < 1,
  );
  if (blocking.length > 0) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Some items are no longer available.', {
      details: {
        lines: blocking.map((line) => ({
          lineKey: line.lineKey,
          title: line.title,
          reason: line.changes[0]?.kind ?? 'unavailable',
        })),
      },
    });
  }

  /**
   * A line clamped below what was asked for is also a refusal, not a silent adjustment.
   * Charging for 2 when somebody asked for 5 is a decision they have to make, and the
   * cart page is where they make it.
   */
  const clamped = priced.lines.filter((line) => line.sellableQuantity < line.quantity);
  if (clamped.length > 0) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'Some quantities are no longer available.', {
      details: {
        lines: clamped.map((line) => ({
          lineKey: line.lineKey,
          title: line.title,
          requested: line.quantity,
          available: line.sellableQuantity,
        })),
      },
    });
  }
}

/**
 * The totals.
 *
 * `grandTotal === subtotal` — this shop charges no delivery and no tax. The breakdown is
 * built anyway, and every amount check reads `grandTotal` specifically, so adding a
 * shipping line later changes this function and nothing else. A checkout that compared
 * against `subtotal` would keep passing its tests and start under-charging on the day a
 * second component appeared.
 */
function totalsOf(priced: PricedCart): {
  subtotal: Money;
  grandTotal: Money;
} {
  const subtotal = priced.subtotal;
  return { subtotal, grandTotal: { ...subtotal } };
}

function lineOf(line: PricedLine) {
  return {
    lineKey: line.lineKey,
    product: new mongoose.Types.ObjectId(line.productId),
    variantId: new mongoose.Types.ObjectId(line.variantId),
    sku: line.sku,
    title: line.title,
    slug: line.slug,
    axisValues: line.axisValues,
    ...(line.imagePublicId ? { imagePublicId: line.imagePublicId } : {}),
    unitPrice: line.unitPrice,
    quantity: line.sellableQuantity,
  };
}

/**
 * Creates the order from the caller's active cart.
 *
 * The cart is flipped to `ordered` inside the same transaction, which is what releases
 * the partial unique index on `{user, status: 'active'}` so the shopper's next cart can
 * be created. Phase 6 left that value in the enum with nothing setting it; this is the
 * setter.
 */
export async function createOrderFromCart(
  owner: CartOwner,
  input: CheckoutInput,
): Promise<DraftOrder> {
  const cart = await Cart.findOne(
    'userId' in owner
      ? { user: new mongoose.Types.ObjectId(owner.userId), status: 'active' }
      : { guestKeyHash: owner.guestKey, status: 'active' },
  );
  if (!cart) throw notFound('There is no bag to check out.');

  const priced = await priceCart(cart);
  assertSellable(priced);

  const totals = totalsOf(priced);
  const reservations: ReservationRequest[] = priced.lines.map((line) => ({
    productId: line.productId,
    variantId: line.variantId,
    quantity: line.sellableQuantity,
  }));

  // A guest gets a token so the confirmation email's link authorises a read. An account
  // does not need one: the session already authorises it, and issuing a bearer link for
  // an order that has an owner is a credential nobody asked for.
  const isGuest = !('userId' in owner);
  const claimToken = isGuest ? generateClaimToken() : null;

  const session = await mongoose.startSession();
  try {
    let created: OrderDoc | null = null;

    await session.withTransaction(async () => {
      /**
       * Reserve first, inside the transaction.
       *
       * If any line cannot be filled the transaction aborts and nothing was taken. The
       * explicit rollback inside `reserveAll` is belt and braces here, and load-bearing
       * on the paths that call it without a session.
       */
      const reserved = await reserveAll(reservations, session);
      if (!reserved.ok) {
        const line = priced.lines[reserved.failedAt]!;
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          `${line.title} sold out while you were checking out.`,
          {
            details: { lines: [{ lineKey: line.lineKey, title: line.title, reason: 'sold_out' }] },
          },
        );
      }

      const [order] = await Order.create(
        [
          {
            orderNumber: generateOrderNumber(),
            user: 'userId' in owner ? new mongoose.Types.ObjectId(owner.userId) : null,
            email: input.email.toLowerCase().trim(),
            claimTokenHash: claimToken ? hashClaimToken(claimToken) : null,
            status: 'pending_payment',
            currency: priced.currency,
            lines: priced.lines.map(lineOf),
            totals,
            shippingAddress: input.shippingAddress,
            payment: { provider: input.provider },
            cart: cart._id,
            stockReserved: true,
            reservationExpiresAt: new Date(Date.now() + env.CHECKOUT_RESERVATION_MINUTES * 60_000),
            history: [{ status: 'pending_payment', at: new Date(), by: 'checkout' }],
          },
        ],
        { session },
      );

      /**
       * The cart is retired, not emptied.
       *
       * Keeping its lines means a failed payment leaves something to look at, and the
       * order holds its own snapshot regardless. `ordered` is what lets the next
       * `openCart` create a fresh one.
       */
      cart.status = 'ordered';
      await cart.save({ session });

      created = order!;
    });

    return { order: created!, claimToken };
  } finally {
    await session.endSession();
  }
}

/** The cart, priced from live catalogue data. */
async function priceCart(cart: CartDoc): Promise<PricedCart> {
  const live = await loadLiveCatalogue(cart.lines.map((line) => line.lineKey));
  return repriceCart(
    {
      lines: cart.lines.map((line) => ({
        lineKey: line.lineKey,
        productId: String(line.product),
        variantId: String(line.variantId),
        sku: line.sku,
        title: line.title,
        slug: line.slug,
        axisValues: line.axisValues.map((a) => ({ key: a.key, value: a.value })),
        ...(line.imagePublicId ? { imagePublicId: line.imagePublicId } : {}),
        unitPrice: line.unitPrice,
        quantity: line.quantity,
        addedAt: line.addedAt,
      })),
      savedForLater: [],
      currency: cart.currency,
    },
    live,
  );
}

/**
 * Refuses a second checkout of an order that is already being paid for.
 *
 * The API-edge idempotency key handles a double-tapped button; this handles the slower
 * version — the shopper who leaves the payment step, comes back, and starts again.
 */
export function assertPayable(order: OrderDoc): void {
  if (order.status !== 'pending_payment') {
    throw conflict('This order has already been paid for.', {
      orderNumber: order.orderNumber,
      status: order.status,
    });
  }
  if (order.reservationExpiresAt && order.reservationExpiresAt.getTime() < Date.now()) {
    logger.warn(
      { orderId: String(order._id), orderNumber: order.orderNumber },
      'checkout: payment attempted against an expired reservation',
    );
    throw conflict('This checkout expired. Please start again.', {
      orderNumber: order.orderNumber,
      status: order.status,
    });
  }
}
