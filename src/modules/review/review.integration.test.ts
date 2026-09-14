import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { ADMIN_EMAIL, ORIGIN, signIn, type TestSession } from '../../test/sign-in.js';
import { SearchOutbox } from '../../search/outbox.model.js';
import { User } from '../auth/user.model.js';
import { Category } from '../catalog/category.model.js';
import { Product } from '../catalog/product.model.js';
import { Order } from '../order/order.model.js';
import { Review } from './review.model.js';

/**
 * Reviews against a real replica set: who may write one, what a write does to the product
 * and the index, and what moderation does to the average.
 */

const app = createApp();

type ProductFixture = { id: string; slug: string; variantId: mongoose.Types.ObjectId };

let seq = 0;
const tag = () => {
  seq += 1;
  return `${Date.now().toString(36).toUpperCase()}${seq}`;
};

async function seedProduct(status: 'active' | 'draft' = 'active'): Promise<ProductFixture> {
  const t = tag().toLowerCase();
  const category = await Category.create({
    name: `Bowls ${t}`,
    slug: `bowls-${t}`,
    path: `bowls-${t}`,
    ancestors: [],
    depth: 0,
    order: 0,
  });
  const product = await Product.create({
    title: 'Celadon bowl',
    slug: `celadon-bowl-${t}`,
    category: category._id,
    categoryAncestors: [category._id],
    status,
    variants: [
      {
        sku: `BWL-${t.toUpperCase()}`,
        axisValues: [{ key: 'glaze', value: 'celadon' }],
        price: { amount: 3400, currency: 'USD' },
        stock: { onHand: 10, reserved: 0, available: 10 },
        status: 'active',
        position: 0,
      },
    ],
    inStock: true,
  });
  return { id: String(product._id), slug: product.slug, variantId: product.variants[0]!._id };
}

/** An order of this product for this person, whose history is the statuses given, in order. */
async function orderFor(userId: string, product: ProductFixture, history: string[]) {
  return Order.create({
    orderNumber: `HAE-R${tag()}`,
    user: new mongoose.Types.ObjectId(userId),
    email: 'buyer@example.test',
    status: history[history.length - 1],
    lines: [
      {
        lineKey: `${product.id}_${String(product.variantId)}`,
        product: new mongoose.Types.ObjectId(product.id),
        variantId: product.variantId,
        sku: 'BWL',
        title: 'Celadon bowl',
        slug: product.slug,
        axisValues: [{ key: 'glaze', value: 'celadon' }],
        unitPrice: { amount: 3400, currency: 'USD' },
        quantity: 1,
      },
    ],
    totals: {
      subtotal: { amount: 3400, currency: 'USD' },
      grandTotal: { amount: 3400, currency: 'USD' },
    },
    shippingAddress: { name: 'A Buyer', line1: '1 Market Street', city: 'Town', country: 'IS' },
    payment: { provider: 'stripe' },
    history: history.map((status) => ({ status, at: new Date(), by: 'test' })),
  });
}

const DELIVERED = ['paid', 'processing', 'shipped', 'delivered'];

/** A signed-in person whose order of the product has reached them. */
async function buyer(product: ProductFixture, email: string, history = DELIVERED) {
  const session = await signIn(app, email);
  await orderFor(session.userId, product, history);
  return session;
}

const put = (session: TestSession, productId: string, body: object) =>
  request(app)
    .put(`/api/reviews/products/${productId}`)
    .set('Origin', ORIGIN)
    .set('Cookie', session.cookie)
    .send(body);

const ratingOf = async (productId: string) => {
  const product = await Product.findById(productId).select('ratingAverage ratingCount').lean();
  return { average: product!.ratingAverage, count: product!.ratingCount };
};

let admin: TestSession;
const adminPost = (path: string, body: object = {}) =>
  request(app).post(path).set('Origin', ORIGIN).set('Cookie', admin.cookie).send(body);

beforeEach(async () => {
  admin = await signIn(app, ADMIN_EMAIL);
});

describe('who may review', () => {
  it('asks a signed-out visitor to sign in', async () => {
    const product = await seedProduct();
    await request(app)
      .put(`/api/reviews/products/${product.id}`)
      .set('Origin', ORIGIN)
      .send({ rating: 5 })
      .expect(401);
  });

  it('refuses someone whose order has not reached them yet, and someone who never bought it', async () => {
    const product = await seedProduct();
    const onItsWay = await buyer(product, 'waiting@example.test', [
      'paid',
      'processing',
      'shipped',
    ]);
    const stranger = await signIn(app, 'stranger@example.test');

    const early = await put(onItsWay, product.id, { rating: 5 }).expect(403);
    expect((early.body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    await put(stranger, product.id, { rating: 1 }).expect(403);

    expect(await Review.countDocuments()).toBe(0);
    expect(await ratingOf(product.id)).toEqual({ average: 0, count: 0 });
  });

  it('counts an order returned after it was delivered, and not one refunded before it shipped', async () => {
    const product = await seedProduct();
    const returned = await buyer(product, 'returned@example.test', [...DELIVERED, 'refunded']);
    const neverSent = await buyer(product, 'never-sent@example.test', ['paid', 'refunded']);

    await put(returned, product.id, { rating: 2, body: 'Arrived cracked.' }).expect(200);
    await put(neverSent, product.id, { rating: 1 }).expect(403);
  });

  it('cannot review, or read the reviews of, a product that is not on sale', async () => {
    const product = await seedProduct('draft');
    const session = await buyer(product, 'draft@example.test');

    await put(session, product.id, { rating: 4 }).expect(404);
    await request(app).get(`/api/catalog/products/${product.slug}/reviews`).expect(404);
  });
});

describe('writing a review', () => {
  it('moves the product’s rating and records the reindex in the same write', async () => {
    const product = await seedProduct();
    const session = await buyer(product, 'ada@example.test');
    await User.updateOne({ _id: session.userId }, { $set: { name: 'Ada Lovelace' } });

    const res = await put(session, product.id, {
      rating: 4,
      title: 'Holds a morning',
      body: 'Heavier than it looks.',
    }).expect(200);

    const review = (res.body as { data: { review: Record<string, unknown> } }).data.review;
    expect(review).toMatchObject({
      rating: 4,
      title: 'Holds a morning',
      authorName: 'Ada L.',
      purchased: [{ key: 'glaze', value: 'celadon' }],
      status: 'published',
      hiddenReason: null,
      product: { id: product.id, onSale: true },
    });

    expect(await ratingOf(product.id)).toEqual({ average: 4, count: 1 });
    const rows = await SearchOutbox.find({ kind: 'product', entityId: product.id }).lean();
    expect(rows).toHaveLength(1);

    const stored = await Review.findOne().lean();
    const order = await Order.findOne({ user: session.userId }).lean();
    expect(String(stored!.order)).toBe(String(order!._id));
  });

  it('replaces the person’s earlier review rather than adding a second', async () => {
    const product = await seedProduct();
    const session = await buyer(product, 'second-thoughts@example.test');

    await put(session, product.id, { rating: 5, title: 'Lovely' }).expect(200);
    await Review.updateOne({}, { $set: { needsReview: false } });
    const res = await put(session, product.id, { rating: 2 }).expect(200);

    expect(await Review.countDocuments()).toBe(1);
    const stored = await Review.findOne().lean();
    expect(stored).toMatchObject({ rating: 2, needsReview: true });
    expect(stored!.title).toBeUndefined();
    expect(stored!.editedAt).toBeInstanceOf(Date);
    expect(
      (res.body as { data: { review: { editedAt: string | null } } }).data.review.editedAt,
    ).not.toBeNull();
    expect(await ratingOf(product.id)).toEqual({ average: 2, count: 1 });
  });

  it('averages across people, to two places', async () => {
    const product = await seedProduct();
    for (const [email, rating] of [
      ['one@example.test', 5],
      ['two@example.test', 4],
      ['three@example.test', 4],
    ] as const) {
      await put(await buyer(product, email), product.id, { rating }).expect(200);
    }
    expect(await ratingOf(product.id)).toEqual({ average: 4.33, count: 3 });
  });

  it('counts both of two first reviews that land on one product at once', async () => {
    const product = await seedProduct();
    const [first, second] = [
      await buyer(product, 'left@example.test'),
      await buyer(product, 'right@example.test'),
    ];

    const results = await Promise.all([
      put(first, product.id, { rating: 5 }),
      put(second, product.id, { rating: 3 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await ratingOf(product.id)).toEqual({ average: 4, count: 2 });
  });

  it('ends with one review when the same person saves twice at once', async () => {
    const product = await seedProduct();
    const session = await buyer(product, 'double-click@example.test');

    const results = await Promise.all([
      put(session, product.id, { rating: 4 }),
      put(session, product.id, { rating: 4 }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await Review.countDocuments()).toBe(1);
    expect(await ratingOf(product.id)).toEqual({ average: 4, count: 1 });
  });

  it('takes a deleted review’s star out of the average', async () => {
    const product = await seedProduct();
    const session = await buyer(product, 'changed-mind@example.test');
    await put(session, product.id, { rating: 1 }).expect(200);

    await request(app)
      .delete(`/api/reviews/products/${product.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookie)
      .expect(204);
    expect(await ratingOf(product.id)).toEqual({ average: 0, count: 0 });

    await request(app)
      .delete(`/api/reviews/products/${product.id}`)
      .set('Origin', ORIGIN)
      .set('Cookie', session.cookie)
      .expect(404);
  });
});

describe('the product page’s reviews', () => {
  it('shows published reviews with their summary, and nothing that identifies the account', async () => {
    const product = await seedProduct();
    const kind = await buyer(product, 'kind@example.test');
    const harsh = await buyer(product, 'harsh@example.test');
    await put(kind, product.id, { rating: 5, body: 'Perfect.' }).expect(200);
    await put(harsh, product.id, { rating: 2, body: 'Small.' }).expect(200);

    const res = await request(app)
      .get(`/api/catalog/products/${product.slug}/reviews`)
      .query({ sort: 'lowest' })
      .expect(200);
    const body = res.body as {
      data: Record<string, unknown>[];
      summary: {
        average: number;
        count: number;
        distribution: { rating: number; count: number }[];
      };
      page: { total: number };
    };

    expect(body.data.map((r) => r.rating)).toEqual([2, 5]);
    expect(body.summary).toMatchObject({ average: 3.5, count: 2 });
    expect(body.summary.distribution).toContainEqual({ rating: 5, count: 1 });
    expect(body.page.total).toBe(2);

    const text = JSON.stringify(body);
    expect(text).not.toContain('@example.test');
    expect(Object.keys(body.data[0]!).sort()).toEqual(
      ['authorName', 'body', 'createdAt', 'editedAt', 'id', 'purchased', 'rating'].sort(),
    );
  });
});

describe('the account’s review page', () => {
  it('offers what has been delivered and not yet reviewed, then lists what was written', async () => {
    const product = await seedProduct();
    const session = await buyer(product, 'reviewer@example.test');
    const mine = () =>
      request(app).get('/api/reviews/mine').set('Cookie', session.cookie).expect(200);

    type Mine = {
      data: { toWrite: { productId: string }[]; written: { product: { id: string } }[] };
    };
    const before = (await mine()).body as Mine;
    expect(before.data.toWrite.map((item) => item.productId)).toEqual([product.id]);
    expect(before.data.written).toEqual([]);

    await put(session, product.id, { rating: 4 }).expect(200);

    const after = (await mine()).body as Mine;
    expect(after.data.toWrite).toEqual([]);
    expect(after.data.written.map((r) => r.product.id)).toEqual([product.id]);
  });
});

describe('moderation', () => {
  it('hides a review from the page and the average, tells its author why, and can put it back', async () => {
    const product = await seedProduct();
    const fan = await buyer(product, 'fan@example.test');
    const troll = await buyer(product, 'troll@example.test');
    await put(fan, product.id, { rating: 5 }).expect(200);
    await put(troll, product.id, { rating: 1, body: 'Rude words.' }).expect(200);
    expect(await ratingOf(product.id)).toEqual({ average: 3, count: 2 });

    const trollReview = await Review.findOne({ user: troll.userId }).lean();
    const id = String(trollReview!._id);

    await adminPost(`/api/admin/reviews/${id}/hide`, { note: 'x' }).expect(422);
    await adminPost(`/api/admin/reviews/${id}/hide`, {
      note: 'Hidden for language. Rewrite it and we will read it again.',
    }).expect(200);

    expect(await ratingOf(product.id)).toEqual({ average: 5, count: 1 });
    const page = await request(app)
      .get(`/api/catalog/products/${product.slug}/reviews`)
      .expect(200);
    expect((page.body as { data: unknown[] }).data).toHaveLength(1);

    const authorView = await request(app)
      .get('/api/reviews/mine')
      .set('Cookie', troll.cookie)
      .expect(200);
    expect(
      (authorView.body as { data: { written: { status: string; hiddenReason: string }[] } }).data
        .written[0],
    ).toMatchObject({
      status: 'hidden',
      hiddenReason: 'Hidden for language. Rewrite it and we will read it again.',
    });

    const again = await adminPost(`/api/admin/reviews/${id}/hide`, { note: 'Twice' }).expect(409);
    expect((again.body as { error: { details: { status: string } } }).error.details.status).toBe(
      'hidden',
    );

    await adminPost(`/api/admin/reviews/${id}/restore`).expect(200);
    expect(await ratingOf(product.id)).toEqual({ average: 3, count: 2 });
  });

  it('puts an edited hidden review back in the queue without making it visible', async () => {
    const product = await seedProduct();
    const author = await buyer(product, 'edits@example.test');
    await put(author, product.id, { rating: 1, body: 'Rude words.' }).expect(200);
    const id = String((await Review.findOne().lean())!._id);
    await adminPost(`/api/admin/reviews/${id}/hide`, { note: 'Language.' }).expect(200);

    await put(author, product.id, { rating: 2, body: 'Better words.' }).expect(200);

    const stored = await Review.findById(id).lean();
    expect(stored).toMatchObject({ status: 'hidden', needsReview: true, rating: 2 });
    expect(await ratingOf(product.id)).toEqual({ average: 0, count: 0 });

    const queue = await request(app)
      .get('/api/admin/reviews')
      .query({ queue: 'unread' })
      .set('Cookie', admin.cookie)
      .expect(200);
    expect((queue.body as { data: { id: string; status: string }[] }).data).toEqual([
      expect.objectContaining({ id, status: 'hidden' }),
    ]);
  });

  it('marks a review read, which empties the dashboard line and changes nothing public', async () => {
    const product = await seedProduct();
    const author = await buyer(product, 'read-me@example.test');
    await put(author, product.id, { rating: 4 }).expect(200);
    const id = String((await Review.findOne().lean())!._id);

    const dashboard = () =>
      request(app).get('/api/admin/dashboard').set('Cookie', admin.cookie).expect(200);
    type Dash = {
      data: { reviews: { unread: { count: number; oldest: { productTitle: string }[] } } };
    };

    const before = (await dashboard()).body as Dash;
    expect(before.data.reviews.unread.count).toBe(1);
    expect(before.data.reviews.unread.oldest[0]?.productTitle).toBe('Celadon bowl');

    const kept = await adminPost(`/api/admin/reviews/${id}/keep`).expect(200);
    expect(
      (kept.body as { data: { review: { needsReview: boolean; status: string } } }).data.review,
    ).toMatchObject({
      needsReview: false,
      status: 'published',
    });
    await adminPost(`/api/admin/reviews/${id}/keep`).expect(409);

    expect(((await dashboard()).body as Dash).data.reviews.unread.count).toBe(0);
    expect(await ratingOf(product.id)).toEqual({ average: 4, count: 1 });
  });
});
