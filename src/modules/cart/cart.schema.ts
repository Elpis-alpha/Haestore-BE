import { z } from 'zod';
import { LINE_KEY_PATTERN } from './line-key.js';
import { MAX_LINE_QUANTITY } from './repricing.js';

/**
 * The cart's whole input contract.
 *
 * **No price, no total, no currency, and no line total appears anywhere in it.** Every
 * figure is read from the catalogue on the server. The 2022 app's worst defect was a
 * route that stored a payment blob the browser supplied; the structural defence against
 * repeating it is that there is no field here to put one in.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'That is not a valid id.');

export const addLineSchema = z.strictObject({
  productId: objectId,
  variantId: objectId,
  /**
   * Defaults to one, because "add to bag" from a product page sends no quantity and
   * requiring it would make the common call carry a constant.
   */
  quantity: z.coerce.number().int().min(1).max(MAX_LINE_QUANTITY).default(1),
});

export const setQuantitySchema = z.strictObject({
  // Zero is legal and means "remove", so the stepper's decrement from 1 does not need a
  // different endpoint from every other decrement.
  quantity: z.coerce.number().int().min(0).max(MAX_LINE_QUANTITY),
});

export const moveLineSchema = z.strictObject({
  to: z.enum(['saved', 'cart']),
});

export const lineKeySchema = z.string().regex(LINE_KEY_PATTERN, 'That is not a line in a cart.');

export const addWishSchema = z.strictObject({
  productId: objectId,
  variantId: objectId.nullish(),
});

export type AddLineInput = z.infer<typeof addLineSchema>;
export type SetQuantityInput = z.infer<typeof setQuantitySchema>;
export type MoveLineInput = z.infer<typeof moveLineSchema>;
export type AddWishInput = z.infer<typeof addWishSchema>;
