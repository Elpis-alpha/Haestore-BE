import { randomInt } from 'node:crypto';
import { CROCKFORD_ALPHABET } from '../order/order-number.js';

/**
 * Support conversation references: `SUP-` and six Crockford base32 characters.
 *
 * The same alphabet and the same reasoning as order numbers (see order-number.ts): random
 * rather than sequential, so a reference says nothing about how many other people wrote
 * in, and read back through the same folding, so `sup-7k3m9o` typed from an email finds
 * `SUP-7K3M90`.
 *
 * Six characters is about a billion references, which is plenty for a shop and short
 * enough to read down a phone. The insert retries on the rare collision rather than
 * pretending one cannot happen.
 */

const LENGTH = 6;

export function generateTicketReference(): string {
  let body = '';
  for (let i = 0; i < LENGTH; i += 1) {
    body += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)];
  }
  return `SUP-${body}`;
}

export const TICKET_REFERENCE_PATTERN = /^SUP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

export function normaliseTicketReference(value: string): string {
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  const body = cleaned.startsWith('SUP') ? cleaned.slice(3) : cleaned;
  return `SUP-${body}`;
}

export function isTicketReference(value: string): boolean {
  return TICKET_REFERENCE_PATTERN.test(normaliseTicketReference(value));
}
