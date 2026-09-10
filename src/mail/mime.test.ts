import { describe, expect, it } from 'vitest';
import { composeMessage, encodeHeaderValue, formatAddress, toBase64Url } from './mime.js';

const from = { address: 'hello@haestore.test', name: 'Hæstore' };

describe('encodeHeaderValue', () => {
  it('leaves an ASCII header alone, because an encoded-word there is just noise', () => {
    expect(encodeHeaderValue('Your sign-in code')).toBe('Your sign-in code');
  });

  it('encodes a header carrying the shop name, which is the case that made this exist', () => {
    const encoded = encodeHeaderValue('Your Hæstore sign-in code');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8')).toBe(
      'Your Hæstore sign-in code',
    );
  });

  it('never splits a multi-byte character across two encoded-words', () => {
    // Long enough to force chunking, and every character is 2 bytes, so a byte-wise
    // split would land mid-character and decode to a replacement character.
    const value = 'æ'.repeat(120);
    const encoded = encodeHeaderValue(value);
    const decoded = encoded
      .split('\r\n ')
      .map((word) => Buffer.from(word.slice(10, -2), 'base64').toString('utf8'))
      .join('');

    expect(decoded).toBe(value);
    expect(decoded).not.toContain('�');
  });

  it('keeps every encoded-word within the 75-character limit', () => {
    for (const word of encodeHeaderValue('æ'.repeat(200)).split('\r\n ')) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });
});

describe('formatAddress', () => {
  it('encodes a non-ASCII display name rather than quoting it', () => {
    // A quoted-string cannot hold a raw æ. Gmail's answer to a malformed From is to
    // rewrite the header, so this failing would be silent.
    expect(formatAddress(from)).toBe('=?UTF-8?B?SMOmc3RvcmU=?= <hello@haestore.test>');
  });

  it('quotes an ASCII name and escapes a quote inside it', () => {
    expect(formatAddress({ address: 'a@b.test', name: 'The "Good" Shop' })).toBe(
      '"The \\"Good\\" Shop" <a@b.test>',
    );
  });
});

describe('composeMessage', () => {
  const raw = composeMessage(
    {
      to: 'shopper@example.test',
      subject: 'Your Hæstore sign-in code',
      html: '<b>123456</b>',
      text: '123456',
    },
    from,
  );

  it('uses CRLF line endings throughout', () => {
    expect(raw.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
  });

  it('orders the parts least-preferred first, so a rich client shows the HTML', () => {
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
  });

  it('never emits a line over 998 octets, whatever the body contains', () => {
    const long = composeMessage(
      {
        to: 'a@b.test',
        subject: 's',
        html: `<p>${'x'.repeat(50_000)}</p>`,
        text: 'x'.repeat(50_000),
      },
      from,
    );
    for (const line of long.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(998);
  });

  it('closes the multipart with a terminating boundary', () => {
    const boundary = /boundary="(.+)"/.exec(raw)?.[1];
    expect(boundary).toBeTruthy();
    expect(raw).toContain(`--${boundary}--`);
  });

  it('does not leak the recipient into the body encoding', () => {
    expect(raw).toContain('To: shopper@example.test');
  });
});

describe('toBase64Url', () => {
  it('uses the URL alphabet and drops padding, which is what Gmail accepts', () => {
    const encoded = toBase64Url('subjects?>>');
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe('subjects?>>');
  });
});
