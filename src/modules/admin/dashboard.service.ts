import { Order } from '../order/order.model.js';
import { STUCK_PAYMENT_AFTER_MS } from '../order/admin-order.presenter.js';
import { Product } from '../catalog/product.model.js';
import { StorefrontLayout } from '../storefront/storefront.model.js';

const PAID_STATES = ['paid', 'processing', 'shipped', 'delivered'];
const REVENUE_WINDOW_DAYS = 30;

/**
 * What needs a person today.
 *
 * Every figure here is a queue somebody can work down, not a vanity number: orders to
 * pack, payments that look stranded, products the lenient validator flagged, variants
 * running low. Revenue is the one exception and it is last, because a shop owner opening
 * the console wants to know what to do before they want to know how it is going.
 *
 * All read-only and all bounded — every list is capped and every count uses an index
 * built for it (`{status, createdAt}` on orders, the partial `needsAttention` index on
 * products). The low-stock pass is the one scan, over active products only.
 */
export async function dashboardSummary(now = new Date()) {
  const stuckBefore = new Date(now.getTime() - STUCK_PAYMENT_AFTER_MS);
  const since = new Date(now.getTime() - REVENUE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const stuckFilter = {
    status: 'pending_payment',
    'payment.intentId': { $type: 'string' },
    createdAt: { $lte: stuckBefore },
  };

  const [
    toFulfil,
    stuckCount,
    stuck,
    attentionCount,
    attention,
    lowStock,
    revenue,
    draft,
    published,
  ] = await Promise.all([
    Order.countDocuments({ status: { $in: ['paid', 'processing'] } }),
    Order.countDocuments(stuckFilter),
    Order.find(stuckFilter)
      .sort({ createdAt: 1 })
      .limit(5)
      .select('orderNumber email createdAt totals.grandTotal payment.provider')
      .lean(),
    Product.countDocuments({ needsAttention: true }),
    Product.find({ needsAttention: true })
      .sort({ updatedAt: -1 })
      .limit(5)
      .select('title validationIssues updatedAt')
      .lean(),
    Product.aggregate<{
      _id: unknown;
      title: string;
      sku: string;
      available: number;
      threshold: number;
    }>([
      { $match: { status: 'active' } },
      { $unwind: '$variants' },
      {
        $match: {
          'variants.status': 'active',
          'variants.stock.backorderable': { $ne: true },
          $expr: { $lte: ['$variants.stock.available', '$variants.stock.lowStockThreshold'] },
        },
      },
      { $sort: { 'variants.stock.available': 1, title: 1 } },
      { $limit: 8 },
      {
        $project: {
          title: 1,
          sku: '$variants.sku',
          available: '$variants.stock.available',
          threshold: '$variants.stock.lowStockThreshold',
        },
      },
    ]),
    Order.aggregate<{ _id: string; amount: number; orders: number }>([
      { $match: { paidAt: { $gte: since }, status: { $in: PAID_STATES } } },
      {
        $group: {
          _id: '$totals.grandTotal.currency',
          amount: { $sum: '$totals.grandTotal.amount' },
          orders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    StorefrontLayout.findOne({ handle: 'home', status: 'draft' })
      .select('version updatedAt')
      .lean(),
    StorefrontLayout.findOne({ handle: 'home', status: 'published' })
      .select('version publishedAt')
      .lean(),
  ]);

  return {
    orders: {
      toFulfil,
      stuckPayments: {
        count: stuckCount,
        oldest: stuck.map((order) => ({
          id: String(order._id),
          orderNumber: order.orderNumber,
          email: order.email,
          provider: order.payment.provider,
          grandTotal: order.totals.grandTotal,
          placedAt: order.createdAt.toISOString(),
        })),
      },
    },
    catalogue: {
      needsAttention: {
        count: attentionCount,
        recent: attention.map((product) => ({
          id: String(product._id),
          title: product.title,
          issues: product.validationIssues.map((issue) => issue.message),
        })),
      },
      lowStock: lowStock.map((row) => ({
        productId: String(row._id),
        title: row.title,
        sku: row.sku,
        available: row.available,
        threshold: row.threshold,
      })),
    },
    revenue: {
      windowDays: REVENUE_WINDOW_DAYS,
      /**
       * One row per currency, never summed across them. Refunded orders are excluded
       * entirely, so this is money taken and kept, by the admin's own records.
       */
      byCurrency: revenue.map((row) => ({
        currency: row._id,
        amount: row.amount,
        orders: row.orders,
      })),
    },
    storefront: {
      publishedVersion: published?.version ?? null,
      publishedAt: published?.publishedAt ? published.publishedAt.toISOString() : null,
      draftVersion: draft?.version ?? null,
      draftUpdatedAt: draft?.updatedAt ? draft.updatedAt.toISOString() : null,
    },
  };
}
