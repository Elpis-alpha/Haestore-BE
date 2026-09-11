import request from 'supertest';
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { redis } from '../../cache/redis.js';
import { clearOutbox, readOutbox } from '../../mail/dev-outbox.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { Category } from '../catalog/category.model.js';
import { Product } from '../catalog/product.model.js';
import { Wishlist } from './wishlist.model.js';

const app = createApp();

const bodyOf = <T>(res: { body: unknown }): T => res.body as T;

type ListBody = {
  data: {
    productId: string;
    variantId: string | null;
    lineKey: string | null;
    title: string;
    inStock: boolean;
    available: boolean;
  }[];
};

async function seedProduct(title = 'House Blend') {
  const suffix = new mongoose.Types.ObjectId().toHexString().slice(-6);
  const category = await Category.create({
    name: 'Beans',
    slug: `beans-${suffix}`,
    path: `coffee-tea/beans-${suffix}`,
    ancestors: [],
    depth: 0,
    order: 0,
  });

  const product = await Product.create({
    title,
    slug: `slug-${suffix}`,
    category: category._id,
    categoryAncestors: [category._id],
    status: 'active',
    variantAxes: [],
    variants: [
      {
        sku: `SKU-${suffix}`.toUpperCase(),
        axisValues: [],
        price: { amount: 1800, currency: 'USD' },
        stock: { onHand: 4, reserved: 0, available: 4, lowStockThreshold: 3, backorderable: false },
        status: 'active',
        position: 0,
      },
    ],
    priceRange: { min: 1800, max: 1800, currency: 'USD' },
    inStock: true,
  });

  const variant = product.variants[0];
  if (!variant) throw new Error('seed produced no variant');

  return { productId: String(product._id), variantId: String(variant._id), product };
}

async function signIn(email: string): Promise<string> {
  await redis.del(`otp:cd:${email}`);
  clearOutbox();

  const requested = await request(app).post('/api/auth/otp/request').send({ email }).expect(202);
  const { challengeId } = bodyOf<{ data: { challengeId: string } }>(requested).data;

  const message = readOutbox().find((entry) => entry.to === email);
  const code = message ? /\b(\d{6})\b/.exec(message.subject)?.[1] : undefined;
  if (!code) throw new Error(`No code for ${email}`);

  const verified = await request(app)
    .post('/api/auth/otp/verify')
    .send({ challengeId, code })
    .expect(200);

  const header: unknown = verified.headers['set-cookie'];
  const values = Array.isArray(header)
    ? header.filter((v): v is string => typeof v === 'string')
    : [];
  const sid = values
    .find((v) => v.startsWith(`${SESSION_COOKIE}=`))
    ?.split(';')[0]
    ?.split('=')[1];
  if (!sid) throw new Error('no session cookie');
  return `${SESSION_COOKIE}=${sid}`;
}

beforeEach(() => {
  clearOutbox();
});

describe('the wishlist', () => {
  it('requires an account, at every verb', async () => {
    // Not a gap. A wishlist promises to remember across devices and months, and a guest
    // cookie can keep neither promise — see wishlist.model.ts.
    await request(app).get('/api/wishlist').expect(401);
    await request(app).post('/api/wishlist').send({ productId: 'x' }).expect(401);
    await request(app).delete('/api/wishlist').send({ productId: 'x' }).expect(401);
  });

  it('adds a product, and adding it again is one wish', async () => {
    const cookie = await signIn('wisher@example.test');
    const { productId } = await seedProduct();

    await request(app).post('/api/wishlist').set('Cookie', cookie).send({ productId }).expect(201);
    const second = await request(app)
      .post('/api/wishlist')
      .set('Cookie', cookie)
      .send({ productId })
      .expect(201);

    expect(bodyOf<ListBody>(second).data).toHaveLength(1);
    const stored = await Wishlist.findOne().lean();
    expect(stored?.items).toHaveLength(1);
  });

  it('treats a product wish and a variant wish as different wishes', async () => {
    const cookie = await signIn('both@example.test');
    const { productId, variantId } = await seedProduct();

    await request(app).post('/api/wishlist').set('Cookie', cookie).send({ productId }).expect(201);
    const res = await request(app)
      .post('/api/wishlist')
      .set('Cookie', cookie)
      .send({ productId, variantId })
      .expect(201);

    expect(bodyOf<ListBody>(res).data).toHaveLength(2);
    // The variant wish carries a line key, so it can go straight into the bag.
    expect(bodyOf<ListBody>(res).data.find((e) => e.variantId)?.lineKey).toContain(productId);
    expect(bodyOf<ListBody>(res).data.find((e) => !e.variantId)?.lineKey).toBeNull();
  });

  it('reads price and stock live rather than from a snapshot', async () => {
    const cookie = await signIn('live@example.test');
    const { productId, variantId, product } = await seedProduct();

    await request(app)
      .post('/api/wishlist')
      .set('Cookie', cookie)
      .send({ productId, variantId })
      .expect(201);

    await Product.updateOne({ _id: product._id }, { $set: { 'variants.0.stock.available': 0 } });

    const res = await request(app).get('/api/wishlist').set('Cookie', cookie).expect(200);
    expect(bodyOf<ListBody>(res).data[0]?.inStock).toBe(false);
    // Out of stock is not the same as gone: this is still something the shop sells.
    expect(bodyOf<ListBody>(res).data[0]?.available).toBe(true);
  });

  it('marks an archived product unavailable without dropping it', async () => {
    const cookie = await signIn('archived@example.test');
    const { productId, product } = await seedProduct();

    await request(app).post('/api/wishlist').set('Cookie', cookie).send({ productId }).expect(201);
    await Product.updateOne({ _id: product._id }, { $set: { status: 'archived' } });

    const res = await request(app).get('/api/wishlist').set('Cookie', cookie).expect(200);
    expect(bodyOf<ListBody>(res).data[0]?.available).toBe(false);
  });

  it('removes only the wish that was named', async () => {
    const cookie = await signIn('remove@example.test');
    const { productId, variantId } = await seedProduct();

    await request(app).post('/api/wishlist').set('Cookie', cookie).send({ productId }).expect(201);
    await request(app)
      .post('/api/wishlist')
      .set('Cookie', cookie)
      .send({ productId, variantId })
      .expect(201);

    const res = await request(app)
      .delete('/api/wishlist')
      .set('Cookie', cookie)
      .send({ productId, variantId })
      .expect(200);

    expect(bodyOf<ListBody>(res).data).toHaveLength(1);
    expect(bodyOf<ListBody>(res).data[0]?.variantId).toBeNull();
  });

  it('refuses a product that does not exist', async () => {
    const cookie = await signIn('missing@example.test');
    await request(app)
      .post('/api/wishlist')
      .set('Cookie', cookie)
      .send({ productId: new mongoose.Types.ObjectId().toHexString() })
      .expect(404);
  });

  it('keeps two accounts apart', async () => {
    const mine = await signIn('mine@example.test');
    const theirs = await signIn('theirs@example.test');
    const { productId } = await seedProduct();

    await request(app).post('/api/wishlist').set('Cookie', mine).send({ productId }).expect(201);

    const res = await request(app).get('/api/wishlist').set('Cookie', theirs).expect(200);
    expect(bodyOf<ListBody>(res).data).toEqual([]);
  });
});
