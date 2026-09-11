import { Router, type Request, type Response } from 'express';
import { body, param, validateBody } from '../../middleware/validate.js';
import { requireSession } from '../../middleware/session.js';
import { badRequest } from '../../lib/errors.js';
import {
  addLineSchema,
  lineKeySchema,
  moveLineSchema,
  setQuantitySchema,
  type AddLineInput,
  type MoveLineInput,
  type SetQuantityInput,
} from './cart.schema.js';
import {
  addLine,
  clearCart,
  dismissMergeReport,
  emptyCart,
  moveLine,
  readMergeReport,
  removeLine,
  setLineQuantity,
  undoMerge,
  viewCart,
  type CartOwner,
} from './cart.service.js';
import type { PricedCart } from './repricing.js';
import {
  guestKeyHash,
  newGuestToken,
  readGuestCookie,
  setBagCount,
  setGuestCookie,
  setMergeFlag,
} from './guest-cookie.js';

export const cartRouter: Router = Router();

/**
 * The bag.
 *
 * Every route here works signed in or signed out, and nothing is a guard: `attachSession`
 * has already decided *who* is calling, and the absence of a session means "this is a
 * guest" rather than an error. That is the whole reason it is mounted globally and is not
 * itself a guard — a cart route is the first place in the codebase that needs the
 * distinction.
 *
 * **A signed-in shopper's cart is found by their account, never by their guest cookie.**
 * The cookie may still be in the browser after a merge; ignoring it once there is a
 * session means a stale cookie can never resurrect a cart that was already folded in.
 */

/**
 * Who this cart belongs to, without creating anything.
 *
 * Returns null for a signed-out caller with no cookie — which is the majority of the
 * traffic and must stay free: no cookie, no cart, no database round trip.
 */
function ownerOf(req: Request): CartOwner | null {
  if (req.auth) return { userId: req.auth.userId };
  const token = readGuestCookie(req);
  return token ? { guestKey: guestKeyHash(token) } : null;
}

/**
 * The same, for a write — issuing a guest cookie if there is not one.
 *
 * **This is the only place a guest cookie is ever set**, and it is reached only from an
 * add-to-cart. Somebody who browses the shop and leaves gets no cookie at all, which is
 * what keeps the collection bounded by shoppers rather than by visits.
 */
function ownerForWrite(req: Request, res: Response): CartOwner {
  if (req.auth) return { userId: req.auth.userId };

  const existing = readGuestCookie(req);
  if (existing) return { guestKey: guestKeyHash(existing) };

  const token = newGuestToken();
  setGuestCookie(res, token);
  return { guestKey: guestKeyHash(token) };
}

/**
 * Answers with the cart, and refreshes the readable count cookie alongside it.
 *
 * The count is a display hint the header reads without a round trip — see
 * guest-cookie.ts. It is written on the way out of every cart response so it can never
 * drift from the answer that was just given.
 */
function respond(res: Response, cart: PricedCart, status = 200): void {
  setBagCount(res, cart.itemCount);
  res.status(status).json({ data: cart });
}

cartRouter.get('/', async (req, res) => {
  const owner = ownerOf(req);
  respond(res, owner ? await viewCart(owner) : emptyCart());
});

cartRouter.post('/lines', validateBody(addLineSchema), async (req, res) => {
  const input = body<AddLineInput>(req);
  const cart = await addLine(ownerForWrite(req, res), input);
  respond(res, cart, 201);
});

cartRouter.patch('/lines/:lineKey', validateBody(setQuantitySchema), async (req, res) => {
  const owner = requireOwner(req);
  const { quantity } = body<SetQuantityInput>(req);
  respond(res, await setLineQuantity(owner, lineKeyFrom(req), quantity));
});

cartRouter.delete('/lines/:lineKey', async (req, res) => {
  respond(res, await removeLine(requireOwner(req), lineKeyFrom(req)));
});

/** Set aside, or put back. One route, because it is one operation with a direction. */
cartRouter.post('/lines/:lineKey/move', validateBody(moveLineSchema), async (req, res) => {
  const { to } = body<MoveLineInput>(req);
  respond(res, await moveLine(requireOwner(req), lineKeyFrom(req), to));
});

cartRouter.delete('/', async (req, res) => {
  const owner = ownerOf(req);
  respond(res, owner ? await clearCart(owner) : emptyCart());
});

/* ------------------------------------------------------------------- merge -- */

/**
 * What the last sign-in did to the bag.
 *
 * A separate read rather than a field on the sign-in response, because the merge happens
 * during verification and the shopper is navigating at that moment — a report attached
 * to the response the browser is about to replace is a report nobody sees. This is read
 * by the destination page, and dismissed once it has been.
 */
cartRouter.get('/merge-report', requireSession, async (req, res) => {
  const summary = await readMergeReport(auth(req).userId);
  // Clearing on an empty read keeps a stale flag from making every future visit ask
  // again — the flag is a hint, and this is the hint correcting itself.
  if (!summary) setMergeFlag(res, false);
  res.json({ data: summary });
});

cartRouter.post('/merge-report/dismiss', requireSession, async (req, res) => {
  await dismissMergeReport(auth(req).userId);
  setMergeFlag(res, false);
  res.status(204).end();
});

cartRouter.post('/merge-report/undo', requireSession, async (req, res) => {
  const cart = await undoMerge(auth(req).userId);
  setMergeFlag(res, false);
  respond(res, cart);
});

/* ----------------------------------------------------------------- helpers -- */

function auth(req: Request) {
  const found = req.auth;
  /* c8 ignore next */
  if (!found) throw badRequest('No session.');
  return found;
}

/**
 * A write against a cart that must already exist.
 *
 * Changing a quantity in a bag you do not have is not a request worth creating a cart
 * for — it is a stale tab, and the honest answer is that the line is not there.
 */
function requireOwner(req: Request): CartOwner {
  const owner = ownerOf(req);
  if (!owner) throw badRequest('There is no cart to change.');
  return owner;
}

function lineKeyFrom(req: Request): string {
  const parsed = lineKeySchema.safeParse(param(req, 'lineKey'));
  if (!parsed.success) throw badRequest('That is not a line in a cart.');
  return parsed.data;
}
