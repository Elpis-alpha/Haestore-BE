import { env } from '../../config/env.js';
import { sendMail } from '../../mail/transport.js';
import type { Message } from '../../mail/mime.js';

/**
 * The email that tells a customer the shop has replied.
 *
 * Reached only through the outbox, committed with the reply. It carries the reply itself,
 * so a short answer can be read in a notification preview without opening anything, and a
 * link to the conversation, because the thread — every message, both sides, in order — is
 * kept there and not in a mailbox.
 *
 * It is only ever sent to the address on the account that opened the conversation, which
 * is an address somebody proved they can read by signing in with a code sent to it.
 */

type TicketFacts = { reference: string; subject: string; email: string };
type MessageFacts = { body: string };

export function supportReplyMessage(ticket: TicketFacts, message: MessageFacts): Message {
  const link = `${env.WEB_URL.replace(/\/$/, '')}/account/support/${ticket.reference}`;

  const text = [
    `${env.MAIL_FROM_NAME} replied about “${ticket.subject}”.`,
    '',
    message.body,
    '',
    'The whole conversation is kept on the site, and you can reply there:',
    link,
    '',
    `Reference ${ticket.reference}`,
  ].join('\n');

  const paragraphs = message.body
    .split(/\n{2,}/)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#2e2419">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');

  // Inline styles only, and the shop's colours hard-coded, for the reasons in
  // mail/templates.ts: a stylesheet that half-applies in some client is worse than none.
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f3ede2;font-family:Georgia,'Times New Roman',serif;color:#2e2419">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#fbf8f2;border:1px solid #d9cdb8;border-radius:4px">
    <tr><td style="padding:32px">
      <p style="margin:0 0 24px;font-size:13px;letter-spacing:.08em;color:#7a6a52">${escapeHtml(env.MAIL_FROM_NAME)}</p>
      <h1 style="margin:0 0 20px;font-size:20px;font-weight:normal">A reply about “${escapeHtml(ticket.subject)}”</h1>
      <div style="margin:0 0 24px;padding:16px 18px;background:#f3ede2;border-radius:3px">${paragraphs}</div>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#4a3f30">The whole conversation is kept on the site, and you can reply there.</p>
      <p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:10px 18px;background:#2e2419;color:#fbf8f2;text-decoration:none;border-radius:3px;font-size:14px">Open the conversation</a></p>
      <p style="margin:0;font-size:12px;color:#7a6a52">Reference ${escapeHtml(ticket.reference)}</p>
    </td></tr>
  </table>
</body></html>`;

  return {
    to: ticket.email,
    subject: `Re: ${ticket.subject} [${ticket.reference}]`,
    text,
    html,
  };
}

export async function sendSupportReply(ticket: TicketFacts, message: MessageFacts): Promise<void> {
  await sendMail(supportReplyMessage(ticket, message));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
