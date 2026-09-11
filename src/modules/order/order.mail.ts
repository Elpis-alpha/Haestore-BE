import { env } from '../../config/env.js';
import { formatMoney, multiplyMoney } from '../../lib/money.js';
import { sendMail } from '../../mail/transport.js';
import type { Message } from '../../mail/mime.js';
import type { OrderDoc } from './order.model.js';

/**
 * The order confirmation.
 *
 * Reached only through the outbox, never inline from a webhook handler — an outage at
 * Gmail must not make Stripe retry a payment. See order-outbox.model.ts.
 *
 * The receipt states what was charged, itemised, because "your order is confirmed" with
 * no numbers in it is the email people forward to support asking what they paid. Where
 * the shop charges no delivery and no tax, the totals block says so rather than leaving
 * the reader to wonder whether something is about to be added.
 */

export function orderConfirmationMessage(order: OrderDoc): Message {
  const lines = order.lines.map((line) => ({
    title: line.title,
    axes: line.axisValues.map((a) => a.value).join(' · '),
    quantity: line.quantity,
    total: formatMoney(multiplyMoney(line.unitPrice, line.quantity)),
  }));

  const grandTotal = formatMoney(order.totals.grandTotal);

  const text = [
    `Thank you — your order is confirmed.`,
    '',
    `Order ${order.orderNumber}`,
    '',
    ...lines.map(
      (line) =>
        `  ${line.quantity} × ${line.title}${line.axes ? ` (${line.axes})` : ''} — ${line.total}`,
    ),
    '',
    `Total: ${grandTotal}`,
    '',
    'Shipping to:',
    `  ${order.shippingAddress.name}`,
    `  ${order.shippingAddress.line1}`,
    ...(order.shippingAddress.line2 ? [`  ${order.shippingAddress.line2}`] : []),
    `  ${order.shippingAddress.city}${order.shippingAddress.region ? `, ${order.shippingAddress.region}` : ''} ${order.shippingAddress.postalCode ?? ''}`.trimEnd(),
    `  ${order.shippingAddress.country}`,
    '',
    'We will send another note when it ships.',
  ].join('\n');

  const rows = lines
    .map(
      (line) => `      <tr>
        <td style="padding:8px 0;font-size:15px;color:#2e2419">${escapeHtml(line.title)}${line.axes ? `<br><span style="font-size:13px;color:#7a6a52">${escapeHtml(line.axes)}</span>` : ''}</td>
        <td style="padding:8px 0;font-size:15px;color:#7a6a52;text-align:center">×${line.quantity}</td>
        <td style="padding:8px 0;font-size:15px;color:#2e2419;text-align:right;white-space:nowrap">${escapeHtml(line.total)}</td>
      </tr>`,
    )
    .join('\n');

  // Inline styles only, for the reason templates.ts gives: Gmail strips <style> blocks
  // in some clients and a half-applied stylesheet is worse than none.
  const html = `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f3ede2;font-family:Georgia,'Times New Roman',serif;color:#2e2419">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fbf8f2;border:1px solid #d9cdb8;border-radius:4px">
    <tr><td style="padding:32px">
      <p style="margin:0 0 24px;font-size:13px;letter-spacing:.08em;color:#7a6a52">${escapeHtml(env.MAIL_FROM_NAME)}</p>
      <h1 style="margin:0 0 8px;font-size:24px;font-weight:normal">Thank you — your order is confirmed.</h1>
      <p style="margin:0 0 24px;font-size:15px;color:#7a6a52">Order ${escapeHtml(order.orderNumber)}</p>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #e4dac6;border-bottom:1px solid #e4dac6;margin:0 0 16px">
${rows}
      </table>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
        <tr>
          <td style="padding:4px 0;font-size:17px;color:#2e2419">Total</td>
          <td style="padding:4px 0;font-size:17px;color:#2e2419;text-align:right">${escapeHtml(grandTotal)}</td>
        </tr>
      </table>
      <p style="margin:8px 0 24px;font-size:13px;color:#7a6a52">No delivery charge and no tax on this order.</p>

      <p style="margin:0 0 4px;font-size:13px;letter-spacing:.08em;color:#7a6a52">SHIPPING TO</p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4a3f30">
        ${escapeHtml(order.shippingAddress.name)}<br>
        ${escapeHtml(order.shippingAddress.line1)}<br>
        ${order.shippingAddress.line2 ? `${escapeHtml(order.shippingAddress.line2)}<br>` : ''}
        ${escapeHtml(order.shippingAddress.city)}${order.shippingAddress.region ? `, ${escapeHtml(order.shippingAddress.region)}` : ''} ${escapeHtml(order.shippingAddress.postalCode ?? '')}<br>
        ${escapeHtml(order.shippingAddress.country)}
      </p>

      <p style="margin:0;font-size:13px;line-height:1.6;color:#7a6a52">We will send another note when it ships.</p>
    </td></tr>
  </table>
</body></html>`;

  return {
    to: order.email,
    subject: `Your ${env.MAIL_FROM_NAME} order ${order.orderNumber}`,
    text,
    html,
  };
}

export async function sendOrderConfirmation(order: OrderDoc): Promise<void> {
  await sendMail(orderConfirmationMessage(order));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
