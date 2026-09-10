import { randomUUID } from 'node:crypto';

/**
 * RFC 5322 message composition.
 *
 * The Gmail API takes one field — a base64url-encoded RFC 5322 message — so composing
 * it is the entire job. The 2022 app used nodemailer's `streamTransport` purely as a
 * MIME builder and then threw the transport away; carrying a mail *library* to format
 * a header block, plus `googleapis` to make a single POST, is a lot of tree for two
 * HTTP calls that `fetch` already makes.
 *
 * What that library was actually buying is encoded here and tested: encoded-words for
 * non-ASCII headers, base64 bodies so no line can exceed 998 octets, and CRLF
 * everywhere. All three matter for this shop specifically, because the sender's
 * display name is "Hæstore" and an unencoded æ in a header is a malformed message.
 */

const CRLF = '\r\n';

export type Message = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type Sender = {
  address: string;
  name: string;
};

const isAscii = (value: string): boolean => !/[^\x20-\x7e]/.test(value);

/**
 * RFC 2047 encoded-word, chunked to keep each below the 75-character limit.
 *
 * Chunking walks code points rather than bytes: splitting a multi-byte character
 * across two encoded-words produces two invalid sequences, and the symptom is a
 * subject line with a replacement character in the middle of a word.
 */
export function encodeHeaderValue(value: string): string {
  if (isAscii(value)) return value;

  const words: string[] = [];
  let chunk = '';

  const flush = () => {
    if (chunk === '') return;
    words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
    chunk = '';
  };

  for (const character of value) {
    const candidate = chunk + character;
    // 12 is the fixed overhead of `=?UTF-8?B?` plus the closing `?=`.
    if (12 + Math.ceil(Buffer.byteLength(candidate, 'utf8') / 3) * 4 > 75) flush();
    chunk += character;
  }
  flush();

  return words.join(`${CRLF} `);
}

/** `Hæstore <hello@…>` — the display name encoded, the address never touched. */
export function formatAddress({ address, name }: Sender): string {
  if (name === '') return address;
  if (isAscii(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  return `${encodeHeaderValue(name)} <${address}>`;
}

/** Base64 body, hard-wrapped at 76 characters as RFC 2045 requires. */
function base64Body(content: string): string {
  return (
    Buffer.from(content, 'utf8')
      .toString('base64')
      .match(/.{1,76}/g) ?? ['']
  ).join(CRLF);
}

export function composeMessage(message: Message, from: Sender, now = new Date()): string {
  // A boundary must not occur in either part. A UUID cannot, and saying so beats
  // scanning the bodies for a randomly chosen delimiter.
  const boundary = `--=_hae_${randomUUID()}`;
  const domain = from.address.split('@')[1] ?? 'haestore.local';

  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  const part = (contentType: string, content: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${contentType}; charset=UTF-8`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(content),
    ].join(CRLF);

  return [
    headers.join(CRLF),
    '',
    // Plain text first: a multipart/alternative is ordered least to most preferred,
    // so putting the HTML first is how a client shows the fallback instead.
    part('text/plain', message.text),
    part('text/html', message.html),
    `--${boundary}--`,
    '',
  ].join(CRLF);
}

/** Gmail rejects standard base64 with a 400; it wants the URL alphabet, unpadded. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
