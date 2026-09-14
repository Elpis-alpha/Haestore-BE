import { Router } from 'express';
import { requireRole } from '../../middleware/require-role.js';
import { query, validateQuery } from '../../middleware/validate.js';
import { adminCatalogRouter } from '../catalog/admin-catalog.routes.js';
import { adminCustomerRouter } from '../customer/admin-customer.routes.js';
import { adminOrderRouter } from '../order/admin-order.routes.js';
import { adminStorefrontRouter } from '../storefront/storefront.routes.js';
import { adminReviewRouter } from '../review/review.routes.js';
import { adminSupportRouter } from '../support/support.routes.js';
import { auditAdminMutations, auditQuerySchema, listAudit } from './audit.js';
import { dashboardSummary } from './dashboard.service.js';

/**
 * The whole admin surface, behind one gate.
 *
 * Phase 2 mounted `requireRole` inside the catalogue router, which was right for one
 * router and becomes the per-handler mistake at five: each new admin router would be one
 * forgotten line from open. So the gate moved here, above every admin router, and the
 * integration suite walks this router's own route table to assert that **every** route
 * beneath it answers 401 to a stranger and 404 to a signed-in non-admin — a route added
 * next year is covered by the test without anyone editing the test.
 *
 * The audit middleware sits directly under the gate for the same reason: an admin route
 * is audited by being mounted here, not by remembering to call something.
 */
export const adminRouter: Router = Router();

adminRouter.use(requireRole('admin'));
adminRouter.use(auditAdminMutations);

adminRouter.get('/dashboard', async (_req, res) => {
  res.json({ data: await dashboardSummary() });
});

adminRouter.get('/audit', validateQuery(auditQuerySchema), async (req, res) => {
  res.json(await listAudit(query(req)));
});

adminRouter.use('/catalog', adminCatalogRouter);
adminRouter.use('/orders', adminOrderRouter);
adminRouter.use('/customers', adminCustomerRouter);
adminRouter.use('/storefront', adminStorefrontRouter);
adminRouter.use('/reviews', adminReviewRouter);
adminRouter.use('/support', adminSupportRouter);
