import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Environment contract.
 *
 * The 2022 backend read `process.env.X` at each use site with no validation and no
 * dotenv, so running it without `env-cmd` silently produced
 * `jwt.verify(token, undefined)`. Here the process refuses to start unless the
 * environment is coherent, and the error names every offending key at once.
 *
 * Feature keys are optional so the API boots in a partially-configured state during
 * development; each feature asserts its own keys at the point of use via
 * `requireConfigured()`, which fails with a specific, actionable message rather than
 * a generic undefined.
 */

const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const envSchema = z.object({
  // ---- Runtime -----------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Comma-separated. Every non-GET request must present a matching Origin; this is
  // the CSRF defence that pairs with SameSite=Lax, so it has no default.
  ALLOWED_ORIGINS: csv,
  PUBLIC_URL: z.url().default('http://localhost:5000'),
  /**
   * Where the storefront lives. Distinct from PUBLIC_URL, which is this API — the two
   * are different origins by design (ADR-001), and a payment provider redirecting the
   * shopper back needs the one with pages on it, not the one with JSON.
   */
  WEB_URL: z.url().default('http://localhost:3000'),

  // ---- Datastores (required — the API is useless without them) -----------
  // Must carry directConnection=true against a single-node replica set. See ADR-002.
  MONGODB_URL: z.string().min(1, 'MONGODB_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  MEILISEARCH_HOST: z.url().default('http://127.0.0.1:7700'),
  MEILISEARCH_API_KEY: z.string().min(1).optional(),
  // Prefixes every index name. Empty in development and production; the integration
  // suite sets it so a test run against a real Meilisearch cannot swap away the
  // catalogue someone is looking at in another window.
  MEILISEARCH_INDEX_PREFIX: z.string().default(''),

  // ---- Search indexing --------------------------------------------------
  // The outbox relay and the BullMQ worker run inside the API process, which is
  // right for a single-container deployment and wrong for several. Both are
  // switchable so a second replica can serve traffic without racing the first to
  // drain the outbox — the relay additionally holds a Redis lease, so leaving this
  // on everywhere is safe, just wasteful.
  SEARCH_INDEXING_ENABLED: z
    .stringbool()
    .default(true)
    .describe('Run the outbox relay and the index worker in this process.'),
  // Six admin saves in a minute must produce one re-index, not six: a settings job is
  // enqueued with this delay under a fixed job id, so re-enqueuing while one is
  // already waiting is a no-op. See ADR-003 and docs/SEARCH.md.
  SEARCH_SETTINGS_DEBOUNCE_MS: z.coerce.number().int().min(0).default(30_000),

  // The order worker drains the order outbox into email and sweeps expired stock
  // reservations. Both are idempotent, so several replicas running them is wasteful
  // rather than wrong — but a test process must not sweep mid-assertion.
  ORDER_JOBS_ENABLED: z
    .stringbool()
    .default(true)
    .describe('Run the order mail drain and the reservation sweeper in this process.'),
  ORDER_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).default(60_000),

  // ---- Auth --------------------------------------------------------------
  // Server-side pepper for OTP hashing. Never stored in Redis, which is what makes a
  // Redis dump useless to an attacker. See ADR-004.
  OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters').optional(),
  GUEST_COOKIE_SECRET: z.string().min(32).optional(),
  // Addresses granted `admin` at OTP verification time. Bootstraps a fresh database
  // with no seeded password, replacing the old shared ?item_password= secret.
  ADMIN_EMAILS: csv,

  // ---- Mail --------------------------------------------------------------
  // Gmail over HTTPS, and nothing else. SMTP was the obvious local convenience,
  // but most VPS hosts block outbound 25/465/587 as an anti-spam policy, so an
  // SMTP send does not fail fast — it hangs until it times out. Carrying a
  // transport that cannot be the production one only buys a class of bug that
  // appears exclusively in production. See docs/GMAIL-API-MIGRATION-NOTE.md.
  //
  //   console   — prints the message; a fresh clone with no credentials works.
  //   gmail-api — sends for real over 443.
  MAIL_DRIVER: z.enum(['console', 'gmail-api']).default('console'),

  // Required by the gmail-api driver, asserted at the point of use. The refresh
  // token needs https://mail.google.com/ or .../auth/gmail.send, and the Gmail API
  // must be enabled on the Cloud project owning the client id or sends return 403
  // accessNotConfigured. MAIL_REDIRECT_URI is declared because it is in .env and a
  // reader will look for it here, but the refresh-token flow never reads it — it
  // only mattered when the token was first minted.
  MAIL_CLIENT_ID: z.string().optional(),
  MAIL_CLIENT_SECRET: z.string().optional(),
  MAIL_REFRESH_TOKEN: z.string().optional(),
  MAIL_REDIRECT_URI: z.url().optional(),

  MAIL_FROM_ADDRESS: z.email().default('hello@haestore.test'),
  MAIL_FROM_NAME: z.string().default('Hæstore'),

  // ---- Media -------------------------------------------------------------
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('haestore'),

  // ---- Seeding -----------------------------------------------------------
  UNSPLASH_ACCESS_KEY: z.string().optional(),
  UNSPLASH_APP_NAME: z.string().default('haestore'),
  /**
   * Where the seed keeps Unsplash search responses and the record of which photographs'
   * downloads it has reported. Defaults to `../assets/.unsplash-cache` beside the root repo,
   * or `.unsplash-cache` here when this repo is checked out alone. See docs/SEEDING.md.
   */
  UNSPLASH_CACHE_DIR: z.string().optional(),

  // ---- Payments (test mode) ----------------------------------------------
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  /**
   * Issued when the webhook is registered in the PayPal dashboard, and required to
   * verify one — PayPal signs with a certificate chain and verification is a call back
   * to them, which needs to name the webhook being verified. Absent, the PayPal webhook
   * route refuses rather than trusting an unverified event; the return-page reconcile
   * reaches the same `markOrderPaid` without it, which is why the demo does not need it.
   */
  PAYPAL_WEBHOOK_ID: z.string().optional(),

  /**
   * How long an unpaid order holds its stock reservation. The sweeper cancels past it
   * and returns the stock to the shelf. Long enough to finish a card payment on a bad
   * connection, short enough that an abandoned checkout does not keep the shop sold out.
   */
  CHECKOUT_RESERVATION_MINUTES: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Deliberately console.error + exit rather than throw: this runs before the logger
  // exists, and a stack trace would bury the one thing the reader needs.
  console.error(`\nInvalid environment configuration:\n\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the missing values.\n');
  process.exit(1);
}

export const env: Env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Asserts that an optional feature's keys are present, at the point of use.
 *
 * Lets the API boot with, say, no Stripe keys and still serve the catalogue, while
 * an attempt to actually check out fails with "Stripe is not configured: set
 * STRIPE_SECRET_KEY" rather than a TypeError several frames deep.
 */
export function requireConfigured<K extends keyof Env>(feature: string, keys: K[]): void {
  const missing = keys.filter((k) => env[k] === undefined || env[k] === '');
  if (missing.length > 0) {
    throw new Error(`${feature} is not configured: set ${missing.join(', ')} in back-end/.env`);
  }
}
