import { Router } from 'express';
import { z } from 'zod';
import { requireStepUp } from '../../middleware/session.js';
import { body, idParam, query, validateBody, validateQuery } from '../../middleware/validate.js';
import {
  getCustomer,
  listCustomers,
  revokeCustomerSessions,
  setAdminRole,
} from './customer.service.js';

/**
 * Customers, from behind the counter. Gated and audited by the admin router it sits in.
 */
export const adminCustomerRouter: Router = Router();

export const customerListQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(24),
});

export const setRoleSchema = z.object({ admin: z.boolean() });

adminCustomerRouter.get('/', validateQuery(customerListQuerySchema), async (req, res) => {
  const { q, page, perPage } = query<z.infer<typeof customerListQuerySchema>>(req);
  res.json(await listCustomers({ ...(q ? { q } : {}), page, perPage }));
});

adminCustomerRouter.get('/:id', async (req, res) => {
  res.json({ data: await getCustomer(idParam(req), req.auth?.userId ?? '') });
});

/** Not behind step-up: signing someone out is recoverable by them signing back in. */
adminCustomerRouter.post('/:id/revoke-sessions', async (req, res) => {
  const revoked = await revokeCustomerSessions(idParam(req), req.auth?.userId ?? '');
  res.json({ data: { revoked } });
});

/** Behind step-up. Making someone an admin is the largest privilege this system grants. */
adminCustomerRouter.put(
  '/:id/roles',
  requireStepUp(),
  validateBody(setRoleSchema),
  async (req, res) => {
    const id = idParam(req);
    const { admin } = body<{ admin: boolean }>(req);
    const result = await setAdminRole(id, admin, req.auth?.userId ?? '');
    res.json({ data: { ...result, customer: await getCustomer(id, req.auth?.userId ?? '') } });
  },
);
