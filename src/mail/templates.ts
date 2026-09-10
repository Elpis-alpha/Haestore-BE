import { env } from '../config/env.js';
import { CHALLENGE_TTL_SECONDS } from '../modules/auth/otp.js';
import type { Message } from './mime.js';

/**
 * The sign-in email.
 *
 * Written to be read in a notification preview, because that is where most of these
 * are read: the code is in the subject line as well as the body, so an iOS or Android
 * banner is enough to finish signing in without opening anything.
 *
 * No tracking pixel, no click-through link, no images. A code the person types is
 * phishing-resistant in a way a magic link is not — a link in an email trains people
 * to click links in emails, which is the behaviour every credential-phishing campaign
 * depends on.
 */
export function signInCodeMessage(
  to: string,
  code: string,
  purpose: 'sign-in' | 'step-up',
): Message {
  const minutes = Math.round(CHALLENGE_TTL_SECONDS / 60);
  const heading = purpose === 'sign-in' ? 'Your sign-in code' : 'Confirm it is you';
  const lead =
    purpose === 'sign-in'
      ? `Enter this code to sign in to ${env.MAIL_FROM_NAME}.`
      : `Enter this code to confirm a change to your ${env.MAIL_FROM_NAME} account.`;

  const text = [
    heading,
    '',
    code,
    '',
    lead,
    `It expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not ask for this, you can ignore it — nothing has changed and',
    'no one can sign in without the code.',
  ].join('\n');

  // Inline styles only: Gmail strips <style> blocks in some clients, and a stylesheet
  // that half-applies is worse than none. Colours are the shop's, hard-coded here
  // because an email cannot read a CSS custom property.
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f3ede2;font-family:Georgia,'Times New Roman',serif;color:#2e2419">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#fbf8f2;border:1px solid #d9cdb8;border-radius:4px">
    <tr><td style="padding:32px">
      <p style="margin:0 0 24px;font-size:13px;letter-spacing:.08em;color:#7a6a52">${escapeHtml(env.MAIL_FROM_NAME)}</p>
      <h1 style="margin:0 0 16px;font-size:24px;font-weight:normal">${escapeHtml(heading)}</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4a3f30">${escapeHtml(lead)}</p>
      <p style="margin:0 0 24px;padding:16px;background:#f3ede2;border-radius:3px;text-align:center;font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:32px;letter-spacing:.24em">${escapeHtml(code)}</p>
      <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#4a3f30">It expires in ${minutes} minutes and can only be used once.</p>
      <p style="margin:0;font-size:13px;line-height:1.6;color:#7a6a52">If you did not ask for this, you can ignore it — nothing has changed, and no one can sign in without the code.</p>
    </td></tr>
  </table>
</body></html>`;

  return {
    to,
    // The code in the subject is what makes a lock-screen preview sufficient.
    subject: `${code} is your ${env.MAIL_FROM_NAME} code`,
    text,
    html,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
