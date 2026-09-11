import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireSession } from '../../middleware/session.js';
import { validateQuery, query } from '../../middleware/validate.js';
import { notFound } from '../../lib/errors.js';
import { listOrdersForUser } from './order.service.js';
import { Order } from './order.model.js';
import { toOrderResponse } from './order.presenter.js';
import { normaliseOrderNumber } from './order-number.js';

export const orderRouter: Router = Router();

/**
 * Order history.
 *
 * `requireSession` is mounted once at the top of the router rather than per handler —
 * the Phase 2 precedent. Everything below belongs to an account: a guest reads their
 * one order through the checkout router's claim-token route instead, because that is a
 * different kind of authorisation and mixing the two in one handler is how one of them
 * ends up optional.
 */
orderRouter.use(requireSession);

const listQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  /**
   * Capped, like every list endpoint in this codebase. The 2022 app had no maximum page
   * size anywhere, so `?limit=100000` was a denial of service anyone could type.
   */
  perPage: z.coerce.number().int().min(1).max(60).default(12),
});

orderRouter.get('/', validateQuery(listQuerySchema), async (req: Request, res: Response) => {
  const { page, perPage } = query<z.infer<typeof listQuerySchema>>(req);
  const result = await listOrdersForUser(req.auth!.userId, { page, perPage });

  res.json({
    data: result.orders.map((order) => toOrderResponse(order as never)),
    page: {
      page: result.page,
      perPage: result.perPage,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
});

orderRouter.get('/:orderNumber', async (req: Request, res: Response) => {
  const order = await Order.findOne({
    orderNumber: normaliseOrderNumber(String(req.params.orderNumber)),
    user: req.auth!.userId,
  });
  // Scoped to the caller in the query itself, so "not yours" and "does not exist" are
  // the same answer without a second check that could be forgotten.
  if (!order) throw notFound('Order not found.');

  res.json({ data: { order: toOrderResponse(order) } });
});
