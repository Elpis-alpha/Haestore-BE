import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';
import { ORDER_STATUSES } from './order-status.js';

/**
 * The order.
 *
 * Two properties drive the whole shape.
 *
 * **It is a snapshot, not a set of references.** Every line carries the title, SKU, axis
 * values and unit price as they stood at purchase, so archiving a product, renaming a
 * category or re-pricing a variant cannot retroactively change what someone was charged.
 * The 2022 app populated order lines from the live product on every read, which meant
 * order history quietly rewrote itself and a deleted product produced blank rows in a
 * customer's receipt.
 *
 * **It is the record of money, so the database enforces what the code must not get
 * wrong.** The partial unique indexes on `payment.intentId` and `payment.captureId` make
 * it structurally impossible for one PaymentIntent or one PayPal capture to be attached
 * to two orders — not unlikely, impossible — which is the backstop underneath
 * `markOrderPaid`'s status filter.
 */

const moneySchema = new Schema(
  {
    amount: { type: Number, required: true, min: 0, validate: Number.isInteger },
    currency: { type: String, required: true, uppercase: true, minlength: 3, maxlength: 3 },
  },
  { _id: false },
);

/**
 * A line as sold.
 *
 * `unitPrice` here means something different from the cart's field of the same name: in
 * the cart it is "what the shopper last saw", refreshed on every read; here it is what
 * they were charged and it never changes again. `lineTotal` is still **not stored** —
 * it is `unitPrice × quantity`, and storing a third number that must agree with two
 * others is how the 2022 cart ended up unable to recover a unit price.
 */
const orderLineSchema = new Schema(
  {
    lineKey: { type: String, required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, required: true },

    sku: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, trim: true },
    axisValues: {
      type: [
        new Schema(
          { key: { type: String, required: true }, value: { type: String, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },
    imagePublicId: { type: String, trim: true },

    /** What this line was charged, per piece. Frozen at purchase. */
    unitPrice: { type: moneySchema, required: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
  },
  { _id: false },
);

/**
 * Where it is going.
 *
 * Collected for fulfilment only: this shop charges no delivery fee and no tax, so the
 * address is never an input to the total. It is deliberately a flat, permissive shape —
 * a schema that insists on a two-letter state and a five-digit ZIP is a schema that
 * cannot take an order from most of the world.
 */
const addressSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 120 },
    region: { type: String, trim: true, maxlength: 120 },
    postalCode: { type: String, trim: true, maxlength: 32 },
    /** ISO 3166-1 alpha-2. */
    country: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },
    phone: { type: String, trim: true, maxlength: 40 },
  },
  { _id: false },
);

/**
 * What the provider says happened, recorded from **the provider's own response**.
 *
 * Nothing in here is ever written from a request body. That is the direct repair of the
 * 2022 app's worst defect: `POST /api/order/add-paypal` stored a payment blob the
 * browser posted, without ever asking PayPal whether the payment existed, so any
 * logged-in user could curl themselves a completed order.
 */
const paymentSchema = new Schema(
  {
    provider: { type: String, required: true, enum: ['stripe', 'paypal'] },

    /** Stripe's PaymentIntent id, or PayPal's Order id. Unique across orders. */
    intentId: { type: String, default: null },
    /** Stripe's charge id, or PayPal's capture id. Unique across orders. */
    captureId: { type: String, default: null },

    /**
     * What the provider reported capturing, in minor units. Compared for **exact**
     * equality against the order's own `grandTotal` before anything is fulfilled —
     * there is no tolerance branch.
     */
    amountCaptured: { type: moneySchema, default: null },

    /** The provider's own status string, kept verbatim for support and forensics. */
    providerStatus: { type: String, default: null },
    capturedAt: { type: Date, default: null },

    /**
     * Why a payment was refused, when it was. Written by the capture path on a failed
     * check so an operator can see *which* of the five checks rejected it rather than
     * inferring it from an order that simply never moved.
     */
    lastError: { type: String, default: null },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    /** `HAE-XXXXXXXX`. What a customer reads down a phone. */
    orderNumber: { type: String, required: true, unique: true, uppercase: true, trim: true },

    /**
     * Null for a guest order until it is claimed. `claimGuestOrders` attaches these at
     * OTP verification, which is safe precisely because possession of an emailed code
     * is a strictly stronger claim on the address than the guest cookie ever was.
     */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    /** Always set. The identity an order actually belongs to, account or not. */
    email: { type: String, required: true, lowercase: true, trim: true, index: true },

    /**
     * HMAC of the token in the confirmation email's link. Lets a guest read their own
     * order at `/orders/HAE-…?t=<token>` while a bare order number authorises nothing.
     */
    claimTokenHash: { type: String, default: null },

    status: {
      type: String,
      required: true,
      enum: ORDER_STATUSES,
      default: 'pending_payment',
    },

    currency: { type: String, required: true, uppercase: true, default: 'USD' },
    lines: { type: [orderLineSchema], required: true },

    /**
     * The totals, as a breakdown rather than a single number.
     *
     * This shop charges no shipping and no tax, so `grandTotal === subtotal` today and
     * the integration suite asserts it. The breakdown exists anyway because the amount
     * verification compares against `grandTotal` specifically: when a shipping or
     * discount line does arrive, it lands in this object and every provider check keeps
     * comparing the right field, rather than one of them still reading `subtotal`.
     */
    totals: {
      type: new Schema(
        {
          subtotal: { type: moneySchema, required: true },
          discountTotal: { type: moneySchema, default: null },
          shippingTotal: { type: moneySchema, default: null },
          taxTotal: { type: moneySchema, default: null },
          grandTotal: { type: moneySchema, required: true },
        },
        { _id: false },
      ),
      required: true,
    },

    shippingAddress: { type: addressSchema, required: true },
    payment: { type: paymentSchema, required: true },

    /** The cart this came from, so a support question can be traced back. */
    cart: { type: Schema.Types.ObjectId, ref: 'Cart', default: null },

    /**
     * Whether the stock reserved at checkout is still being held by this order.
     *
     * Stored rather than derived from `status` because release must be **idempotent**:
     * the sweeper, an admin cancel and a webhook-driven cancel can all reach the same
     * order, and `findOneAndUpdate({ _id, stockReserved: true }, { $set: { stockReserved: false } })`
     * returning null is what makes the second one a no-op. Deriving it from status
     * would let two concurrent releases both decide "yes, still held" and give the same
     * stock back twice.
     */
    stockReserved: { type: Boolean, required: true, default: false },

    /**
     * When an unpaid order stops holding its stock.
     *
     * The sweeper cancels `pending_payment` orders past this and returns the
     * reservation to the shelf. Without it, an abandoned checkout holds stock forever
     * and the shop sells out to people who never paid.
     */
    reservationExpiresAt: { type: Date, default: null },

    paidAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },

    /**
     * Every status change, appended. An order's history is the first thing anybody
     * wants when a payment is disputed, and reconstructing it from logs is not a plan.
     */
    history: {
      type: [
        new Schema(
          {
            status: { type: String, required: true, enum: ORDER_STATUSES },
            at: { type: Date, required: true, default: () => new Date() },
            /** `webhook`, `reconcile`, `sweeper`, `admin:<userId>`, `checkout`. */
            by: { type: String, required: true },
            note: { type: String, trim: true, maxlength: 500 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

/**
 * **One PaymentIntent, one order. One capture, one order.** Enforced by the database.
 *
 * `markOrderPaid`'s status filter already makes a replayed webhook a no-op, but that
 * guard protects one order from being paid twice. These protect the other direction —
 * one payment being attached to two orders, which is what a mixed-up retry or a
 * copy-pasted intent id would produce. Partial, because `null` is the normal state for
 * an order whose provider has not issued the id yet, and a plain unique index would
 * allow exactly one such order to exist.
 */
orderSchema.index(
  { 'payment.intentId': 1 },
  { unique: true, partialFilterExpression: { 'payment.intentId': { $type: 'string' } } },
);
orderSchema.index(
  { 'payment.captureId': 1 },
  { unique: true, partialFilterExpression: { 'payment.captureId': { $type: 'string' } } },
);

/** The account's order history, newest first. */
orderSchema.index({ user: 1, createdAt: -1 });
/** What `claimGuestOrders` scans at sign-in. */
orderSchema.index({ email: 1, user: 1 });
/** The sweeper's query: unpaid orders whose hold has run out. */
orderSchema.index({ status: 1, reservationExpiresAt: 1 });

export type OrderAttrs = InferSchemaType<typeof orderSchema>;
export type OrderDoc = HydratedDocument<OrderAttrs>;
export type OrderLineAttrs = InferSchemaType<typeof orderLineSchema>;

export const Order = registerModel('Order', orderSchema);
