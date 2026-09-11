import { z } from 'zod';
import { normaliseOrderNumber } from '../order/order-number.js';

/**
 * The checkout's input contract.
 *
 * **There is no amount in it, and no line data.** Same structural defence as the cart's
 * schema: the browser cannot send a price because there is no field to put one in. What
 * gets charged is computed on the server from the catalogue, every time.
 *
 * The address is validated for shape and length only. A schema that insists on a
 * two-letter state and a five-digit postal code is one that cannot take an order from
 * most of the world, and the address here is for fulfilment — it is never an input to
 * the total, because this shop charges no delivery and no tax.
 */

export const addressSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(32).optional(),
  /** ISO 3166-1 alpha-2, so the value is a country rather than a spelling of one. */
  country: z.string().trim().length(2).toUpperCase(),
  phone: z.string().trim().max(40).optional(),
});

export const createCheckoutSchema = z.strictObject({
  /**
   * Normalised before validation, not after.
   *
   * Phase 5 found this the hard way: `z.email().transform(trim)` runs the transform on
   * the way *out*, so a pasted address with a trailing space fails validation and the
   * shopper is told their address is not an address.
   */
  email: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
    z.email().max(254),
  ),
  shippingAddress: addressSchema,
  provider: z.enum(['stripe', 'paypal']),
});

/** The client sends the PayPal order id it was given, and nothing else. */
export const capturePayPalSchema = z.strictObject({
  paypalOrderId: z.string().trim().min(1).max(64),
});

/**
 * The return page's reconcile. A guest presents the claim token from their emailed
 * link; an account presents nothing, because their session already authorises it.
 */
export const reconcileSchema = z.strictObject({
  /**
   * Normalised rather than merely uppercased — see `normaliseOrderNumber`. A shopper who
   * retypes the number from their confirmation page will have read the zero as an O.
   */
  orderNumber: z.preprocess(
    (value) => (typeof value === 'string' ? normaliseOrderNumber(value) : value),
    z.string().min(1).max(32),
  ),
  claimToken: z.string().trim().min(1).max(128).nullish(),
});

export type ReconcileInput = z.infer<typeof reconcileSchema>;
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
export type CapturePayPalInput = z.infer<typeof capturePayPalSchema>;
export type AddressInput = z.infer<typeof addressSchema>;
