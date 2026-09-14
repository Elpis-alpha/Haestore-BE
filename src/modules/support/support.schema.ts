import { z } from 'zod';
import { MESSAGE_MAX_LENGTH, TICKET_STATUSES } from './support-ticket.model.js';

/**
 * Opening a conversation. No email field and no name: the address is the account's, which
 * is the one thing about this form that cannot be typed wrongly or typed as someone else.
 */
export const openTicketSchema = z.strictObject({
  subject: z.string().trim().min(3, 'Give it a subject a few words long.').max(160),
  body: z
    .string()
    .trim()
    .min(10, 'Tell us a little more — a sentence or two helps us answer the first time.')
    .max(MESSAGE_MAX_LENGTH),
  orderNumber: z.string().trim().max(24).optional(),
});

export const replySchema = z.strictObject({
  body: z.string().trim().min(1, 'Write something to send.').max(MESSAGE_MAX_LENGTH),
});

/** A reply from behind the counter may close the conversation in the same step. */
export const staffReplySchema = z.strictObject({
  body: z.string().trim().min(1, 'Write something to send.').max(MESSAGE_MAX_LENGTH),
  close: z.boolean().default(false),
});

export const ticketListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

export const adminTicketQuerySchema = z.strictObject({
  status: z.enum(TICKET_STATUSES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

export type OpenTicketInput = z.infer<typeof openTicketSchema>;
export type StaffReplyInput = z.infer<typeof staffReplySchema>;
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
export type AdminTicketQuery = z.infer<typeof adminTicketQuerySchema>;
