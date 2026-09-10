import { z } from 'zod';
import { CODE_LENGTH } from './otp.js';

/**
 * The whole authenticated surface's input contract. Four fields in total, which is
 * what "no passwords" buys.
 */

/**
 * Lowercased and trimmed, and nothing else.
 *
 * Deliberately no Gmail-style normalisation (stripping dots, cutting at `+`): those
 * rules are provider-specific, change without notice, and silently merge two addresses
 * a person considers separate. The address is an identity here, not a routing hint.
 */
export const emailSchema = z
  .string()
  // Normalise **before** validating, not after. A `z.email().transform(trim)` reads
  // the same and rejects `"  a@b.test "` outright, because the transform runs on the
  // way out — so a shopper who pastes an address with the trailing space a mail client
  // added is told their address is not an address.
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.email('That does not look like an email address.').max(254, 'That address is too long.'));

export const requestCodeSchema = z.strictObject({ email: emailSchema });

export const verifyCodeSchema = z.strictObject({
  challengeId: z.uuid('That sign-in has expired. Ask for a new code.'),
  code: z
    .string()
    // Spaces and dashes survive a paste from a mail client, and rejecting them for
    // being cosmetic is a needless failure at the last step of signing in.
    .transform((value) => value.replace(/[\s-]/g, ''))
    .pipe(z.string().regex(new RegExp(`^\\d{${CODE_LENGTH}}$`), 'Enter the six-digit code.')),
});

export const updateProfileSchema = z.strictObject({
  name: z.string().trim().max(80, 'That name is too long.').optional(),
});

export type RequestCodeInput = z.infer<typeof requestCodeSchema>;
export type VerifyCodeInput = z.infer<typeof verifyCodeSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
