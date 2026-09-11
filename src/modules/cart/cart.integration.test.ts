import request from 'supertest';
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { redis } from '../../cache/redis.js';
import { clearOutbox, readOutbox } from '../../mail/dev-outbox.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { Product } from '../catalog/product.model.js';
import { Category } from '../catalog/category.model.js';
import { Cart } from './cart.model.js';
import { GUEST_COOKIE } from './guest-cookie.js';
import { lineKeyOf } from './line-key.js';

/**
 * The cart over HTTP, against a real replica set and a real Redis.
 *
 * The unit suites already prove the merge and the re-pricing branch by branch. What
 * only an integration test can prove is the part that spans systems: that a cookie is
 * issued at the right moment and never before, that a guest cart survives a sign-in and
 * arrives on the account, and that a merge delivered twice does not happen twice.
 */

const app = createApp();

type CartBody = {
  data: {
    lines: {
      lineKey: string;
      quantity: number;
      sellableQuantity: number;
      unitPrice: { amount: number };
      lineTotal: { amount: number };
      changes: { kind: string }[];
    }[];
    savedForLater: { lineKey: string }[];
    subtotal: { amount: number; currency: string };
    itemCount: number;
    needsAttention: boolean;
  };
};

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

function cookiesFrom(res: request.Response): string[] {
  const header: unknown = res.headers['set-cookie'];
  return Array.isArray(header) ? header.filter((v): v is string => typeof v === 'string') : [];
}

function cookieValue(res: request.Response, name: string): string | undefined {
  const found = cookiesFrom(res).find((value) => value.startsWith(`${name}=`));
  const parsed = found?.split(';')[0]?.split('=')[1];
  return parsed && parsed.length > 0 ? parsed : undefined;
}

/** True when the response tells the browser to throw the cookie away. */
function cleared(res: request.Response, name: string): boolean {
  const found = cookiesFrom(res).find((value) => value.startsWith(`${name}=`));
  return Boolean(found && /(^|;)\s*Expires=Thu, 01 Jan 1970/i.test(found));
}

async function seedProduct(
  overrides: {
    title?: string;
    status?: 'draft' | 'active' | 'archived';
    price?: number;
    available?: number;
    backorderable?: boolean;
    variantStatus?: 'active' | 'inactive';
  } = {},
) {
  const suffix = new mongoose.Types.ObjectId().toHexString().slice(-6);
  const category = await Category.create({
    name: 'Beans',
    slug: `beans-${suffix}`,
    // Unique per call: a test that seeds two products would otherwise collide on the
    // category's unique path, which reads as a cart failure and is not one.
    path: `coffee-tea/beans-${suffix}`,
    ancestors: [],
    depth: 0,
    order: 0,
  });

  const product = await Product.create({
    title: overrides.title ?? 'House Blend',
    slug: `house-blend-${suffix}`,
    category: category._id,
    categoryAncestors: [category._id],
    status: overrides.status ?? 'active',
    variantAxes: [],
    variants: [
      {
        sku: `SKU-${suffix}`.toUpperCase(),
        axisValues: [],
        price: { amount: overrides.price ?? 1800, currency: 'USD' },
        stock: {
          onHand: overrides.available ?? 10,
          reserved: 0,
          available: overrides.available ?? 10,
          lowStockThreshold: 3,
          backorderable: overrides.backorderable ?? false,
        },
        status: overrides.variantStatus ?? 'active',
        position: 0,
      },
    ],
    inStock: true,
  });

  const variant = product.variants[0];
  if (!variant) throw new Error('seed produced no variant');

  return {
    productId: String(product._id),
    variantId: String(variant._id),
    lineKey: lineKeyOf(String(product._id), String(variant._id)),
    product,
  };
}

function codeFromOutbox(email: string): string {
  const message = readOutbox().find((entry) => entry.to === email);
  if (!message) throw new Error(`No message was sent to ${email}`);
  const code = /\b(\d{6})\b/.exec(message.subject)?.[1];
  if (!code) throw new Error(`No code in: ${message.subject}`);
  return code;
}

/**
 * Signs in, optionally carrying a guest cookie so the merge runs.
 *
 * Returns the verify response as well as the session cookie, because several tests
 * assert on what that response did to the *other* cookie.
 */
async function signIn(email: string, guestCookie?: string) {
  await redis.del(`otp:cd:${email}`);
  clearOutbox();

  const requested = await request(app).post('/api/auth/otp/request').send({ email }).expect(202);
  const { challengeId } = bodyOf<{ data: { challengeId: string } }>(requested).data;

  const verify = request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId, code: codeFromOutbox(email) });
  if (guestCookie) verify.set('Cookie', guestCookie);

  const verified = await verify.expect(200);
  const sid = cookieValue(verified, SESSION_COOKIE);
  if (!sid) throw new Error('Verification set no session cookie');

  return { verified, session: `${SESSION_COOKIE}=${sid}` };
}

beforeEach(() => {
  clearOutbox();
});

describe('the guest cookie', () => {
  it('is not set by reading the cart', async () => {
    const res = await request(app).get('/api/cart').expect(200);

    // The whole point of setting it lazily: somebody who browses and leaves gets no
    // cookie, so there is no consent banner to write and no row in the collection.
    expect(cookieValue(res, GUEST_COOKIE)).toBeUndefined();
    expect(bodyOf<CartBody>(res).data.itemCount).toBe(0);
    expect(await Cart.countDocuments()).toBe(0);
  });

  it('is set by the first add-to-cart, and reused by the second', async () => {
    const { productId, variantId } = await seedProduct();

    const first = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 1 })
      .expect(201);

    const token = cookieValue(first, GUEST_COOKIE);
    expect(token).toBeDefined();

    const second = await request(app)
      .post('/api/cart/lines')
      .set('Cookie', `${GUEST_COOKIE}=${token}`)
      .send({ productId, variantId, quantity: 1 })
      .expect(201);

    expect(cookieValue(second, GUEST_COOKIE)).toBeUndefined();
    expect(await Cart.countDocuments()).toBe(1);
    expect(bodyOf<CartBody>(second).data.lines[0]?.quantity).toBe(2);
  });

  it('is stored hashed, never in the clear', async () => {
    const { productId, variantId } = await seedProduct();
    const res = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId })
      .expect(201);

    const token = cookieValue(res, GUEST_COOKIE);
    const cart = await Cart.findOne().lean();

    expect(cart?.guestKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cart?.guestKeyHash).not.toBe(token);
    // A database dump must not hand anybody a working cookie.
    expect(JSON.stringify(cart)).not.toContain(token);
  });

  it('carries the __Host- prefix and its attributes', async () => {
    const { productId, variantId } = await seedProduct();
    const res = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId })
      .expect(201);

    const raw = cookiesFrom(res).find((c) => c.startsWith(`${GUEST_COOKIE}=`)) ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('Path=/');
    // `__Host-` is rejected outright by the browser if a Domain is present, which is
    // the clause that stops a sibling origin planting one.
    expect(raw).not.toMatch(/Domain=/i);
  });

  it('gives the header a readable count alongside every cart response', async () => {
    const { productId, variantId } = await seedProduct();
    const res = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 3 })
      .expect(201);

    const raw = cookiesFrom(res).find((c) => c.startsWith('hae_bag=')) ?? '';
    expect(cookieValue(res, 'hae_bag')).toBe('3');
    // Deliberately readable by script: it is a number on your own screen, not a
    // credential, and reading it is how the header renders a badge without a round trip.
    expect(raw).not.toContain('HttpOnly');
  });
});

describe('adding to the bag', () => {
  it('prices from the catalogue and ignores anything the client sends', async () => {
    const { productId, variantId } = await seedProduct({ price: 1800 });

    const res = await request(app)
      .post('/api/cart/lines')
      // The 2022 app's worst defect was a route that believed the browser about money.
      // There is no field here to put a price in, so this is refused as unknown.
      .send({ productId, variantId, quantity: 1, unitPrice: { amount: 1, currency: 'USD' } })
      .expect(422);

    expect(bodyOf<{ error: { code: string } }>(res).error.code).toBe('VALIDATION_FAILED');
  });

  it('computes the line total by multiplying, and never stores it', async () => {
    const { productId, variantId } = await seedProduct({ price: 999 });

    const res = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 3 })
      .expect(201);

    expect(bodyOf<CartBody>(res).data.lines[0]?.lineTotal.amount).toBe(2997);
    expect(bodyOf<CartBody>(res).data.subtotal.amount).toBe(2997);

    const stored = await Cart.findOne().lean();
    const line = stored?.lines[0];
    expect(line?.unitPrice.amount).toBe(999);
    // The field that made the 2022 cart wrong does not exist here.
    expect(line).not.toHaveProperty('lineTotal');
    expect(line).not.toHaveProperty('total');
  });

  it('clamps to what is on the shelf rather than accepting the ask', async () => {
    const { productId, variantId } = await seedProduct({ available: 2 });

    const res = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 9 })
      .expect(201);

    expect(bodyOf<CartBody>(res).data.lines[0]?.quantity).toBe(2);
  });

  it('refuses a draft product', async () => {
    const { productId, variantId } = await seedProduct({ status: 'draft' });
    await request(app).post('/api/cart/lines').send({ productId, variantId }).expect(404);
  });

  it('refuses an inactive variant of a live product', async () => {
    const { productId, variantId } = await seedProduct({ variantStatus: 'inactive' });
    await request(app).post('/api/cart/lines').send({ productId, variantId }).expect(404);
  });

  it('refuses something sold out', async () => {
    const { productId, variantId } = await seedProduct({ available: 0 });
    await request(app).post('/api/cart/lines').send({ productId, variantId }).expect(409);
  });

  it('reserves nothing — the shelf is untouched', async () => {
    const { productId, variantId, product } = await seedProduct({ available: 10 });
    await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 4 })
      .expect(201);

    const after = await Product.findById(product._id).lean();
    // A cart that reserved would let anyone empty the shelves for free. Reservation is
    // checkout's, held against a real order.
    expect(after?.variants[0]?.stock.reserved).toBe(0);
    expect(after?.variants[0]?.stock.available).toBe(10);
  });
});

describe('changing the bag', () => {
  async function bagWithOneLine() {
    const seeded = await seedProduct();
    const res = await request(app)
      .post('/api/cart/lines')
      .send({ productId: seeded.productId, variantId: seeded.variantId, quantity: 2 })
      .expect(201);
    return { ...seeded, cookie: `${GUEST_COOKIE}=${cookieValue(res, GUEST_COOKIE)}` };
  }

  it('sets a quantity', async () => {
    const { lineKey, cookie } = await bagWithOneLine();
    const res = await request(app)
      .patch(`/api/cart/lines/${lineKey}`)
      .set('Cookie', cookie)
      .send({ quantity: 5 })
      .expect(200);

    expect(bodyOf<CartBody>(res).data.lines[0]?.quantity).toBe(5);
  });

  it('treats a quantity of zero as a removal', async () => {
    const { lineKey, cookie } = await bagWithOneLine();
    const res = await request(app)
      .patch(`/api/cart/lines/${lineKey}`)
      .set('Cookie', cookie)
      .send({ quantity: 0 })
      .expect(200);

    expect(bodyOf<CartBody>(res).data.lines).toHaveLength(0);
  });

  it('moves a line to saved-for-later and back', async () => {
    const { lineKey, cookie } = await bagWithOneLine();

    const saved = await request(app)
      .post(`/api/cart/lines/${lineKey}/move`)
      .set('Cookie', cookie)
      .send({ to: 'saved' })
      .expect(200);
    expect(bodyOf<CartBody>(saved).data.lines).toHaveLength(0);
    expect(bodyOf<CartBody>(saved).data.savedForLater).toHaveLength(1);
    // A saved line is not in the bag, so the badge must not count it.
    expect(bodyOf<CartBody>(saved).data.itemCount).toBe(0);

    const back = await request(app)
      .post(`/api/cart/lines/${lineKey}/move`)
      .set('Cookie', cookie)
      .send({ to: 'cart' })
      .expect(200);
    expect(bodyOf<CartBody>(back).data.lines).toHaveLength(1);
  });

  it('keeps saved items when the bag is emptied', async () => {
    const { lineKey, cookie } = await bagWithOneLine();
    await request(app)
      .post(`/api/cart/lines/${lineKey}/move`)
      .set('Cookie', cookie)
      .send({ to: 'saved' })
      .expect(200);

    const cleared = await request(app).delete('/api/cart').set('Cookie', cookie).expect(200);
    expect(bodyOf<CartBody>(cleared).data.savedForLater).toHaveLength(1);
  });

  it('refuses a line key that is not one of ours', async () => {
    const { cookie } = await bagWithOneLine();
    await request(app)
      .patch('/api/cart/lines/not-a-line-key')
      .set('Cookie', cookie)
      .send({ quantity: 1 })
      .expect(400);
  });

  it('answers 400 for a change with no cart behind it', async () => {
    const { lineKey } = await seedProduct();
    await request(app).patch(`/api/cart/lines/${lineKey}`).send({ quantity: 1 }).expect(400);
  });
});

describe('re-pricing on read', () => {
  it('shows the current price, and says what it was', async () => {
    const { productId, variantId, product } = await seedProduct({ price: 1800 });
    const added = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 2 })
      .expect(201);
    const cookie = `${GUEST_COOKIE}=${cookieValue(added, GUEST_COOKIE)}`;

    await Product.updateOne({ _id: product._id }, { $set: { 'variants.0.price.amount': 2000 } });

    const res = await request(app).get('/api/cart').set('Cookie', cookie).expect(200);
    const line = bodyOf<CartBody>(res).data.lines[0];

    expect(line?.unitPrice.amount).toBe(2000);
    expect(line?.lineTotal.amount).toBe(4000);
    expect(line?.changes).toContainEqual(expect.objectContaining({ kind: 'price_changed' }));
    expect(bodyOf<CartBody>(res).data.needsAttention).toBe(true);
  });

  it('keeps an archived product visible, named, and out of the total', async () => {
    const { productId, variantId, product } = await seedProduct();
    const added = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId })
      .expect(201);
    const cookie = `${GUEST_COOKIE}=${cookieValue(added, GUEST_COOKIE)}`;

    await Product.updateOne({ _id: product._id }, { $set: { status: 'archived' } });

    const res = await request(app).get('/api/cart').set('Cookie', cookie).expect(200);
    const line = bodyOf<CartBody>(res).data.lines[0];

    expect(line).toBeDefined();
    expect(line?.changes).toEqual([{ kind: 'dropped', reason: 'unavailable' }]);
    expect(bodyOf<CartBody>(res).data.subtotal.amount).toBe(0);
  });
});

describe('signing in with a guest cart', () => {
  it('reassigns the cart in place when the account has none', async () => {
    const { productId, variantId, lineKey } = await seedProduct();
    const added = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 2 })
      .expect(201);
    const guest = `${GUEST_COOKIE}=${cookieValue(added, GUEST_COOKIE)}`;

    const { verified, session } = await signIn('shopper@example.test', guest);

    // No merge report, because nothing was combined — telling somebody "we combined
    // your carts: 0 changes" is noise about an event they did not notice.
    expect(bodyOf<{ data: { mergeReport: boolean } }>(verified).data.mergeReport).toBe(true);
    expect(cleared(verified, GUEST_COOKIE)).toBe(true);

    const res = await request(app).get('/api/cart').set('Cookie', session).expect(200);
    expect(bodyOf<CartBody>(res).data.lines[0]?.lineKey).toBe(lineKey);
    expect(bodyOf<CartBody>(res).data.lines[0]?.quantity).toBe(2);

    // One cart, now owned by the account, with no guest key left on it.
    const carts = await Cart.find({ status: 'active' }).lean();
    expect(carts).toHaveLength(1);
    expect(carts[0]?.guestKeyHash).toBeNull();
    expect(carts[0]?.expiresAt).toBeNull();
  });

  it('takes the maximum on a collision and reports it', async () => {
    const { productId, variantId, lineKey } = await seedProduct({ available: 20 });

    // Signed in on this device first, with two.
    const { session } = await signIn('twice@example.test');
    await request(app)
      .post('/api/cart/lines')
      .set('Cookie', session)
      .send({ productId, variantId, quantity: 2 })
      .expect(201);

    // Then signed out, and added three as a guest.
    const guestAdd = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 3 })
      .expect(201);
    const guest = `${GUEST_COOKIE}=${cookieValue(guestAdd, GUEST_COOKIE)}`;

    const second = await signIn('twice@example.test', guest);

    const cart = await request(app).get('/api/cart').set('Cookie', second.session).expect(200);
    // Three, not five. SUM here is a silently doubled order the customer discovers at
    // the payment screen, or never.
    expect(bodyOf<CartBody>(cart).data.lines[0]?.quantity).toBe(3);

    const report = await request(app)
      .get('/api/cart/merge-report')
      .set('Cookie', second.session)
      .expect(200);
    const rows = bodyOf<{ data: { rows: { lineKey: string; changes: { kind: string }[] }[] } }>(
      report,
    ).data.rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lineKey).toBe(lineKey);
    expect(rows[0]?.changes).toContainEqual(
      expect.objectContaining({ kind: 'quantity_raised', from: 2, to: 3 }),
    );
  });

  it('is idempotent: a replayed merge does nothing', async () => {
    const { productId, variantId } = await seedProduct({ available: 20 });

    const { session } = await signIn('replay@example.test');
    await request(app)
      .post('/api/cart/lines')
      .set('Cookie', session)
      .send({ productId, variantId, quantity: 2 })
      .expect(201);

    const guestAdd = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 3 })
      .expect(201);
    const guestToken = cookieValue(guestAdd, GUEST_COOKIE);
    const guest = `${GUEST_COOKIE}=${guestToken}`;

    await signIn('replay@example.test', guest);
    // The same guest cookie presented at a second sign-in. The claim guard means there
    // is no longer an `active` cart under that key, so this finds nothing to merge —
    // which is the only reason a merge delivered twice cannot double a quantity.
    const third = await signIn('replay@example.test', guest);

    expect(bodyOf<{ data: { mergeReport: boolean } }>(third.verified).data.mergeReport).toBe(false);

    const cart = await request(app).get('/api/cart').set('Cookie', third.session).expect(200);
    expect(bodyOf<CartBody>(cart).data.lines[0]?.quantity).toBe(3);
  });

  it('does not let a stale guest cookie resurrect a merged cart', async () => {
    const { productId, variantId } = await seedProduct();
    const added = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 2 })
      .expect(201);
    const guest = `${GUEST_COOKIE}=${cookieValue(added, GUEST_COOKIE)}`;

    const { session } = await signIn('stale@example.test', guest);

    // A browser that kept the cookie anyway. A signed-in cart is found by the account,
    // never by the cookie, so the stale value changes nothing.
    const res = await request(app)
      .get('/api/cart')
      .set('Cookie', `${session}; ${guest}`)
      .expect(200);

    expect(bodyOf<CartBody>(res).data.lines).toHaveLength(1);
    expect(bodyOf<CartBody>(res).data.itemCount).toBe(2);
  });

  it('signs in normally when there is no guest cart at all', async () => {
    const { verified } = await signIn('plain@example.test');
    expect(bodyOf<{ data: { mergeReport: boolean } }>(verified).data.mergeReport).toBe(false);
  });

  it('moves an out-of-stock line to saved-for-later rather than deleting it', async () => {
    const { productId, variantId, product } = await seedProduct({ available: 5 });

    const { session } = await signIn('gone@example.test');
    await request(app)
      .post('/api/cart/lines')
      .set('Cookie', session)
      .send({ productId, variantId, quantity: 2 })
      .expect(201);

    const guestAdd = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 1 })
      .expect(201);
    const guest = `${GUEST_COOKIE}=${cookieValue(guestAdd, GUEST_COOKIE)}`;

    await Product.updateOne({ _id: product._id }, { $set: { 'variants.0.stock.available': 0 } });

    const second = await signIn('gone@example.test', guest);
    const cart = await request(app).get('/api/cart').set('Cookie', second.session).expect(200);

    expect(bodyOf<CartBody>(cart).data.lines).toHaveLength(0);
    expect(bodyOf<CartBody>(cart).data.savedForLater).toHaveLength(1);
  });

  it('undoes a merge back to the account’s own lines, once', async () => {
    const first = await seedProduct({ title: 'House Blend', available: 20 });
    const second = await seedProduct({ title: 'Celadon Bowl' });

    const { session } = await signIn('undo@example.test');
    await request(app)
      .post('/api/cart/lines')
      .set('Cookie', session)
      .send({ productId: first.productId, variantId: first.variantId, quantity: 1 })
      .expect(201);

    const guestAdd = await request(app)
      .post('/api/cart/lines')
      .send({ productId: second.productId, variantId: second.variantId, quantity: 1 })
      .expect(201);
    const guest = `${GUEST_COOKIE}=${cookieValue(guestAdd, GUEST_COOKIE)}`;

    const back = await signIn('undo@example.test', guest);

    const merged = await request(app).get('/api/cart').set('Cookie', back.session).expect(200);
    expect(bodyOf<CartBody>(merged).data.lines).toHaveLength(2);

    const undone = await request(app)
      .post('/api/cart/merge-report/undo')
      .set('Cookie', back.session)
      .expect(200);

    expect(bodyOf<CartBody>(undone).data.lines).toHaveLength(1);
    expect(bodyOf<CartBody>(undone).data.lines[0]?.lineKey).toBe(first.lineKey);

    // Once. A second undo would restore the same tombstone over whatever the shopper
    // has done since.
    await request(app).post('/api/cart/merge-report/undo').set('Cookie', back.session).expect(409);
  });

  it('dismisses the report', async () => {
    const { productId, variantId } = await seedProduct({ available: 20 });
    const { session } = await signIn('seen@example.test');
    await request(app)
      .post('/api/cart/lines')
      .set('Cookie', session)
      .send({ productId, variantId, quantity: 1 })
      .expect(201);

    const guestAdd = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 4 })
      .expect(201);
    const guest = `${GUEST_COOKIE}=${cookieValue(guestAdd, GUEST_COOKIE)}`;

    const back = await signIn('seen@example.test', guest);
    await request(app)
      .post('/api/cart/merge-report/dismiss')
      .set('Cookie', back.session)
      .expect(204);

    const report = await request(app)
      .get('/api/cart/merge-report')
      .set('Cookie', back.session)
      .expect(200);
    expect(bodyOf<{ data: unknown }>(report).data).toBeNull();
  });

  it('flags a waiting report in a readable cookie, and clears it on dismiss', async () => {
    const { productId, variantId } = await seedProduct({ available: 20 });
    const { session } = await signIn('flagged@example.test');
    await request(app)
      .post('/api/cart/lines')
      .set('Cookie', session)
      .send({ productId, variantId, quantity: 1 })
      .expect(201);

    const guestAdd = await request(app)
      .post('/api/cart/lines')
      .send({ productId, variantId, quantity: 4 })
      .expect(201);
    const guest = `${GUEST_COOKIE}=${cookieValue(guestAdd, GUEST_COOKIE)}`;

    const back = await signIn('flagged@example.test', guest);
    // The cart page asks for a report only when this says there is one. Without it the
    // page asked on every visit — a 401 for every signed-out shopper.
    expect(cookieValue(back.verified, 'hae_merge')).toBe('1');
    const raw = cookiesFrom(back.verified).find((c) => c.startsWith('hae_merge=')) ?? '';
    expect(raw).not.toContain('HttpOnly');

    const dismissed = await request(app)
      .post('/api/cart/merge-report/dismiss')
      .set('Cookie', back.session)
      .expect(204);
    expect(cleared(dismissed, 'hae_merge')).toBe(true);
  });

  it('corrects a stale flag on a read that finds nothing', async () => {
    const { session } = await signIn('stale-flag@example.test');
    const res = await request(app)
      .get('/api/cart/merge-report')
      .set('Cookie', `${session}; hae_merge=1`)
      .expect(200);

    expect(bodyOf<{ data: unknown }>(res).data).toBeNull();
    expect(cleared(res, 'hae_merge')).toBe(true);
  });

  it('does not flag a sign-in that merged nothing', async () => {
    const { verified } = await signIn('noflag@example.test');
    expect(cookieValue(verified, 'hae_merge')).toBeUndefined();
  });

  it('refuses the merge report to a signed-out caller', async () => {
    await request(app).get('/api/cart/merge-report').expect(401);
    await request(app).post('/api/cart/merge-report/undo').expect(401);
  });
});
