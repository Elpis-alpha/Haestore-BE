import { describe, expect, it } from 'vitest';
import { supportReplyMessage } from './support.mail.js';

const ticket = { reference: 'SUP-7K3M90', subject: 'Chipped bowl', email: 'ada@example.test' };

describe('the reply notification', () => {
  it('goes to the conversation’s own address, with the reference in the subject', () => {
    const message = supportReplyMessage(ticket, { body: 'Sorry to hear it.' });
    expect(message.to).toBe('ada@example.test');
    expect(message.subject).toBe('Re: Chipped bowl [SUP-7K3M90]');
  });

  it('carries the reply itself and the way back to the thread', () => {
    const message = supportReplyMessage(ticket, { body: 'A new one is on its way.' });
    expect(message.text).toContain('A new one is on its way.');
    expect(message.text).toContain('/account/support/SUP-7K3M90');
    expect(message.html).toContain('/account/support/SUP-7K3M90');
  });

  it('escapes what a person typed, in the reply and in the subject', () => {
    const message = supportReplyMessage(
      { ...ticket, subject: '<b>bowl</b>' },
      { body: '<script>alert(1)</script> & "quotes"' },
    );
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('&amp; &quot;quotes&quot;');
    expect(message.html).not.toContain('<b>bowl</b>');
  });

  it('keeps the shape of a reply written in paragraphs', () => {
    const message = supportReplyMessage(ticket, { body: 'One.\n\nTwo,\nstill two.' });
    expect(message.html.match(/<p style="margin:0 0 14px/g)).toHaveLength(2);
    expect(message.html).toContain('Two,<br>still two.');
  });
});
