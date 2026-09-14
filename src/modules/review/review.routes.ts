import { Router } from 'express';
import { requireSession } from '../../middleware/session.js';
import { body, idParam, query, validateBody, validateQuery } from '../../middleware/validate.js';
import {
  adminReviewQuerySchema,
  hideReviewSchema,
  writeReviewSchema,
  type AdminReviewQuery,
  type WriteReviewInput,
} from './review.schema.js';
import {
  deleteOwnReview,
  hideReview,
  keepReview,
  listMyReviews,
  listReviewsForAdmin,
  restoreReview,
  writeReview,
} from './review.service.js';

/**
 * Reviews, from the account that writes them.
 *
 * `requireSession` once at the top, like the wishlist and order history. The public half —
 * reading a product's reviews — is on the catalogue router beside the product it belongs
 * to, because it is catalogue data that anybody may read and mixing the two kinds of
 * authorisation in one router is how one of them ends up optional.
 */
export const reviewRouter: Router = Router();

reviewRouter.use(requireSession);

const userIdOf = (req: { auth?: { userId: string } }) => req.auth!.userId;

reviewRouter.get('/mine', async (req, res) => {
  res.json({ data: await listMyReviews(userIdOf(req)) });
});

/** Create or replace. Addressed by product, because one person writes at most one each. */
reviewRouter.put('/products/:id', validateBody(writeReviewSchema), async (req, res) => {
  const review = await writeReview(userIdOf(req), idParam(req), body<WriteReviewInput>(req));
  res.json({ data: { review } });
});

reviewRouter.delete('/products/:id', async (req, res) => {
  await deleteOwnReview(userIdOf(req), idParam(req));
  res.status(204).end();
});

/**
 * Moderation. Mounted under the admin router, which gates and audits it.
 *
 * None of these is behind step-up. Each is reversible — a hidden review can be restored,
 * a kept one hidden — and reading the queue is routine work, which a code prompt would
 * only teach people to click through.
 */
export const adminReviewRouter: Router = Router();

adminReviewRouter.get('/', validateQuery(adminReviewQuerySchema), async (req, res) => {
  res.json(await listReviewsForAdmin(query<AdminReviewQuery>(req)));
});

adminReviewRouter.post('/:id/keep', async (req, res) => {
  res.json({ data: { review: await keepReview(idParam(req)) } });
});

adminReviewRouter.post('/:id/hide', validateBody(hideReviewSchema), async (req, res) => {
  const { note } = body<{ note: string }>(req);
  res.json({ data: { review: await hideReview(idParam(req), req.auth!.userId, note) } });
});

adminReviewRouter.post('/:id/restore', async (req, res) => {
  res.json({ data: { review: await restoreReview(idParam(req)) } });
});
