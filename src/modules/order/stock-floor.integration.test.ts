import type mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { Category } from '../catalog/category.model.js';
import { Product } from '../catalog/product.model.js';
import { consumeAll, reserveAll } from '../checkout/reservation.js';
import { Order } from './order.model.js';
import { shipOrder } from './order.service.js';

/**
 * Shipping against a shelf count that an admin corrected below what orders already hold.
 *
 * Phase 8 noted that `consumeAll`'s `$inc` could drive `onHand` below zero, because an
 * update does not run the schema's `min: 0` — and a product holding a negative count then
 * fails validation on its next save, which locks the admin out of the very correction that
 * is needed.
 */

async function seed(onHand: number, quantity: number) {
  const category = await Category.create({
    name: 'Tins',
    slug: `tins-${Date.now()}`,
    path: `tins-${Date.now()}`,
    ancestors: [],
    depth: 0,
    order: 0,
  });
  const product = await Product.create({
    title: 'Tea tin',
    slug: `tea-tin-${Date.now()}`,
    category: category._id,
    categoryAncestors: [category._id],
    status: 'active',
    variants: [
      {
        sku: `TIN-${Date.now()}`,
        price: { amount: 900, currency: 'USD' },
        stock: { onHand, reserved: 0, available: onHand },
        status: 'active',
        position: 0,
      },
    ],
    inStock: true,
  });
  const variant = product.variants[0]!;
  const request = { productId: String(product._id), variantId: String(variant._id), quantity };
  expect((await reserveAll([request])).ok).toBe(true);

  const order = await Order.create({
    orderNumber: `HAE-F${Date.now().toString(36).toUpperCase().slice(-7)}`,
    email: 'tins@example.test',
    status: 'processing',
    lines: [
      {
        lineKey: 'k',
        product: product._id,
        variantId: variant._id,
        sku: variant.sku,
        title: 'Tea tin',
        slug: product.slug,
        unitPrice: { amount: 900, currency: 'USD' },
        quantity,
      },
    ],
    totals: {
      subtotal: { amount: 900 * quantity, currency: 'USD' },
      grandTotal: { amount: 900 * quantity, currency: 'USD' },
    },
    shippingAddress: { name: 'X', line1: '1 St', city: 'Town', country: 'IS' },
    payment: { provider: 'stripe' },
    stockReserved: true,
    history: [{ status: 'processing', at: new Date(), by: 'test' }],
  });

  return { product, request, order };
}

const stockOf = async (id: mongoose.Types.ObjectId) =>
  (await Product.findById(id).lean())!.variants[0]!.stock;

describe('shipping below the shelf count', () => {
  it('ships, floors the counts at zero, and leaves the product editable', async () => {
    const { product, order } = await seed(5, 3);
    // The admin counts the shelf and finds two, although three are held for this order.
    await Product.updateOne(
      { _id: product._id },
      { $set: { 'variants.0.stock.onHand': 2, 'variants.0.stock.available': 0 } },
    );

    const result = await shipOrder(order._id, 'admin:test');
    expect(result.moved).toBe(true);

    expect(await stockOf(product._id)).toMatchObject({ onHand: 0, reserved: 0, available: 0 });
    const reloaded = await Product.findById(product._id);
    await expect(reloaded!.validate()).resolves.toBeUndefined();
  });

  it('reports the shortfall rather than hiding it, and consumes normally when the shelf can afford it', async () => {
    const short = await seed(4, 3);
    await Product.updateOne({ _id: short.product._id }, { $set: { 'variants.0.stock.onHand': 1 } });
    const shortfalls = await consumeAll([short.request]);
    expect(shortfalls).toEqual([expect.objectContaining({ quantity: 3, onHand: 1, reserved: 3 })]);

    const plenty = await seed(10, 2);
    expect(await consumeAll([plenty.request])).toEqual([]);
    expect(await stockOf(plenty.product._id)).toMatchObject({
      onHand: 8,
      reserved: 0,
      available: 8,
    });
  });
});
