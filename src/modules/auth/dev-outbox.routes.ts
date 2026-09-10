import { Router } from 'express';
import { isProduction } from '../../config/env.js';
import { notFound } from '../../lib/errors.js';
import { clearOutbox, readOutbox } from '../../mail/dev-outbox.js';

/**
 * The last messages this process produced, for local development and E2E.
 *
 * **These bodies contain live sign-in codes.** The guard is `router.use`, not a line
 * in each handler: a per-handler check is one forgotten line away from publishing
 * working credentials, and the line that is forgotten is always the one added last.
 * `app.ts` additionally declines to mount this router at all in production, so the
 * route does not exist there rather than merely refusing.
 */
export const devOutboxRouter: Router = Router();

devOutboxRouter.use((_req, _res, next) => {
  // 404, not 403: in production this path is indistinguishable from any other URL
  // that was never a route.
  next(isProduction ? notFound() : undefined);
});

devOutboxRouter.get('/outbox', (_req, res) => {
  res.json({ data: readOutbox() });
});

devOutboxRouter.delete('/outbox', (_req, res) => {
  clearOutbox();
  res.status(204).end();
});
