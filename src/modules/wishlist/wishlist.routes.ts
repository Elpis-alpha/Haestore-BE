import { Router, type Request } from 'express';
import { body, validateBody } from '../../middleware/validate.js';
import { requireSession } from '../../middleware/session.js';
import { badRequest } from '../../lib/errors.js';
import { addWishSchema, type AddWishInput } from '../cart/cart.schema.js';
import { addWish, listWishlist, removeWish } from './wishlist.service.js';

/**
 * The wishlist, which requires an account — see wishlist.model.ts for why that is a
 * decision rather than a gap. `requireSession` is mounted once at the top of the router
 * rather than per handler, the same shape as `requireRole` on the admin routers.
 */
export const wishlistRouter: Router = Router();

wishlistRouter.use(requireSession);

const userId = (req: Request): string => {
  const found = req.auth;
  /* c8 ignore next */
  if (!found) throw badRequest('No session.');
  return found.userId;
};

wishlistRouter.get('/', async (req, res) => {
  res.json({ data: await listWishlist(userId(req)) });
});

wishlistRouter.post('/', validateBody(addWishSchema), async (req, res) => {
  const { productId, variantId } = body<AddWishInput>(req);
  await addWish(userId(req), productId, variantId);
  res.status(201).json({ data: await listWishlist(userId(req)) });
});

/**
 * Delete by body rather than by path.
 *
 * A wish is identified by a *pair* — a product and an optional variant — and a null
 * variant is a meaningful value rather than an omission. Encoding "product X, no
 * variant" into a path segment means inventing a spelling for null and parsing it back;
 * the body already has one.
 */
wishlistRouter.delete('/', validateBody(addWishSchema), async (req, res) => {
  const { productId, variantId } = body<AddWishInput>(req);
  await removeWish(userId(req), productId, variantId);
  res.json({ data: await listWishlist(userId(req)) });
});
