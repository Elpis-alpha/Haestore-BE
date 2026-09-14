import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { Category } from './category.model.js';
import { Product } from './product.model.js';

const app = createApp();

describe('the sitemap feed', () => {
  it('lists live shelves and live products, and nothing a crawler should not index', async () => {
    const shelf = await Category.create({
      name: 'Beans',
      slug: 'beans',
      path: 'coffee-tea/beans',
      ancestors: [],
      depth: 1,
      order: 0,
    });
    await Category.create({
      name: 'Hidden',
      slug: 'hidden',
      path: 'hidden',
      ancestors: [],
      depth: 0,
      order: 0,
      status: 'hidden',
    });
    for (const [slug, status] of [
      ['on-sale', 'active'],
      ['unfinished', 'draft'],
      ['retired', 'archived'],
    ] as const) {
      await Product.create({
        title: slug,
        slug,
        category: shelf._id,
        categoryAncestors: [shelf._id],
        status,
      });
    }

    const res = await request(app).get('/api/catalog/sitemap').expect(200);
    const body = res.body as {
      data: {
        categories: { path: string; updatedAt: string }[];
        products: { slug: string; updatedAt: string }[];
      };
    };

    expect(body.data.categories.map((c) => c.path)).toEqual(['coffee-tea/beans']);
    expect(body.data.products.map((p) => p.slug)).toEqual(['on-sale']);
    expect(Object.keys(body.data.products[0]!).sort()).toEqual(['slug', 'updatedAt']);
    expect(Date.parse(body.data.products[0]!.updatedAt)).not.toBeNaN();
  });
});
