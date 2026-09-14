import { Router, type Request } from 'express';
import { requireStepUp } from '../../middleware/session.js';
import { body, idParam, query, validateBody, validateQuery } from '../../middleware/validate.js';
import { conflict, notFound, serviceUnavailable } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { reconcileOrderWithProvider } from '../payments/reconcile.js';
import { ADMIN_CANCELABLE_FROM } from './order-status.js';
import { Order } from './order.model.js';
import {
  cancelOrder,
  getOrderById,
  listOrdersForAdmin,
  recordRefund,
  shipOrder,
  transition,
  type TransitionResult,
} from './order.service.js';
import { toAdminOrderResponse, toAdminOrderSummary } from './admin-order.presenter.js';
import {
  adminOrderListQuerySchema,
  advanceOrderSchema,
  cancelOrderSchema,
  refundOrderSchema,
  type AdminOrderListQuery,
  type AdvanceOrderInput,
} from './admin-order.schema.js';

/**
 * Orders, from behind the counter.
 *
 * Mounted under the admin router, which applies `requireRole('admin')` and the audit
 * middleware once for everything beneath it. Nothing here re-checks either.
 *
 * Every mutation is a thin call into order.service.ts, and every one of them is a guarded
 * write — so a double-click, two admins on one order, or an admin racing a webhook all
 * resolve the same way a replayed webhook does: one of them moves the order and the other
 * is told it already moved.
 */
export const adminOrderRouter: Router = Router();

/** Recorded in the order's own history, so the history says who did it without a join. */
const actor = (req: Request) => `admin:${req.auth?.userId ?? 'unknown'}`;

/**
 * Turns a guarded write's answer into a response.
 *
 * A refused transition is a 409 carrying the order's current status, because the most
 * likely reason is that someone else — another admin, the sweeper, a webhook — moved it
 * while this person was looking at a stale page. The console reloads on a 409 rather
 * than showing an error it cannot explain.
 */
async function settle(result: TransitionResult, id: string, verb: string) {
  if (result.moved) return { order: toAdminOrderResponse(result.order) };
  if (result.reason === 'not_found') throw notFound('Order not found.');

  const current = await Order.findById(id).select('status').lean();
  throw conflict(`This order is ${current?.status ?? 'in another state'} and cannot be ${verb}.`, {
    status: current?.status ?? null,
  });
}

adminOrderRouter.get('/', validateQuery(adminOrderListQuerySchema), async (req, res) => {
  const { status, q, page, perPage } = query<AdminOrderListQuery>(req);
  const result = await listOrdersForAdmin({
    ...(status ? { status } : {}),
    ...(q ? { q } : {}),
    page,
    perPage,
  });

  res.json({
    data: result.orders.map(toAdminOrderSummary),
    page: {
      page: result.page,
      perPage: result.perPage,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
});

adminOrderRouter.get('/:id', async (req, res) => {
  const order = await getOrderById(idParam(req));
  res.json({ data: { order: toAdminOrderResponse(order) } });
});

/**
 * Forward along the machine: processing, shipped, delivered.
 *
 * Shipping is not a plain transition, because it is where reserved stock stops being a
 * hold — see `shipOrder`. The other two only move the status.
 */
adminOrderRouter.post('/:id/status', validateBody(advanceOrderSchema), async (req, res) => {
  const id = idParam(req);
  const { to, note } = body<AdvanceOrderInput>(req);

  const result =
    to === 'shipped'
      ? await shipOrder(id, actor(req), note)
      : await transition(id, to, actor(req), note);

  res.json({ data: await settle(result, id, `moved to ${to}`) });
});

/**
 * Cancel, before money has moved. Behind step-up, because it cannot be undone.
 *
 * The narrowing to `pending_payment` travels into the query filter through `from` — see
 * `ADMIN_CANCELABLE_FROM` for why a paid order is refunded instead.
 */
adminOrderRouter.post(
  '/:id/cancel',
  requireStepUp(),
  validateBody(cancelOrderSchema),
  async (req, res) => {
    const id = idParam(req);
    const { note } = body<{ note?: string }>(req);
    const result = await cancelOrder(id, actor(req), note ?? 'canceled by an admin', {
      from: ADMIN_CANCELABLE_FROM,
    });
    res.json({ data: await settle(result, id, 'canceled') });
  },
);

/** Record a refund issued in the provider's dashboard. Step-up: `refunded` is terminal. */
adminOrderRouter.post(
  '/:id/refund',
  requireStepUp(),
  validateBody(refundOrderSchema),
  async (req, res) => {
    const id = idParam(req);
    const { note } = body<{ note: string }>(req);
    const result = await recordRefund(id, actor(req), note);
    res.json({ data: await settle(result, id, 'refunded') });
  },
);

/**
 * The repair button for an order stranded by a lost webhook.
 *
 * Phase 7 built `reconcileOrderWithProvider` as the return page's path and noted it was
 * also this. It is the same function with a different `by`: it asks the provider, runs
 * the same checks, and funnels into the same `markOrderPaid` — so pressing it on an order
 * that is already paid, or twice, does nothing, and pressing it on one whose payment never
 * went through says so rather than paying it.
 */
adminOrderRouter.post('/:id/reconcile', async (req, res) => {
  const id = idParam(req);
  const order = await getOrderById(id);

  let outcome: string;
  let reason: string | null = null;
  try {
    const result = await reconcileOrderWithProvider(order, actor(req));
    outcome = result.outcome;
    if (result.outcome === 'nothing_to_do') reason = result.reason;
    if (result.outcome === 'amount_mismatch') {
      reason = `The provider reports ${result.actual.amount} ${result.actual.currency}; the order is ${result.expected.amount} ${result.expected.currency}.`;
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, orderId: id },
      'admin: reconcile could not reach the provider',
    );
    throw serviceUnavailable('The payment provider did not answer. Try again in a moment.', err);
  }

  const fresh = await getOrderById(id);
  res.json({ data: { outcome, reason, order: toAdminOrderResponse(fresh) } });
});
