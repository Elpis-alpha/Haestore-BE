import { describe, expect, it } from 'vitest';
import {
  generateTicketReference,
  isTicketReference,
  normaliseTicketReference,
  TICKET_REFERENCE_PATTERN,
} from './support-reference.js';

describe('ticket references', () => {
  it('are SUP- and six characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 500; i += 1) {
      const reference = generateTicketReference();
      expect(reference).toMatch(TICKET_REFERENCE_PATTERN);
      expect(reference.slice(4)).not.toMatch(/[ILOU]/);
    }
  });

  it('read back however they were typed', () => {
    expect(normaliseTicketReference('sup-7k3m90')).toBe('SUP-7K3M90');
    expect(normaliseTicketReference(' SUP 7K3M9O ')).toBe('SUP-7K3M90');
    expect(normaliseTicketReference('7k3m9o')).toBe('SUP-7K3M90');
    expect(normaliseTicketReference('SUP-AB1LI0')).toBe('SUP-AB1110');
  });

  it('refuses anything that is not one', () => {
    expect(isTicketReference('SUP-7K3M90')).toBe(true);
    expect(isTicketReference('HAE-7K3M90AB')).toBe(false);
    expect(isTicketReference('SUP-7K3M9')).toBe(false);
    expect(isTicketReference('SUP-7K3M9U')).toBe(false);
  });
});
