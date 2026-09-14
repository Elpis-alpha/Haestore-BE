import { z } from 'zod';
import { REVIEW_BODY_MAX, REVIEW_TITLE_MAX } from './review-rules.js';

/**
 * A review as its author sends it. No product, no order and no name: the product is the
 * URL, the order is found on the server, and the byline is derived from the account — a
 * field for any of the three would be a field somebody could fill in with someone else's.
 */
export const writeReviewSchema = z.strictObject({
  rating: z.number().int().min(1, 'Choose from one to five.').max(5, 'Choose from one to five.'),
  title: z.string().trim().max(REVIEW_TITLE_MAX).optional(),
  body: z.string().trim().max(REVIEW_BODY_MAX).optional(),
});

export const REVIEW_SORT_KEYS = ['newest', 'highest', 'lowest'] as const;
export type ReviewSortKey = (typeof REVIEW_SORT_KEYS)[number];

export const publicReviewQuerySchema = z.strictObject({
  sort: z.enum(REVIEW_SORT_KEYS).default('newest'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(12),
});

export const ADMIN_REVIEW_QUEUES = ['unread', 'hidden', 'all'] as const;

export const adminReviewQuerySchema = z.strictObject({
  queue: z.enum(ADMIN_REVIEW_QUEUES).default('unread'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

export const hideReviewSchema = z.object({
  note: z.string().trim().min(3, 'Say why. The person who wrote it will see this.').max(500),
});

export type WriteReviewInput = z.infer<typeof writeReviewSchema>;
export type PublicReviewQuery = z.infer<typeof publicReviewQuerySchema>;
export type AdminReviewQuery = z.infer<typeof adminReviewQuerySchema>;
