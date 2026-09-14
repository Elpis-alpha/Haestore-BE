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
import { adminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { devOutboxRouter } from './modules/auth/dev-outbox.routes.js';
import { cartRouter } from './modules/cart/cart.routes.js';
import { checkoutRouter } from './modules/checkout/checkout.routes.js';
import { orderRouter } from './modules/order/order.routes.js';
import { webhooksRouter } from './modules/payments/webhooks.routes.js';
import { wishlistRouter } from './modules/wishlist/wishlist.routes.js';
import { storefrontRouter } from './modules/storefront/storefront.routes.js';
import { reviewRouter } from './modules/review/review.routes.js';
import { supportRouter } from './modules/support/support.routes.js';
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
  // Payment webhooks mount HERE, BEFORE express.json(), because signature verification
  // needs the exact raw bytes. A JSON parser that has already consumed and re-serialised
  // the body invalidates every signature, and the resulting 400s from Stripe look like a
  // credentials problem rather than a parsing one. There is a regression test for this
  // in stripe.test.ts: a body round-tripped through JSON.parse/stringify does not verify.
  //
  // They also mount ABOVE originGuard and attachSession deliberately. A webhook carries
  // no Origin header and no session cookie — it is authenticated by its signature and by
  // nothing else — so passing it through either would reject every delivery.
  // ---------------------------------------------------------------------------
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhooksRouter);

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
  // Neither is a guard. A cart route reads req.auth and treats its absence as "this is
  // a guest"; the wishlist router mounts requireSession once at its own top.
  app.use('/api/cart', cartRouter);
  app.use('/api/wishlist', wishlistRouter);
  // Checkout is not a guard either: guest checkout is a first-class path, and an order
  // is attached to an account later if one is ever created for that address. The order
  // router does mount requireSession at its own top — order history belongs to accounts,
  // and a guest reads their one order through the checkout router's claim-token route.
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/orders', orderRouter);
  // The composed front page. Public, and only ever the published version.
  app.use('/api/storefront', storefrontRouter);
  // Both mount requireSession at their own top. A product's reviews are read publicly
  // through the catalogue router; writing one, and every support conversation, belongs to
  // an account.
  app.use('/api/reviews', reviewRouter);
  app.use('/api/support', supportRouter);
  // Every admin route sits under one router, which applies requireRole and the audit
  // middleware once for all of them. See modules/admin/admin.routes.ts.
  app.use('/api/admin', adminRouter);

  // Not mounted at all in production, so the sign-in codes it exposes cannot be
  // reached by a path that merely refuses. The router carries its own guard as well.
  if (!isProduction) app.use('/api/dev', devOutboxRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
