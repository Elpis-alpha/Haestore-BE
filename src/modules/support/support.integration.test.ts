import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { clearOutbox, readOutbox } from '../../mail/dev-outbox.js';
import { ADMIN_EMAIL, ORIGIN, signIn, type TestSession } from '../../test/sign-in.js';
import { Order } from '../order/order.model.js';
import { OrderOutbox } from '../order/order-outbox.model.js';
import { sweepOrderOutbox } from '../order/order-jobs.js';
import { MESSAGE_LIMIT, OPEN_TICKET_LIMIT, SupportTicket } from './support-ticket.model.js';

/**
 * Support conversations against a real replica set: ownership, who owes the next message,
 * the cap, and the reply notification travelling through the outbox to a real (console)
 * mail transport.
 */

const app = createApp();

type Ticket = {
  reference: string;
  status: 'open' | 'answered' | 'closed';
  orderNumber: string | null;
  messages: Record<string, unknown>[];
};
type AdminTicket = Ticket & { id: string; closedBy: string | null };

const ticketOf = (res: { body: unknown }) => (res.body as { data: { ticket: Ticket } }).data.ticket;
const adminTicketOf = (res: { body: unknown }) =>
  (res.body as { data: { ticket: AdminTicket } }).data.ticket;

const as = (session: TestSession) => ({
  get: (path: string) => request(app).get(path).set('Cookie', session.cookie),
  post: (path: string, body: object = {}) =>
    request(app).post(path).set('Origin', ORIGIN).set('Cookie', session.cookie).send(body),
});

const OPENING = {
  subject: 'Chipped bowl',
  body: 'The celadon bowl arrived with a chip on the rim.',
};

let admin: TestSession;
beforeEach(async () => {
  admin = await signIn(app, ADMIN_EMAIL);
});

async function open(session: TestSession, body: object = OPENING) {
  return ticketOf(await as(session).post('/api/support/tickets', body).expect(201));
}

async function adminIdOf(reference: string) {
  return String((await SupportTicket.findOne({ reference }).lean())!._id);
}

describe('opening a conversation', () => {
  it('asks a signed-out visitor to sign in', async () => {
    await request(app).get('/api/support/tickets').expect(401);
    await request(app).post('/api/support/tickets').set('Origin', ORIGIN).send(OPENING).expect(401);
  });

  it('starts a thread the shop owes a reply on, addressed to the account', async () => {
    const customer = await signIn(app, 'chipped@example.test');
    const ticket = await open(customer);

    expect(ticket.reference).toMatch(/^SUP-[0-9A-Z]{6}$/);
    expect(ticket.status).toBe('open');
    expect(ticket.messages).toEqual([
      expect.objectContaining({ from: 'customer', body: OPENING.body }),
    ]);

    const stored = await SupportTicket.findOne({ reference: ticket.reference }).lean();
    expect(stored!.email).toBe('chipped@example.test');
  });

  it('attaches one of the customer’s own orders, and refuses anyone else’s', async () => {
    const customer = await signIn(app, 'has-order@example.test');
    const other = await signIn(app, 'other@example.test');
    const orderFor = (userId: string, orderNumber: string) =>
      Order.create({
        orderNumber,
        user: new mongoose.Types.ObjectId(userId),
        email: 'x@example.test',
        status: 'delivered',
        lines: [
          {
            lineKey: 'k',
            product: new mongoose.Types.ObjectId(),
            variantId: new mongoose.Types.ObjectId(),
            sku: 'SKU',
            title: 'Thing',
            slug: 'thing',
            unitPrice: { amount: 100, currency: 'USD' },
            quantity: 1,
          },
        ],
        totals: {
          subtotal: { amount: 100, currency: 'USD' },
          grandTotal: { amount: 100, currency: 'USD' },
        },
        shippingAddress: { name: 'X', line1: '1 St', city: 'Town', country: 'IS' },
        payment: { provider: 'stripe' },
      });
    await orderFor(customer.userId, 'HAE-CJ0RTHPK');
    await orderFor(other.userId, 'HAE-ZZZZZZZZ');

    const refused = await as(customer)
      .post('/api/support/tickets', { ...OPENING, orderNumber: 'HAE-ZZZZZZZZ' })
      .expect(422);
    expect(
      (refused.body as { error: { details: { path: string }[] } }).error.details[0]?.path,
    ).toBe('orderNumber');

    // Typed the way it is read: lower case, a letter O for the zero, no hyphen.
    const ticket = await open(customer, { ...OPENING, orderNumber: 'hae cjorthpk' });
    expect(ticket.orderNumber).toBe('HAE-CJ0RTHPK');
  });

  it('asks for more than a word', async () => {
    const customer = await signIn(app, 'terse@example.test');
    await as(customer).post('/api/support/tickets', { subject: 'Hi', body: 'help' }).expect(422);
  });

  it('holds a customer to a handful of open conversations at once', async () => {
    const customer = await signIn(app, 'prolific@example.test');
    const opened: Ticket[] = [];
    for (let i = 0; i < OPEN_TICKET_LIMIT; i += 1) opened.push(await open(customer));

    await as(customer).post('/api/support/tickets', OPENING).expect(409);

    await as(customer).post(`/api/support/tickets/${opened[0]!.reference}/close`).expect(200);
    await as(customer).post('/api/support/tickets', OPENING).expect(201);
  });
});

describe('whose conversation it is', () => {
  it('is invisible to another customer, who gets the same answer as for one that does not exist', async () => {
    const owner = await signIn(app, 'owner@example.test');
    const nosy = await signIn(app, 'nosy@example.test');
    const ticket = await open(owner);

    await as(nosy).get(`/api/support/tickets/${ticket.reference}`).expect(404);
    await as(nosy)
      .post(`/api/support/tickets/${ticket.reference}/messages`, { body: 'Me too' })
      .expect(404);
    await as(nosy).get('/api/support/tickets/SUP-000000').expect(404);
    await as(nosy).get('/api/support/tickets/not-a-reference').expect(404);
  });
});

describe('the back and forth', () => {
  it('sends the shop’s reply to the customer through the outbox, and marks it unread until opened', async () => {
    const customer = await signIn(app, 'waiting-for-reply@example.test');
    const ticket = await open(customer);
    const id = await adminIdOf(ticket.reference);

    const replied = adminTicketOf(
      await as(admin)
        .post(`/api/admin/support/tickets/${id}/messages`, {
          body: 'Sorry about that.\n\nA new one is on its way.',
        })
        .expect(201),
    );
    expect(replied.status).toBe('answered');
    expect(replied.messages[1]).toMatchObject({ from: 'shop', staffEmail: ADMIN_EMAIL });

    // Owed, not yet sent: the row committed with the reply.
    const rows = await OrderOutbox.find({ kind: 'support-reply' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processedAt).toBeNull();

    type List = { data: { reference: string; unread: boolean; lastMessage: { from: string } }[] };
    const unread = (await as(customer).get('/api/support/tickets').expect(200)).body as List;
    expect(unread.data[0]).toMatchObject({ unread: true, lastMessage: { from: 'shop' } });

    clearOutbox();
    expect(await sweepOrderOutbox()).toBe(1);
    const sent = readOutbox().find((m) => m.to === 'waiting-for-reply@example.test');
    expect(sent?.subject).toBe(`Re: Chipped bowl [${ticket.reference}]`);
    expect(sent?.text).toContain('A new one is on its way.');
    expect(sent?.text).toContain(`/account/support/${ticket.reference}`);
    expect(
      (await OrderOutbox.findOne({ kind: 'support-reply' }).lean())!.processedAt,
    ).toBeInstanceOf(Date);

    // The customer's view names the shop, never the admin.
    const opened = ticketOf(
      await as(customer).get(`/api/support/tickets/${ticket.reference}`).expect(200),
    );
    expect(opened.messages[1]).toEqual({
      id: expect.any(String),
      from: 'shop',
      body: 'Sorry about that.\n\nA new one is on its way.',
      at: expect.any(String),
    });
    const read = (await as(customer).get('/api/support/tickets').expect(200)).body as List;
    expect(read.data[0]?.unread).toBe(false);
  });

  it('hands the next move back and forth, and a customer’s message reopens a closed thread', async () => {
    const customer = await signIn(app, 'back-and-forth@example.test');
    const ticket = await open(customer);
    const id = await adminIdOf(ticket.reference);
    const path = `/api/support/tickets/${ticket.reference}`;

    await as(admin)
      .post(`/api/admin/support/tickets/${id}/messages`, { body: 'Which bowl?' })
      .expect(201);
    expect(
      ticketOf(await as(customer).post(`${path}/messages`, { body: 'Celadon.' }).expect(201))
        .status,
    ).toBe('open');

    expect(ticketOf(await as(customer).post(`${path}/close`).expect(200)).status).toBe('closed');
    // Closing twice is still closed.
    expect(ticketOf(await as(customer).post(`${path}/close`).expect(200)).status).toBe('closed');

    const reopened = ticketOf(
      await as(customer).post(`${path}/messages`, { body: 'Actually…' }).expect(201),
    );
    expect(reopened.status).toBe('open');
    expect(reopened.messages).toHaveLength(4);
  });

  it('lets the shop reply and close in one step, and reopen later', async () => {
    const customer = await signIn(app, 'resolved@example.test');
    const ticket = await open(customer);
    const id = await adminIdOf(ticket.reference);

    const closed = adminTicketOf(
      await as(admin)
        .post(`/api/admin/support/tickets/${id}/messages`, {
          body: 'Refunded. Sorry!',
          close: true,
        })
        .expect(201),
    );
    expect(closed).toMatchObject({ status: 'closed', closedBy: 'shop' });

    const reopened = adminTicketOf(
      await as(admin).post(`/api/admin/support/tickets/${id}/reopen`).expect(200),
    );
    expect(reopened).toMatchObject({ status: 'open', closedBy: null });
  });

  it('refuses a message past the cap on either side, and owes no email for the refused one', async () => {
    const customer = await signIn(app, 'chatty@example.test');
    const ticket = await open(customer);
    const id = await adminIdOf(ticket.reference);

    await SupportTicket.updateOne(
      { _id: id },
      {
        $set: {
          messages: Array.from({ length: MESSAGE_LIMIT }, (_, i) => ({
            from: i % 2 ? 'shop' : 'customer',
            body: `Message ${i}`,
            at: new Date(),
          })),
        },
      },
    );

    await as(customer)
      .post(`/api/support/tickets/${ticket.reference}/messages`, { body: 'One more' })
      .expect(409);
    await as(admin)
      .post(`/api/admin/support/tickets/${id}/messages`, { body: 'One more' })
      .expect(409);
    expect(await OrderOutbox.countDocuments({ kind: 'support-reply' })).toBe(0);
  });
});

describe('the inbox', () => {
  it('lists conversations needing a reply longest-waiting first, and finds one by reference or address', async () => {
    const early = await signIn(app, 'early@example.test');
    const late = await signIn(app, 'late@example.test');
    const first = await open(early);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await open(late);

    type Inbox = { data: { reference: string }[] };
    const inbox = (await as(admin).get('/api/admin/support/tickets?status=open').expect(200))
      .body as Inbox;
    expect(inbox.data.map((t) => t.reference)).toEqual([first.reference, second.reference]);

    const typed = second.reference.toLowerCase().replace(/0/g, 'o');
    const byReference = (
      await as(admin)
        .get(`/api/admin/support/tickets?q=${encodeURIComponent(typed)}`)
        .expect(200)
    ).body as Inbox;
    expect(byReference.data.map((t) => t.reference)).toEqual([second.reference]);

    const byEmail = (await as(admin).get('/api/admin/support/tickets?q=EARLY@').expect(200))
      .body as Inbox;
    expect(byEmail.data.map((t) => t.reference)).toEqual([first.reference]);

    type Dash = {
      data: { support: { waiting: { count: number; oldest: { reference: string }[] } } };
    };
    const dashboard = (await as(admin).get('/api/admin/dashboard').expect(200)).body as Dash;
    expect(dashboard.data.support.waiting.count).toBe(2);
    expect(dashboard.data.support.waiting.oldest[0]?.reference).toBe(first.reference);
  });
});
