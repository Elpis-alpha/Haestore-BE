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

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .default(fallback ? 'true' : 'false');

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
  PUBLIC_URL: z.string().url().default('http://localhost:5000'),

  // ---- Datastores (required — the API is useless without them) -----------
  // Must carry directConnection=true against a single-node replica set. See ADR-002.
  MONGODB_URL: z.string().min(1, 'MONGODB_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  MEILISEARCH_HOST: z.string().url().default('http://127.0.0.1:7700'),
  MEILISEARCH_API_KEY: z.string().min(1).optional(),

  // ---- Auth --------------------------------------------------------------
  // Server-side pepper for OTP hashing. Never stored in Redis, which is what makes a
  // Redis dump useless to an attacker. See ADR-004.
  OTP_PEPPER: z.string().min(32, 'OTP_PEPPER must be at least 32 characters').optional(),
  GUEST_COOKIE_SECRET: z.string().min(32).optional(),
  // Addresses granted `admin` at OTP verification time. Bootstraps a fresh database
  // with no seeded password, replacing the old shared ?item_password= secret.
  ADMIN_EMAILS: csv,

  // ---- Mail --------------------------------------------------------------
  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().email().default('hello@haestore.test'),
  MAIL_FROM_NAME: z.string().default('Hæstore'),

  // ---- Media -------------------------------------------------------------
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  CLOUDINARY_FOLDER: z.string().default('haestore'),

  // ---- Seeding -----------------------------------------------------------
  UNSPLASH_ACCESS_KEY: z.string().optional(),
  UNSPLASH_APP_NAME: z.string().default('haestore'),

  // ---- Payments (test mode) ----------------------------------------------
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
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
