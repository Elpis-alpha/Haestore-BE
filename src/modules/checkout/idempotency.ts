import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { IdempotencyKey } from './idempotency.model.js';
import { isDuplicateKeyError } from '../payments/payment-event.model.js';
import { guestKeyHash, readGuestCookie } from '../cart/guest-cookie.js';

/**
 * `Idempotency-Key` at the API edge.
 *
 * The inner guards each protect one thing: the order's status filter stops a second
 * *payment*, the unique index on `payment.intentId` stops one intent reaching two
 * orders. Neither stops a second **order** being created from the same cart, which is
 * exactly what a double-tapped "Place order" on flaky mobile data produces — and it is
 * the most likely failure of the lot, because it needs no adversary and no race in our
 * code, only a slow network and an impatient thumb.
 *
 * So the outermost guard is the simplest one: the client names its attempt, and a second
 * request wearing the same name is answered rather than performed.
 *
 * **The insert is the claim.** `create()` against a unique index either wins or raises
 * E11000, and the loser reads the winner's row. Checking first and inserting after would
 * leave the window this exists to close.
 */

const HEADER = 'idempotency-key';

/** Stable across key ordering, so a client that re-serialises its body still matches. */
function hashRequest(body: unknown): string {
  return createHash('sha256').update(canonical(body)).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The caller, so one client's key can never replay another's stored response.
 *
 * Without this, an attacker who learned a key could present it and be handed the order
 * it created — including its client secret. Scoped to the account, the guest cookie
 * hash, or `anon` for a caller with neither.
 */
function ownerOf(req: Request): string {
  if (req.auth) return `user:${req.auth.userId}`;

  /**
   * **The guest's own cookie, hashed — not a shared bucket.**
   *
   * An earlier draft of this read a `req.guestKeyHash` that nothing ever set, so every
   * signed-out caller fell through to `anon` and therefore shared one owner. Two guests
   * using the same key value would then replay each other's stored response, which for
   * this route means handing somebody else's order — and its client secret — to whoever
   * asked second. The integration suite's "scopes a key to its owner" test is what
   * caught it, and is why it exists.
   *
   * `anon` remains for a caller with no session and no guest cookie. Such a caller has
   * no cart either, so the route below refuses them before an order can exist.
   */
  const token = readGuestCookie(req);
  return token ? `guest:${guestKeyHash(token)}` : 'anon';
}

/**
 * Requires and enforces an idempotency key on a route.
 *
 * `res.json` is wrapped rather than the response being captured some other way, because
 * every route in this codebase answers with `res.json` and the wrapper is therefore the
 * one place the stored body can be recorded without each handler remembering to.
 */
export function idempotent(scope: string) {
  return async function idempotencyMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = req.get(HEADER)?.trim();

    if (!key) {
      next(
        new AppError(400, 'BAD_REQUEST', 'This request requires an Idempotency-Key header.', {
          details: { header: 'Idempotency-Key' },
        }),
      );
      return;
    }
    if (key.length > 255) {
      next(new AppError(400, 'BAD_REQUEST', 'Idempotency-Key is too long.'));
      return;
    }

    const owner = ownerOf(req);
    const requestHash = hashRequest(req.body);

    let record;
    try {
      record = await IdempotencyKey.create({
        key,
        scope,
        owner,
        requestHash,
        status: 'in_flight',
      });
    } catch (err) {
      if (!isDuplicateKeyError(err)) {
        next(err);
        return;
      }

      const existing = await IdempotencyKey.findOne({ owner, scope, key });
      if (!existing) {
        // The row expired between the failed insert and this read — a 24-hour TTL and
        // an unlucky millisecond. Treating it as a fresh attempt is correct.
        next(new AppError(409, 'CONFLICT', 'Please try that again.'));
        return;
      }

      /**
       * The same key for a different request. This is a client bug, and replaying the
       * first response would answer a question nobody asked — quite possibly telling
       * somebody their order succeeded when the order they just described was never
       * created.
       */
      if (existing.requestHash !== requestHash) {
        logger.warn({ scope, owner }, 'idempotency: key reused with a different body');
        next(
          new AppError(
            422,
            'UNPROCESSABLE',
            'This Idempotency-Key was already used for a different request.',
          ),
        );
        return;
      }

      if (existing.status === 'in_flight') {
        // Deliberately not a wait. Holding the second request open is how a double-tap
        // becomes two hung connections and then a timeout on both.
        next(new AppError(409, 'CONFLICT', 'That request is still being processed.'));
        return;
      }

      res.status(existing.responseStatus ?? 200).json(existing.responseBody);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      // Only a success is stored. A failed attempt must be retryable with the same key:
      // storing a 409 would make a transient stock failure permanent for that client.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        void IdempotencyKey.updateOne(
          { _id: record._id },
          { $set: { status: 'completed', responseStatus: res.statusCode, responseBody: body } },
        ).catch((err: Error) =>
          logger.error({ err: err.message, scope }, 'idempotency: could not store the response'),
        );
      } else {
        void IdempotencyKey.deleteOne({ _id: record._id }).catch(() => undefined);
      }
      return originalJson(body);
    };

    next();
  };
}
