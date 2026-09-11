import mongoose from 'mongoose';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { Product } from '../catalog/product.model.js';
import { Cart, type CartDoc } from './cart.model.js';
import { lineKeyOf } from './line-key.js';
import { loadLiveCatalogue } from './live-catalogue.js';
import { mergeCarts } from './merge.js';
import { MAX_LINE_QUANTITY, repriceCart, type PricedCart } from './repricing.js';
import { GUEST_COOKIE_TTL_SECONDS } from './guest-cookie.js';
import type { CartLine, LineReport } from './cart-types.js';

/**
 * The cart's one stateful layer.
 *
 * Everything decided here is decided by merge.ts or repricing.ts, which are pure and
 * tested branch by branch. This file's job is the parts those cannot have: which
 * document, whose, inside what transaction, and what the caller is told.
 *
 * **Nothing here reserves stock.** A cart that reserved would let anyone empty the
 * shelves for free, and would need a sweeper to give the stock back. Reservation is
 * checkout's, held against a real order for a bounded time (Phase 7). The cart clamps
 * to what is available and says so; between the clamp and the payment somebody else may
 * still take the last one, which is true of every shop and is what checkout is for.
 */

/** Who is asking. Exactly one of the two, which the routes guarantee. */
export type CartOwner = { userId: string } | { guestKey: string };

const MAX_LINES = 60;

const ownerFilter = (owner: CartOwner) =>
  'userId' in owner
    ? { user: new mongoose.Types.ObjectId(owner.userId), status: 'active' as const }
    : { guestKeyHash: owner.guestKey, status: 'active' as const };

const guestExpiry = () => new Date(Date.now() + GUEST_COOKIE_TTL_SECONDS * 1000);

/** The cart as it is, or null. Reading must never create — see `openCart`. */
export async function findCart(owner: CartOwner): Promise<CartDoc | null> {
  return Cart.findOne(ownerFilter(owner));
}

/**
 * The cart, creating one if there is none.
 *
 * Called only from the write paths. A `GET` that created a document would turn every
 * crawler hitting the storefront into a row in the collection, and would set a guest
 * cookie on somebody who never added anything — the thing the lazy cookie exists to
 * avoid.
 *
 * The `upsert` handles the race two tabs produce, and the E11000 fallback handles the
 * one `upsert` itself has: two concurrent upserts against the same missing document can
 * both attempt the insert, and the loser must read the winner rather than fail a
 * shopper's click.
 */
export async function openCart(owner: CartOwner): Promise<CartDoc> {
  const filter = ownerFilter(owner);
  try {
    const cart = await Cart.findOneAndUpdate(
      filter,
      {
        $setOnInsert: {
          ...filter,
          currency: 'USD',
          lines: [],
          savedForLater: [],
          ...('guestKey' in owner ? { expiresAt: guestExpiry() } : {}),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return cart;
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const existing = await Cart.findOne(filter);
    if (!existing) throw err;
    return existing;
  }
}

/**
 * The cart as the storefront sees it: re-priced against live data on every read.
 *
 * An absent cart is an empty one, not a 404. "You have no cart" and "your cart is
 * empty" are the same fact to a shopper, and making the first an error would mean every
 * page rendering a bag badge had to handle a failure that is the normal state.
 */
export async function viewCart(owner: CartOwner): Promise<PricedCart> {
  const cart = await findCart(owner);
  if (!cart) return emptyCart();
  return priceOf(cart);
}

export function emptyCart(currency = 'USD'): PricedCart {
  return {
    lines: [],
    savedForLater: [],
    subtotal: { amount: 0, currency },
    itemCount: 0,
    currency,
    needsAttention: false,
  };
}

async function priceOf(cart: CartDoc): Promise<PricedCart> {
  const stored = toLines(cart);
  const live = await loadLiveCatalogue([
    ...stored.lines.map((l) => l.lineKey),
    ...stored.savedForLater.map((l) => l.lineKey),
  ]);
  return repriceCart({ ...stored, currency: cart.currency }, live);
}

/* ------------------------------------------------------------------ writing -- */

export type AddLineInput = {
  productId: string;
  variantId: string;
  quantity: number;
};

/**
 * Add to bag.
 *
 * The client sends a product, a variant and a quantity — **never a price**. Every figure
 * comes from the catalogue on the server, which is the direct repair of the 2022 app's
 * `add-paypal` route accepting a payment blob from the browser. There is nothing a
 * caller can put in this body that changes what anything costs.
 *
 * Adding a line that is already there raises its quantity rather than making a second
 * row, for the same reason the merge does: a cart with the same variant twice has no
 * meaning a shopper would recognise.
 */
export async function addLine(owner: CartOwner, input: AddLineInput): Promise<PricedCart> {
  const found = await findVariant(input.productId, input.variantId);

  const cart = await openCart(owner);
  const lineKey = lineKeyOf(input.productId, input.variantId);
  const existing = cart.lines.find((l) => l.lineKey === lineKey);

  if (!existing && cart.lines.length >= MAX_LINES) {
    throw conflict(`A cart holds at most ${MAX_LINES} different items.`);
  }

  // A currency the cart is not in cannot be added to it. One shop, one currency, so
  // this is unreachable today — and it is checked anyway, because the alternative to
  // checking is a subtotal that silently drops a line.
  if (found.price.currency !== cart.currency) {
    throw conflict('That item is priced in a different currency.');
  }

  const ceiling = found.backorderable
    ? MAX_LINE_QUANTITY
    : Math.min(MAX_LINE_QUANTITY, found.available);

  if (ceiling <= 0) {
    throw conflict('That is sold out.');
  }

  const wanted = Math.min((existing?.quantity ?? 0) + input.quantity, ceiling);

  if (existing) {
    existing.quantity = wanted;
    existing.set(snapshotOf(found));
  } else {
    cart.lines.push({
      lineKey,
      product: new mongoose.Types.ObjectId(input.productId),
      variantId: new mongoose.Types.ObjectId(input.variantId),
      quantity: wanted,
      addedAt: new Date(),
      ...snapshotOf(found),
    });
    // A line the shopper had set aside and has now added back belongs in one place.
    cart.set(
      'savedForLater',
      cart.savedForLater.filter((l) => l.lineKey !== lineKey),
    );
  }

  await save(cart, owner);
  return priceOf(cart);
}

export async function setLineQuantity(
  owner: CartOwner,
  lineKey: string,
  quantity: number,
): Promise<PricedCart> {
  const cart = await findCart(owner);
  if (!cart) throw notFound('There is no cart to change.');

  const line = cart.lines.find((l) => l.lineKey === lineKey);
  if (!line) throw notFound('That item is not in your bag.');

  if (quantity <= 0) {
    cart.set(
      'lines',
      cart.lines.filter((l) => l.lineKey !== lineKey),
    );
  } else {
    line.quantity = Math.min(quantity, MAX_LINE_QUANTITY);
  }

  await save(cart, owner);
  return priceOf(cart);
}

export async function removeLine(owner: CartOwner, lineKey: string): Promise<PricedCart> {
  const cart = await findCart(owner);
  if (!cart) throw notFound('There is no cart to change.');

  const before = cart.lines.length + cart.savedForLater.length;
  cart.set(
    'lines',
    cart.lines.filter((l) => l.lineKey !== lineKey),
  );
  cart.set(
    'savedForLater',
    cart.savedForLater.filter((l) => l.lineKey !== lineKey),
  );
  if (cart.lines.length + cart.savedForLater.length === before) {
    throw notFound('That item is not in your bag.');
  }

  await save(cart, owner);
  return priceOf(cart);
}

/** Moves a line between the bag and the set-aside list, in either direction. */
export async function moveLine(
  owner: CartOwner,
  lineKey: string,
  to: 'saved' | 'cart',
): Promise<PricedCart> {
  const cart = await findCart(owner);
  if (!cart) throw notFound('There is no cart to change.');

  const from = to === 'saved' ? 'lines' : 'savedForLater';
  const into = to === 'saved' ? 'savedForLater' : 'lines';

  const index = cart[from].findIndex((l) => l.lineKey === lineKey);
  if (index === -1) throw notFound('That item is not there.');

  const [moved] = cart[from].splice(index, 1);
  /* c8 ignore next */
  if (!moved) throw notFound('That item is not there.');

  // Never two copies: a line already present on the far side absorbs the move.
  if (!cart[into].some((l) => l.lineKey === lineKey)) cart[into].push(moved);

  await save(cart, owner);
  return priceOf(cart);
}

export async function clearCart(owner: CartOwner): Promise<PricedCart> {
  const cart = await findCart(owner);
  if (!cart) return emptyCart();

  cart.set('lines', []);
  // Saved items survive emptying the bag. "Clear my cart" is about the things being
  // bought now; deleting the set-aside list as well would destroy a second, separate
  // decision the shopper made and never asked to reverse.
  await save(cart, owner);
  return priceOf(cart);
}

async function save(cart: CartDoc, owner: CartOwner): Promise<void> {
  if ('guestKey' in owner) cart.expiresAt = guestExpiry();
  await cart.save();
}

/* ------------------------------------------------------------------- merge -- */

export type MergeSummary = {
  cart: PricedCart;
  rows: LineReport[];
  undoableUntil: string | null;
};

const UNDO_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Folds a guest cart into an account's, on sign-in.
 *
 * **Step one is the claim**, and it is the whole idempotency story: flipping the guest
 * cart from `active` to `merging` in a single guarded `findOneAndUpdate` means a second
 * delivery of the same sign-in — a replayed request, two tabs verifying at once, a
 * retry — finds nothing to claim and returns without doing anything. The same shape as
 * the order state machine in Phase 7, for the same reason.
 *
 * The claim happens *outside* the transaction below and the rest happens inside it. That
 * is deliberate: the claim must be visible to a concurrent caller immediately, which is
 * exactly what a transaction would prevent.
 */
export async function mergeGuestCart(
  userId: string,
  guestKey: string,
): Promise<MergeSummary | null> {
  const claimed = await Cart.findOneAndUpdate(
    { guestKeyHash: guestKey, status: 'active' },
    { $set: { status: 'merging' } },
    { new: true },
  );
  if (!claimed) return null;

  // Nothing in it. Retire the cart and skip the report — telling somebody "we combined
  // your carts: 0 changes" is noise about an event they did not notice.
  if (claimed.lines.length === 0 && claimed.savedForLater.length === 0) {
    claimed.status = 'merged';
    await claimed.save();
    return null;
  }

  const mine = await Cart.findOne({
    user: new mongoose.Types.ObjectId(userId),
    status: 'active',
  });

  const session = await mongoose.startSession();
  try {
    let summary: MergeSummary | null = null;

    await session.withTransaction(async () => {
      /**
       * No account cart at all: reassign the guest cart in place.
       *
       * No line arithmetic runs, so there is nothing to get wrong, and the document
       * keeps its `addedAt` timestamps. The plan calls this out separately for exactly
       * that reason — the common case should not go through the merge at all.
       */
      if (!mine) {
        claimed.user = new mongoose.Types.ObjectId(userId);
        claimed.guestKeyHash = null;
        claimed.status = 'active';
        claimed.expiresAt = null;
        await claimed.save({ session });
        summary = { cart: await priceOf(claimed), rows: [], undoableUntil: null };
        return;
      }

      const guest = toLines(claimed);
      const user = toLines(mine);

      const live = await loadLiveCatalogue([
        ...guest.lines.map((l) => l.lineKey),
        ...guest.savedForLater.map((l) => l.lineKey),
        ...user.lines.map((l) => l.lineKey),
        ...user.savedForLater.map((l) => l.lineKey),
      ]);

      const merged = mergeCarts({
        guestLines: guest.lines,
        guestSaved: guest.savedForLater,
        userLines: user.lines,
        userSaved: user.savedForLater,
        live,
      });

      const previousLines = mine.toObject().lines;
      const previousSaved = mine.toObject().savedForLater;

      mine.set('lines', merged.lines.map(toStored));
      mine.set('savedForLater', merged.savedForLater.map(toStored));
      mine.set('mergeReport', {
        mergedAt: new Date(),
        rows: merged.report,
        previousLines,
        previousSaved,
        undoableUntil: new Date(Date.now() + UNDO_WINDOW_MS),
        undoneAt: null,
      });
      await mine.save({ session });

      claimed.status = 'merged';
      claimed.set('lines', []);
      claimed.set('savedForLater', []);
      await claimed.save({ session });

      summary = {
        cart: await priceOf(mine),
        rows: merged.report,
        undoableUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString(),
      };
    });

    return summary;
  } finally {
    await session.endSession();
  }
}

/**
 * Puts the cart back the way it was before the last merge.
 *
 * Undo means undo: the account's own lines return and what the guest cart contributed
 * goes. That is a real loss, which is why the *report* is the primary repair — a shopper
 * who wanted 2 + 3 = 5 rather than MAX's 3 can see both numbers and type 5, without
 * discarding anything. Undo is for the person who did not want the merge at all.
 */
export async function undoMerge(userId: string): Promise<PricedCart> {
  const cart = await Cart.findOne({
    user: new mongoose.Types.ObjectId(userId),
    status: 'active',
  });
  if (!cart?.mergeReport) throw notFound('There is nothing to undo.');
  if (cart.mergeReport.undoneAt) throw conflict('That merge has already been undone.');
  if (cart.mergeReport.undoableUntil.getTime() < Date.now()) {
    throw badRequest('That merge is too old to undo.');
  }

  cart.set('lines', cart.mergeReport.previousLines);
  cart.set('savedForLater', cart.mergeReport.previousSaved);
  cart.set('mergeReport.undoneAt', new Date());
  await cart.save();

  return priceOf(cart);
}

/** Clears the merge report once the shopper has seen it. */
export async function dismissMergeReport(userId: string): Promise<void> {
  await Cart.updateOne(
    { user: new mongoose.Types.ObjectId(userId), status: 'active' },
    { $set: { mergeReport: null } },
  );
}

export async function readMergeReport(userId: string): Promise<MergeSummary | null> {
  const cart = await Cart.findOne({
    user: new mongoose.Types.ObjectId(userId),
    status: 'active',
  });
  if (!cart?.mergeReport || cart.mergeReport.undoneAt) return null;

  return {
    cart: await priceOf(cart),
    rows: cart.mergeReport.rows as LineReport[],
    undoableUntil: cart.mergeReport.undoableUntil.toISOString(),
  };
}

/* ------------------------------------------------------------------ helpers -- */

async function findVariant(productId: string, variantId: string) {
  const product = await Product.findOne({ _id: productId, status: 'active' })
    .select('title slug status variants images')
    .lean();
  if (!product) throw notFound('That item is not for sale.');

  const variant = product.variants.find((v) => String(v._id) === variantId);
  if (!variant || variant.status !== 'active') throw notFound('That option is not for sale.');

  const fallbackImage = product.images?.[0]?.publicId;
  const imagePublicId = variant.imagePublicIds?.[0] ?? fallbackImage;

  return {
    sku: variant.sku,
    title: product.title,
    slug: product.slug,
    axisValues: variant.axisValues.map((a) => ({ key: a.key, value: a.value })),
    ...(imagePublicId ? { imagePublicId } : {}),
    price: { amount: variant.price.amount, currency: variant.price.currency },
    available: variant.stock.available,
    backorderable: variant.stock.backorderable,
  };
}

type Snapshot = Awaited<ReturnType<typeof findVariant>>;

function snapshotOf(found: Snapshot) {
  return {
    sku: found.sku,
    title: found.title,
    slug: found.slug,
    axisValues: found.axisValues,
    ...(found.imagePublicId ? { imagePublicId: found.imagePublicId } : {}),
    unitPrice: found.price,
  };
}

/** The stored document, in the plain shape merge.ts and repricing.ts work in. */
function toLines(cart: CartDoc): { lines: CartLine[]; savedForLater: CartLine[] } {
  const object = cart.toObject();
  return {
    lines: object.lines.map(fromStored),
    savedForLater: object.savedForLater.map(fromStored),
  };
}

function fromStored(line: CartDoc['lines'][number]): CartLine {
  return {
    lineKey: line.lineKey,
    productId: String(line.product),
    variantId: String(line.variantId),
    sku: line.sku,
    title: line.title,
    slug: line.slug,
    axisValues: line.axisValues.map((a) => ({ key: a.key, value: a.value })),
    ...(line.imagePublicId ? { imagePublicId: line.imagePublicId } : {}),
    unitPrice: { amount: line.unitPrice.amount, currency: line.unitPrice.currency },
    quantity: line.quantity,
    addedAt: line.addedAt,
  };
}

function toStored(line: CartLine) {
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
    quantity: line.quantity,
    addedAt: line.addedAt,
  };
}

/**
 * Guest order claiming moved to `order/order.service.ts` in Phase 7, where the Order
 * model lives. The Phase 6 placeholder that stood here logged and returned; the hook it
 * was holding open is still the same one — the moment a guest becomes a person is the
 * moment both their cart and their history change hands.
 */
