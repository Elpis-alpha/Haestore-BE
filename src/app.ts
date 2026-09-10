import express, { type Express } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { env, isProduction } from './config/env.js';
import { requestContext } from './middleware/request-context.js';
import { originGuard } from './middleware/origin-guard.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { healthRouter } from './modules/health/health.routes.js';
import { catalogRouter } from './modules/catalog/catalog.routes.js';
import { adminCatalogRouter } from './modules/catalog/admin-catalog.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { devOutboxRouter } from './modules/auth/dev-outbox.routes.js';
import { attachSession } from './middleware/session.js';
import './middleware/auth-context.js';

export function createApp(): Express {
  const app = express();

  // Behind Cloudflare / a reverse proxy, so req.ip must come from X-Forwarded-For or
  // every rate limit would bucket the whole internet into one counter.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  // ---------------------------------------------------------------------------
  // ORDER IS LOAD-BEARING BELOW THIS LINE.
  //
  // Payment webhooks mount here in Phase 7, BEFORE express.json(), because signature
  // verification needs the exact raw bytes. A JSON parser that has already consumed
  // and re-serialised the body invalidates every signature, and the resulting 400s
  // from Stripe look like a credentials problem rather than a parsing one.
  //
  //   app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhook);
  // ---------------------------------------------------------------------------

  app.use(compression());
  // 1 MB, not the 2022 app's 20 MB applied globally and unauthenticated. Image uploads
  // go to Cloudinary via signed direct upload and never transit this body parser.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());

  app.use(
    cors({
      // An allowlist, not the 2022 app's bare cors() which sent
      // Access-Control-Allow-Origin: * on every route and method.
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (env.ALLOWED_ORIGINS.includes(origin.toLowerCase())) return callback(null, true);
        if (!isProduction && env.ALLOWED_ORIGINS.length === 0) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
    }),
  );
  app.use(originGuard);

  // Resolves the session cookie into req.auth for everything below. It is not a guard
  // — it decides who is calling, never whether they may — so it is safe above the
  // public routes, which need to know an admin is an admin without requiring one.
  app.use(attachSession);

  app.use(healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/catalog', catalogRouter);
  // Every admin router is gated inside itself by requireRole, mounted once at the top
  // of the router rather than per handler.
  app.use('/api/admin/catalog', adminCatalogRouter);

  // Not mounted at all in production, so the sign-in codes it exposes cannot be
  // reached by a path that merely refuses. The router carries its own guard as well.
  if (!isProduction) app.use('/api/dev', devOutboxRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
