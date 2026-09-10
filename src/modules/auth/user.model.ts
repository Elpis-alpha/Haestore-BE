import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * A person, identified by a mailbox they have proven they can read.
 *
 * **There is no `passwordHash` field, and there must never be one.** The whole auth
 * design (ADR-004) rests on there being no long-lived secret to steal, reset, reuse
 * across sites, or forget. Adding a password column later would not be an extra
 * option — it would reintroduce every failure mode this replaced.
 *
 * The 2022 user document carried `tokens: [{ token }]`, an unbounded array of JWTs
 * that never expired and were not cleared on password change. Nothing here grows
 * without bound: sessions live in Redis with a TTL, and the only counter on the
 * document is `sessionVersion`.
 */
const userSchema = new Schema(
  {
    /**
     * Lowercased at the boundary, not here, so the value used for the OTP HMAC and
     * the value stored are provably the same string. `unique` gives the race
     * protection: two verifications of the same new address at the same moment
     * cannot both create an account, because the second insert gets E11000 and
     * falls back to reading the winner.
     */
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },

    /**
     * Set on first successful verification. Possession of a code mailed to the
     * address *is* the verification, so there is no separate confirm step and this
     * is never null on a user that exists.
     */
    emailVerifiedAt: { type: Date, required: true },

    /** Optional, and asked for after sign-in rather than as a barrier to it. */
    name: { type: String, trim: true, maxlength: 80 },

    /**
     * Bootstrapped from the ADMIN_EMAILS allowlist at verification time, so a fresh
     * database yields a working admin with no seeded credential. Read only from the
     * server-side session — never from a body, query or header.
     */
    roles: { type: [String], default: [], enum: ['admin'] },

    /**
     * The nuclear revoke. `requireSession` compares the session's snapshot of this
     * against the document on every authenticated request, so `$inc`-ing it
     * invalidates every session everywhere without touching Redis — which is what
     * makes an admin demotion take effect on the demoted person's next request
     * rather than whenever their session happens to expire.
     */
    sessionVersion: { type: Number, required: true, default: 0 },

    /** Coarse, for the account page. Written at most once a day; see `touchUser`. */
    lastSeenAt: { type: Date },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;

export const User = registerModel('User', userSchema);
