import { env, isProduction, isTest, requireConfigured } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { recordSentMessage } from './dev-outbox.js';
import { composeMessage, toBase64Url, type Message, type Sender } from './mime.js';

/**
 * Mail, over HTTPS or not at all.
 *
 * ADR-007 removed SMTP entirely rather than keeping it as the local convenience: most
 * VPS hosts block outbound 25/465/587, so an SMTP send does not fail — it hangs until
 * it times out, and the 2022 deployment crash-looped on exactly that. A transport that
 * cannot be the production one only buys a class of bug that appears in production.
 *
 * `console` prints and opens no socket at all, so it cannot be mistaken for evidence
 * that sending works.
 */

const sender: Sender = { address: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME };

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Mints an access token from the stored refresh token, cached until shortly before it
 * expires. Google's tokens last an hour; refreshing per message would add a round trip
 * to every sign-in for no reason.
 */
async function accessToken(): Promise<string> {
  requireConfigured('Gmail sending', [
    'MAIL_CLIENT_ID',
    'MAIL_CLIENT_SECRET',
    'MAIL_REFRESH_TOKEN',
  ]);

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MAIL_CLIENT_ID ?? '',
      client_secret: env.MAIL_CLIENT_SECRET ?? '',
      refresh_token: env.MAIL_REFRESH_TOKEN ?? '',
      grant_type: 'refresh_token',
    }),
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // Google reports a revoked or wrong-project refresh token as `invalid_grant`,
    // which reads like a code bug and is a credentials one. Say which.
    const detail =
      payload && typeof payload === 'object' && 'error' in payload
        ? String(payload.error)
        : String(response.status);
    throw new Error(`Gmail refused the refresh token (${detail}). Re-mint MAIL_REFRESH_TOKEN.`);
  }

  const { access_token: value, expires_in: lifetime } = payload as {
    access_token?: string;
    expires_in?: number;
  };
  if (!value) throw new Error('Gmail returned no access token.');

  cachedToken = { value, expiresAt: Date.now() + (lifetime ?? 3600) * 1000 };
  return value;
}

/**
 * Proves the credentials work without emitting a message.
 *
 * Called at boot and **never fatally**: a mail outage must not take the API down, which
 * is the specific mistake that crash-looped the 2022 container.
 */
export async function verifyMailTransport(): Promise<void> {
  if (env.MAIL_DRIVER === 'console') return;
  await accessToken();
}

async function sendViaGmail(message: Message): Promise<void> {
  const token = await accessToken();
  const response = await fetch(SEND_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: toBase64Url(composeMessage(message, sender)) }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // 403 accessNotConfigured means the Gmail API is not enabled on the Cloud project
    // owning MAIL_CLIENT_ID — an account setting, not anything in this repository.
    throw new Error(`Gmail rejected the message (${response.status}): ${body.slice(0, 300)}`);
  }
}

function sendViaConsole(message: Message): void {
  // The integration suite reads codes from the dev outbox, not from stdout, and a
  // hundred printed messages bury the one failing assertion.
  if (isTest) return;
  const rule = '─'.repeat(72);
  process.stdout.write(
    `\n${rule}\n  To: ${message.to}\n  Subject: ${message.subject}\n${rule}\n${message.text}\n${rule}\n\n`,
  );
}

/**
 * Sends, or throws.
 *
 * It deliberately does not swallow failures the way the 2022 `sendMail` did — that one
 * returned the string `"failed"`, which every call site ignored, so a broken mail path
 * looked exactly like a working one. The caller decides what a failure means; for a
 * sign-in code it means telling the shopper rather than showing them an empty inbox.
 */
export async function sendMail(message: Message): Promise<void> {
  if (env.MAIL_DRIVER === 'gmail-api') {
    await sendViaGmail(message);
  } else {
    sendViaConsole(message);
  }

  recordSentMessage(message, env.MAIL_DRIVER);
  logger.info({ to: isProduction ? undefined : message.to, driver: env.MAIL_DRIVER }, 'mail: sent');
}
