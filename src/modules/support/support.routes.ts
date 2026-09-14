import { Router } from 'express';
import { requireSession } from '../../middleware/session.js';
import { body, param, query, validateBody, validateQuery } from '../../middleware/validate.js';
import {
  adminTicketQuerySchema,
  openTicketSchema,
  replySchema,
  staffReplySchema,
  ticketListQuerySchema,
  type AdminTicketQuery,
  type OpenTicketInput,
  type StaffReplyInput,
  type TicketListQuery,
} from './support.schema.js';
import {
  closeAsCustomer,
  closeAsShop,
  getTicketForAdmin,
  getTicketForCustomer,
  listTicketsForAdmin,
  listTicketsForCustomer,
  openTicket,
  reopenAsShop,
  replyAsCustomer,
  replyAsShop,
} from './support.service.js';

/**
 * Support, from the customer's side. `requireSession` once at the top — see ADR-014 for why
 * there is no signed-out way in.
 *
 * Conversations are addressed by their reference rather than their id: it is what the
 * customer sees, quotes and finds in the email, and the lookup is scoped to the caller in
 * the query either way.
 */
export const supportRouter: Router = Router();

supportRouter.use(requireSession);

const userIdOf = (req: { auth?: { userId: string } }) => req.auth!.userId;

supportRouter.get('/tickets', validateQuery(ticketListQuerySchema), async (req, res) => {
  res.json(await listTicketsForCustomer(userIdOf(req), query<TicketListQuery>(req)));
});

supportRouter.post('/tickets', validateBody(openTicketSchema), async (req, res) => {
  const ticket = await openTicket(userIdOf(req), body<OpenTicketInput>(req));
  res.status(201).json({ data: { ticket } });
});

supportRouter.get('/tickets/:reference', async (req, res) => {
  const ticket = await getTicketForCustomer(userIdOf(req), param(req, 'reference'));
  res.json({ data: { ticket } });
});

supportRouter.post('/tickets/:reference/messages', validateBody(replySchema), async (req, res) => {
  const { body: text } = body<{ body: string }>(req);
  const ticket = await replyAsCustomer(userIdOf(req), param(req, 'reference'), text);
  res.status(201).json({ data: { ticket } });
});

supportRouter.post('/tickets/:reference/close', async (req, res) => {
  const ticket = await closeAsCustomer(userIdOf(req), param(req, 'reference'));
  res.json({ data: { ticket } });
});

/**
 * The inbox. Mounted under the admin router, which gates and audits it. Nothing here is
 * behind step-up: a reply is the job, and a closed conversation can be reopened.
 */
export const adminSupportRouter: Router = Router();

adminSupportRouter.get('/tickets', validateQuery(adminTicketQuerySchema), async (req, res) => {
  res.json(await listTicketsForAdmin(query<AdminTicketQuery>(req)));
});

adminSupportRouter.get('/tickets/:id', async (req, res) => {
  res.json({ data: { ticket: await getTicketForAdmin(param(req, 'id')) } });
});

adminSupportRouter.post(
  '/tickets/:id/messages',
  validateBody(staffReplySchema),
  async (req, res) => {
    const { body: text, close } = body<StaffReplyInput>(req);
    const auth = req.auth!;
    const ticket = await replyAsShop(
      param(req, 'id'),
      { userId: auth.userId, email: auth.email },
      text,
      close,
    );
    res.status(201).json({ data: { ticket } });
  },
);

adminSupportRouter.post('/tickets/:id/close', async (req, res) => {
  res.json({ data: { ticket: await closeAsShop(param(req, 'id')) } });
});

adminSupportRouter.post('/tickets/:id/reopen', async (req, res) => {
  res.json({ data: { ticket: await reopenAsShop(param(req, 'id')) } });
});
