import mongoose from 'mongoose';
import { AppError, conflict, notFound, unauthenticated } from '../../lib/errors.js';
import { escapeRegExp } from '../../lib/regex.js';
import { logger } from '../../lib/logger.js';
import { User } from '../auth/user.model.js';
import { Order } from '../order/order.model.js';
import { isOrderNumber, normaliseOrderNumber } from '../order/order-number.js';
import { appendSupportOutbox } from '../order/order-outbox.model.js';
import {
  MESSAGE_LIMIT,
  OPEN_TICKET_LIMIT,
  SupportTicket,
  type SupportTicketAttrs,
  type TicketStatus,
} from './support-ticket.model.js';
import {
  generateTicketReference,
  isTicketReference,
  normaliseTicketReference,
} from './support-reference.js';
import type { AdminTicketQuery, OpenTicketInput, TicketListQuery } from './support.schema.js';

/**
 * Support conversations, from both sides of the counter.
 *
 * The same rule as every other write in this codebase: **a change of state is a guarded
 * write, and the guard is in the filter.** Appending a message is one `findOneAndUpdate`
 * whose filter carries the ownership check and the message cap together, so there is no
 * read-decide-write for two tabs, or two admins, to race.
 */

type TicketRow = SupportTicketAttrs & {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
  messages: (SupportTicketAttrs['messages'][number] & { _id: mongoose.Types.ObjectId })[];
};

/** The 100th message's slot. If it exists, the thread is full. */
const FULL = `messages.${MESSAGE_LIMIT - 1}`;

const referenceOf = (value: string) => {
  const reference = normaliseTicketReference(value);
  // A malformed reference is a conversation that does not exist, not a bad request.
  if (!isTicketReference(reference)) throw notFound('Conversation not found.');
  return reference;
};

const idOf = (value: string) => {
  if (!mongoose.isValidObjectId(value)) throw notFound('Conversation not found.');
  return new mongoose.Types.ObjectId(value);
};

function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

/* ---------------------------------------------------------------- customer -- */

export type CustomerMessage = { id: string; from: 'customer' | 'shop'; body: string; at: string };

export type CustomerTicket = {
  reference: string;
  subject: string;
  status: TicketStatus;
  orderNumber: string | null;
  createdAt: string;
  lastMessageAt: string;
  closedAt: string | null;
  messages: CustomerMessage[];
};

export type CustomerTicketSummary = Omit<CustomerTicket, 'messages' | 'closedAt'> & {
  lastMessage: { from: 'customer' | 'shop'; excerpt: string };
  /** The shop has replied since the customer last opened the conversation. */
  unread: boolean;
};

/**
 * The conversation as the customer sees it. Which admin wrote a reply is not part of it: the
 * customer is talking to the shop, and an admin's address is not theirs to hand out.
 */
function toCustomerTicket(ticket: TicketRow): CustomerTicket {
  return {
    reference: ticket.reference,
    subject: ticket.subject,
    status: ticket.status,
    orderNumber: ticket.orderNumber ?? null,
    createdAt: ticket.createdAt.toISOString(),
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    closedAt: ticket.closedAt ? ticket.closedAt.toISOString() : null,
    messages: ticket.messages.map((m) => ({
      id: String(m._id),
      from: m.from,
      body: m.body,
      at: m.at.toISOString(),
    })),
  };
}

/**
 * Opens a conversation.
 *
 * The order, when one is named, is looked up **among the caller's own orders**: a
 * conversation cannot be attached to somebody else's order by typing its number, and "that
 * order is not on your account" is the same answer whether the number exists or not.
 */
export async function openTicket(userId: string, input: OpenTicketInput): Promise<CustomerTicket> {
  const owner = new mongoose.Types.ObjectId(userId);
  const user = await User.findById(owner).select('email').lean();
  if (!user) throw unauthenticated();

  const openCount = await SupportTicket.countDocuments({ user: owner, status: { $ne: 'closed' } });
  if (openCount >= OPEN_TICKET_LIMIT) {
    throw conflict(
      `You have ${OPEN_TICKET_LIMIT} conversations open. Add to one of those, or close one you no longer need.`,
    );
  }

  let order: { _id: mongoose.Types.ObjectId; orderNumber: string } | null = null;
  if (input.orderNumber) {
    order = isOrderNumber(input.orderNumber)
      ? await Order.findOne({ orderNumber: normaliseOrderNumber(input.orderNumber), user: owner })
          .select('_id orderNumber')
          .lean()
      : null;
    if (!order) {
      throw new AppError(422, 'VALIDATION_FAILED', 'The request body failed validation.', {
        details: [{ path: 'orderNumber', message: 'That order is not on your account.' }],
      });
    }
  }

  const now = new Date();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const created = await SupportTicket.create({
        reference: generateTicketReference(),
        user: owner,
        email: user.email,
        subject: input.subject,
        order: order?._id ?? null,
        orderNumber: order?.orderNumber ?? null,
        status: 'open',
        messages: [{ from: 'customer', body: input.body, at: now }],
        lastMessageAt: now,
        customerReadAt: now,
      });
      return toCustomerTicket(created.toObject());
    } catch (err) {
      // A reference collision, one in a billion per pair. Draw again rather than fail.
      if (!isDuplicateKey(err)) throw err;
    }
  }
  throw new Error('support: could not draw an unused reference in three attempts');
}

export async function listTicketsForCustomer(userId: string, options: TicketListQuery) {
  const filter = { user: new mongoose.Types.ObjectId(userId) };
  const [rows, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort({ lastMessageAt: -1, _id: -1 })
      .skip((options.page - 1) * options.perPage)
      .limit(options.perPage)
      .select({
        reference: 1,
        subject: 1,
        status: 1,
        orderNumber: 1,
        createdAt: 1,
        lastMessageAt: 1,
        customerReadAt: 1,
        messages: { $slice: -1 },
      })
      .lean<TicketRow[]>(),
    SupportTicket.countDocuments(filter),
  ]);

  const data: CustomerTicketSummary[] = rows.map((row) => {
    const last = row.messages[row.messages.length - 1]!;
    return {
      reference: row.reference,
      subject: row.subject,
      status: row.status,
      orderNumber: row.orderNumber ?? null,
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
      lastMessage: { from: last.from, excerpt: excerpt(last.body) },
      unread: last.from === 'shop' && (!row.customerReadAt || last.at > row.customerReadAt),
    };
  });

  return {
    data,
    page: {
      page: options.page,
      perPage: options.perPage,
      total,
      totalPages: Math.max(Math.ceil(total / options.perPage), 1),
    },
  };
}

/**
 * One conversation, scoped to its owner in the query — "not yours" and "does not exist" are
 * the same 404 without a second check to forget. Opening it marks the shop's replies as seen.
 */
export async function getTicketForCustomer(
  userId: string,
  reference: string,
): Promise<CustomerTicket> {
  const ticket = await SupportTicket.findOneAndUpdate(
    { reference: referenceOf(reference), user: new mongoose.Types.ObjectId(userId) },
    { $set: { customerReadAt: new Date() } },
    { new: true, timestamps: false },
  ).lean<TicketRow | null>();
  if (!ticket) throw notFound('Conversation not found.');
  return toCustomerTicket(ticket);
}

/**
 * The customer adds a message. It reopens a closed conversation — writing to it is the
 * clearest possible way of saying it is not over — and hands the next move to the shop.
 */
export async function replyAsCustomer(
  userId: string,
  reference: string,
  body: string,
): Promise<CustomerTicket> {
  const filter = { reference: referenceOf(reference), user: new mongoose.Types.ObjectId(userId) };
  const now = new Date();

  const ticket = await SupportTicket.findOneAndUpdate(
    { ...filter, [FULL]: { $exists: false } },
    {
      $push: { messages: { from: 'customer', body, at: now } },
      $set: {
        status: 'open',
        lastMessageAt: now,
        customerReadAt: now,
        closedAt: null,
        closedBy: null,
      },
    },
    { new: true },
  ).lean<TicketRow | null>();

  if (ticket) return toCustomerTicket(ticket);
  if (!(await SupportTicket.exists(filter))) throw notFound('Conversation not found.');
  throw conflict(
    `This conversation has reached its ${MESSAGE_LIMIT} messages. Start a new one and mention its reference.`,
  );
}

/** Idempotent: closing a closed conversation leaves a closed conversation. */
export async function closeAsCustomer(userId: string, reference: string): Promise<CustomerTicket> {
  const filter = { reference: referenceOf(reference), user: new mongoose.Types.ObjectId(userId) };
  await SupportTicket.updateOne(
    { ...filter, status: { $ne: 'closed' } },
    { $set: { status: 'closed', closedAt: new Date(), closedBy: 'customer' } },
  );
  const ticket = await SupportTicket.findOne(filter).lean<TicketRow | null>();
  if (!ticket) throw notFound('Conversation not found.');
  return toCustomerTicket(ticket);
}

/* ------------------------------------------------------------------- admin -- */

export type AdminTicketSummary = {
  id: string;
  reference: string;
  subject: string;
  status: TicketStatus;
  email: string;
  orderNumber: string | null;
  createdAt: string;
  lastMessageAt: string;
  lastMessage: { from: 'customer' | 'shop'; excerpt: string };
};

export type AdminTicket = Omit<AdminTicketSummary, 'lastMessage'> & {
  closedAt: string | null;
  closedBy: 'customer' | 'shop' | null;
  customer: { id: string; email: string; name?: string } | null;
  order: { id: string; orderNumber: string; status: string } | null;
  messages: (CustomerMessage & { staffEmail: string | null })[];
};

/**
 * The inbox.
 *
 * Conversations that need a reply come **longest-waiting first**, because that is the order
 * they should be answered in; every other view is newest first. `q` takes a reference or the
 * start of an address, tried together, like the order list's search.
 */
export async function listTicketsForAdmin(options: AdminTicketQuery) {
  const filter: Record<string, unknown> = {};
  if (options.status) filter.status = options.status;
  if (options.q) {
    const q = options.q.trim();
    filter.$or = [
      ...(isTicketReference(q) ? [{ reference: normaliseTicketReference(q) }] : []),
      { email: { $regex: `^${escapeRegExp(q.toLowerCase())}` } },
    ];
  }

  const sort =
    options.status === 'open'
      ? ({ lastMessageAt: 1, _id: 1 } as const)
      : ({ lastMessageAt: -1, _id: -1 } as const);

  const [rows, total] = await Promise.all([
    SupportTicket.find(filter)
      .sort(sort)
      .skip((options.page - 1) * options.perPage)
      .limit(options.perPage)
      .select({
        reference: 1,
        subject: 1,
        status: 1,
        email: 1,
        orderNumber: 1,
        createdAt: 1,
        lastMessageAt: 1,
        messages: { $slice: -1 },
      })
      .lean<TicketRow[]>(),
    SupportTicket.countDocuments(filter),
  ]);

  const data: AdminTicketSummary[] = rows.map((row) => {
    const last = row.messages[row.messages.length - 1]!;
    return {
      id: String(row._id),
      reference: row.reference,
      subject: row.subject,
      status: row.status,
      email: row.email,
      orderNumber: row.orderNumber ?? null,
      createdAt: row.createdAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
      lastMessage: { from: last.from, excerpt: excerpt(last.body) },
    };
  });

  return {
    data,
    page: {
      page: options.page,
      perPage: options.perPage,
      total,
      totalPages: Math.max(Math.ceil(total / options.perPage), 1),
    },
  };
}

export async function getTicketForAdmin(idParam: string): Promise<AdminTicket> {
  const ticket = await SupportTicket.findById(idOf(idParam)).lean<TicketRow | null>();
  if (!ticket) throw notFound('Conversation not found.');

  const [customer, order] = await Promise.all([
    User.findById(ticket.user).select('email name').lean(),
    ticket.order ? Order.findById(ticket.order).select('orderNumber status').lean() : null,
  ]);

  return {
    id: String(ticket._id),
    reference: ticket.reference,
    subject: ticket.subject,
    status: ticket.status,
    email: ticket.email,
    orderNumber: ticket.orderNumber ?? null,
    createdAt: ticket.createdAt.toISOString(),
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    closedAt: ticket.closedAt ? ticket.closedAt.toISOString() : null,
    closedBy: ticket.closedBy ?? null,
    customer: customer
      ? {
          id: String(customer._id),
          email: customer.email,
          ...(customer.name ? { name: customer.name } : {}),
        }
      : null,
    order: order
      ? { id: String(order._id), orderNumber: order.orderNumber, status: order.status }
      : null,
    messages: ticket.messages.map((m) => ({
      id: String(m._id),
      from: m.from,
      body: m.body,
      at: m.at.toISOString(),
      staffEmail: m.staffEmail ?? null,
    })),
  };
}

/**
 * A reply from the shop, and the email that says so — **in one transaction.**
 *
 * The notification's intent is appended to the mail outbox alongside the message, so a
 * reply cannot be saved without its email being owed, and an email cannot be sent for a
 * reply that rolled back. The sweep delivers it; see order-jobs.ts. The message's id is
 * minted here so the outbox row can name it exactly.
 */
export async function replyAsShop(
  idParam: string,
  staff: { userId: string; email: string },
  body: string,
  close: boolean,
): Promise<AdminTicket> {
  const id = idOf(idParam);
  const now = new Date();
  const messageId = new mongoose.Types.ObjectId();
  let written = false;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      written = false;
      const ticket = await SupportTicket.findOneAndUpdate(
        { _id: id, [FULL]: { $exists: false } },
        {
          $push: {
            messages: {
              _id: messageId,
              from: 'shop',
              staff: new mongoose.Types.ObjectId(staff.userId),
              staffEmail: staff.email,
              body,
              at: now,
            },
          },
          $set: close
            ? { status: 'closed', lastMessageAt: now, closedAt: now, closedBy: 'shop' }
            : { status: 'answered', lastMessageAt: now, closedAt: null, closedBy: null },
        },
        { new: true, session },
      );
      if (!ticket) return;

      await appendSupportOutbox(session, { ticketId: ticket._id, messageId });
      written = true;
    });
  } finally {
    await session.endSession();
  }

  if (!written) {
    if (!(await SupportTicket.exists({ _id: id }))) throw notFound('Conversation not found.');
    throw conflict(
      `This conversation has reached its ${MESSAGE_LIMIT} messages. Ask the customer to start a new one.`,
    );
  }

  logger.info({ ticketId: String(id), by: staff.userId, close }, 'support: shop replied');
  return getTicketForAdmin(idParam);
}

/** Idempotent, like the customer's own close. */
export async function closeAsShop(idParam: string): Promise<AdminTicket> {
  await SupportTicket.updateOne(
    { _id: idOf(idParam), status: { $ne: 'closed' } },
    { $set: { status: 'closed', closedAt: new Date(), closedBy: 'shop' } },
  );
  return getTicketForAdmin(idParam);
}

/** Back into the inbox as needing a reply. Idempotent on a conversation that is not closed. */
export async function reopenAsShop(idParam: string): Promise<AdminTicket> {
  await SupportTicket.updateOne(
    { _id: idOf(idParam), status: 'closed' },
    { $set: { status: 'open', closedAt: null, closedBy: null } },
  );
  return getTicketForAdmin(idParam);
}
