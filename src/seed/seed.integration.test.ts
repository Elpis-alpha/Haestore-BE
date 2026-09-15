import { describe, expect, it } from 'vitest';
import { Product } from '../modules/catalog/product.model.js';
import { OrderOutbox } from '../modules/order/order-outbox.model.js';
import { Order } from '../modules/order/order.model.js';
import { Review } from '../modules/review/review.model.js';
import { ratingScore, summariseRatings } from '../modules/review/review-rules.js';
import { StorefrontLayout } from '../modules/storefront/storefront.model.js';
import { SupportTicket } from '../modules/support/support-ticket.model.js';
import { PRODUCTS } from './catalogue/index.js';
import { runSeed, SeedRefused } from './seed.js';

/**
 * The seeded shop, checked against itself.
 *
 * The seed writes through the services, so the claim worth testing is not that records
 * exist but that every figure the services derived agrees with the facts beneath it — a
 * product's rating with its reviews, a variant's stock with the orders holding it — after
 * five months of invented trade and the dates moved underneath it.
 */

const NOW = new Date('2026-09-01T12:00:00Z');
const quick = { reindex: false, reportDownloads: false, now: NOW } as const;

describe('the seed', () => {
  it('builds a shop whose derived figures agree with its facts', { timeout: 240_000 }, async () => {
    const report = await runSeed({ ...quick, orders: 60 });

    const products = await Product.find().lean();
    expect(products).toHaveLength(PRODUCTS.length);
    expect(report.products.draft).toBe(1);

    // Every live product is valid for its shelf; the one draft is flagged for its missing roast.
    const live = products.filter((p) => p.status === 'active');
    expect(live.filter((p) => p.needsAttention).map((p) => p.title)).toEqual([]);
    const draft = products.find((p) => p.status === 'draft')!;
    expect(draft.validationIssues.map((i) => i.key)).toEqual(['roast']);

    // Photographs are hotlinked and credited as Unsplash's guidelines ask.
    expect(live.every((p) => p.images.length > 0)).toBe(true);
    for (const image of live.flatMap((p) => p.images)) {
      expect(image.publicId).toMatch(/^https:\/\/images\.unsplash\.com\/photo-/);
      expect(image.blurDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(image.credit?.source).toBe('Unsplash');
      expect(image.credit?.authorUrl).toMatch(/utm_source=.+&utm_medium=referral$/);
    }

    // Ratings are exactly what the published reviews say.
    const reviews = await Review.find().lean();
    for (const product of products) {
      const counts = new Map<number, number>();
      for (const review of reviews) {
        if (String(review.product) !== String(product._id) || review.status !== 'published')
          continue;
        counts.set(review.rating, (counts.get(review.rating) ?? 0) + 1);
      }
      const summary = summariseRatings([...counts].map(([rating, count]) => ({ rating, count })));
      expect(product.ratingCount, product.title).toBe(summary.count);
      expect(product.ratingAverage, product.title).toBe(summary.average);
      expect(product.ratingScore, product.title).toBe(ratingScore(summary.average, summary.count));
    }

    // Stock held is exactly what unshipped orders hold, and nothing went missing.
    const orders = await Order.find().lean();
    const held = new Map<string, number>();
    for (const order of orders.filter((o) => o.stockReserved)) {
      for (const line of order.lines) {
        held.set(String(line.variantId), (held.get(String(line.variantId)) ?? 0) + line.quantity);
      }
    }
    for (const variant of products.flatMap((p) => p.variants)) {
      expect(variant.stock.reserved).toBe(held.get(String(variant._id)) ?? 0);
      expect(variant.stock.available + variant.stock.reserved).toBe(variant.stock.onHand);
    }

    // Every review comes from its author's own delivered order, written after the delivery.
    for (const review of reviews) {
      const order = orders.find((o) => String(o._id) === String(review.order))!;
      expect(String(order.user)).toBe(String(review.user));
      const delivered = order.history.find((h) => h.status === 'delivered');
      expect(delivered).toBeDefined();
      expect(review.createdAt.getTime()).toBeGreaterThan(delivered!.at.getTime());
    }

    // History runs forwards and stops at "now".
    for (const order of orders) {
      const times = order.history.map((h) => h.at.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(Math.max(...times)).toBeLessThanOrEqual(NOW.getTime());
    }
    expect(new Set(orders.map((o) => o.status))).toEqual(
      new Set(['paid', 'processing', 'shipped', 'delivered']),
    );

    // Nothing seeded owes anyone an email.
    expect(await OrderOutbox.countDocuments({ processedAt: null })).toBe(0);

    // The moments the demo depends on.
    const kivu = products.find((p) => p.title === 'Kivu Honey, small lot')!;
    const espresso = products.find((p) => p.title === 'The House Espresso')!;
    expect(kivu.ratingAverage).toBe(5);
    expect(espresso.ratingCount).toBeGreaterThan(kivu.ratingCount);
    expect(espresso.ratingScore).toBeGreaterThan(kivu.ratingScore);
    expect(await Review.countDocuments({ status: 'hidden' })).toBe(1);
    expect(await SupportTicket.countDocuments({ status: 'open' })).toBe(2);
    expect(await SupportTicket.countDocuments({ status: 'closed' })).toBe(1);
    expect(await StorefrontLayout.countDocuments({ status: 'published' })).toBe(1);
  });

  it(
    'refuses a database that already has a shop in it, unless told to replace it',
    { timeout: 240_000 },
    async () => {
      await runSeed({ ...quick, orders: 0 });
      await expect(runSeed({ ...quick, orders: 0 })).rejects.toBeInstanceOf(SeedRefused);

      await runSeed({ ...quick, orders: 0, reset: true });
      expect(await Product.countDocuments()).toBe(PRODUCTS.length);
      expect(await StorefrontLayout.countDocuments({ status: 'published' })).toBe(1);
    },
  );
});
