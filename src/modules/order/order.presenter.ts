import type { OrderDoc } from './order.model.js';
import { multiplyMoney, type Money } from '../../lib/money.js';

/**
 * The order, as the API returns it.
 *
 * An explicit projection rather than the document, for the reason this codebase returns
 * explicit projections everywhere: the order holds `claimTokenHash`, the provider's
 * verbatim status strings and a `payment.lastError` that names which verification check
 * refused a payment. None of that belongs in a response, and a serialiser that starts
 * from the whole document and removes things is one field away from leaking on the day
 * somebody adds a field.
 *
 * `lineTotal` is computed here rather than stored, exactly as the cart does it — the
 * 2022 repair that runs through the whole codebase.
 */

export type OrderLineResponse = {
  lineKey: string;
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  slug: string;
  axisValues: { key: string; value: string }[];
  imagePublicId?: string;
  unitPrice: Money;
  quantity: number;
  lineTotal: Money;
};

export type OrderResponse = {
  id: string;
  orderNumber: string;
  status: string;
  email: string;
  currency: string;
  lines: OrderLineResponse[];
  totals: { subtotal: Money; grandTotal: Money };
  shippingAddress: Record<string, unknown>;
  /** The provider and whether it has settled. Never the ids, never the error text. */
  payment: { provider: string; paid: boolean };
  itemCount: number;
  placedAt: string;
  paidAt: string | null;
  /**
   * Returned exactly once, in the response that created a guest order, so the
   * confirmation page can build a link the shopper can come back to. Never read back
   * out of the database — only the HMAC is stored.
   */
  claimToken?: string;
};

export function toOrderResponse(
  order: OrderDoc,
  options: { claimToken?: string | null } = {},
): OrderResponse {
  const lines = order.lines.map((line) => ({
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
    lineTotal: multiplyMoney(line.unitPrice, line.quantity),
  }));

  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    status: order.status,
    email: order.email,
    currency: order.currency,
    lines,
    totals: {
      subtotal: order.totals.subtotal,
      grandTotal: order.totals.grandTotal,
    },
    shippingAddress: {
      name: order.shippingAddress.name,
      line1: order.shippingAddress.line1,
      ...(order.shippingAddress.line2 ? { line2: order.shippingAddress.line2 } : {}),
      city: order.shippingAddress.city,
      ...(order.shippingAddress.region ? { region: order.shippingAddress.region } : {}),
      ...(order.shippingAddress.postalCode ? { postalCode: order.shippingAddress.postalCode } : {}),
      country: order.shippingAddress.country,
      ...(order.shippingAddress.phone ? { phone: order.shippingAddress.phone } : {}),
    },
    payment: {
      provider: order.payment.provider,
      // A boolean, not the provider's status string: "what does the shopper need to
      // know" is "has it gone through", and the string is an implementation detail of
      // whichever provider was used.
      paid: order.paidAt !== null,
    },
    itemCount: lines.reduce((n, line) => n + line.quantity, 0),
    placedAt: order.createdAt.toISOString(),
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    ...(options.claimToken ? { claimToken: options.claimToken } : {}),
  };
}
