# Hæstore API

Express 5 · TypeScript · Mongoose 8 · Redis · Meilisearch

The API for [Hæstore](https://github.com/Elpis-alpha/haestore), an artisanal general
store. Infrastructure, architecture notes and ADRs live in the root repo.

## Running it

This repo does not start its own datastores. Bring them up from the root repo first:

```bash
cd ..            # the haestore root
npm run up       # Mongo (replica set), Redis, Meilisearch
npm run probe    # assert the platform actually supports transactions
```

Then:

```bash
cp .env.example .env     # fill in the secrets
npm install
npm run dev              # http://localhost:5000
```

| Script                            |                                                                             |
| --------------------------------- | --------------------------------------------------------------------------- |
| `npm run dev`                     | tsx watch                                                                   |
| `npm run build` / `start`         | compile to `dist/`, run compiled                                            |
| `npm run typecheck`               | `tsc --noEmit`                                                              |
| `npm run lint` / `lint:fix`       | ESLint flat config, type-aware                                              |
| `npm run format` / `format:check` | Prettier                                                                    |
| `npm test`                        | Vitest                                                                      |
| `npm run test:integration`        | Vitest against an in-process replica set and a real Redis                   |
| `npm run seed`                    | the demo shop — see docs/SEEDING.md in the root repo                        |
| `npm run seed:photos`             | choose and lock the seed's Unsplash photographs, and report their downloads |
| `npm run check`                   | all of the above — what CI runs                                             |

## Health

| Route          | Meaning                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /healthz` | Liveness. Cheap, no dependencies, so a database blip never gets the container killed.                                                |
| `GET /readyz`  | Readiness. Probes Mongo, Redis and Meilisearch in parallel and reports each separately, so an incident names the store that is down. |

## Layout

```
src/
├── config/env.ts      Zod-validated environment; the process refuses to boot without it
├── lib/               logger (pino), error taxonomy, shared utilities
├── db/mongo.ts        connection + replica-set assertion
├── cache/redis.ts     sessions, OTP challenges, rate limits, queues
├── search/meili.ts    the storefront read model
├── middleware/        request context, origin guard, the one global error handler
├── modules/           feature slices: auth, catalog, cart, checkout, order, admin…
└── server.ts          startup order and graceful shutdown
```

## Things that are deliberate

**MongoDB must be a replica set.** The connection asserts it at boot and refuses to
start against a standalone `mongod`. Without one there are no multi-document
transactions and no change streams, so checkout would silently degrade to a sequence
of independent writes. See ADR-002 — and note the connection string needs
`directConnection=true`.

**Middleware order in `app.ts` is load-bearing.** Payment webhooks mount before
`express.json()`, because signature verification needs the exact raw bytes.

**Redis is a cache, not a database.** It must be safe to flush. Anything whose loss
would be a lost sale — carts in particular — lives in Mongo.

**Optional features fail at the point of use.** Stripe and Cloudinary keys are optional
so the API boots partially configured; `requireConfigured()` then fails with
"Stripe is not configured: set STRIPE_SECRET_KEY" rather than a TypeError.

## What this replaced

A rebuild of the 2022 backend, not a refactor of it. The original is still in this
repo's history at `ed82843`. Specifically retired:

- **`?item_password=` as the entire admin authorization model** — a shared static
  secret in the URL of every mutating request, and therefore in every access log.
  Replaced by roles on the user and a step-up requirement for destructive actions.
- **Client-trusted PayPal orders.** `POST /api/order/add-paypal` stored a payment blob
  from the browser without ever contacting PayPal. Captures are now server-side and
  reconciled against a server-computed total.
- **JWTs signed with `{}`** — no expiry, ever — accumulating in an unbounded
  `user.tokens[]` array. Replaced by opaque, revocable Redis sessions.
- **No global error handler**, so most unhandled throws returned an HTML stack trace.
- **Unbounded listing queries** with no projection and no default limit.
- **`new RegExp(userInput, 'i')`** run over an unindexed collection scan.
