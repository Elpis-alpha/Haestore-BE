import { z } from 'zod';
import { ORDER_STATUSES } from './order-status.js';

export const adminOrderListQuerySchema = z.strictObject({
  status: z.enum(ORDER_STATUSES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

/**
 * The forward path. `paid` is deliberately not a target: an order becomes paid when a
 * provider says so, through `markOrderPaid`, and the admin's way to ask is `reconcile`.
 */
export const advanceOrderSchema = z.object({
  to: z.enum(['processing', 'shipped', 'delivered']),
  note: z.string().trim().max(500).optional(),
});

export const cancelOrderSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const refundOrderSchema = z.object({
  note: z
    .string()
    .trim()
    .min(3, 'Say where the money was returned — this records a refund, it does not issue one.')
    .max(500),
});

export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;
export type AdvanceOrderInput = z.infer<typeof advanceOrderSchema>;
