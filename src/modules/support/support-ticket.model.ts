import { Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { registerModel } from '../../db/register-model.js';

/**
 * A support conversation.
 *
 * The 2022 app had a `/complain` form that emailed the admin and stored nothing: no thread,
 * no history, no way for the person to see that anyone had read it, and no way for the shop
 * to find it again except by searching a mailbox. This is the replacement — a persisted
 * thread both sides read in the same place.
 *
 * **It requires an account**, and that is a decision rather than a gap; see ADR-014. The
 * short version is that signing in here is a code to an address, so an account is exactly
 * "an address that has been proven", and a thread that sends replies to an address nobody
 * proved is a way to make this shop email strangers.
 *
 * **Messages are embedded, capped at 100.** A conversation is read whole and written one
 * message at a time, and a hundred messages is a relationship rather than a support query.
 * The cap is enforced in the write's filter (`messages.99` must not exist), because array
 * validators do not run on `$push`.
 *
 * The status says who owes the next message, because that is the only question the inbox
 * and the customer are both asking:
 *
 * - `open` — the shop owes a reply.
 * - `answered` — the shop replied last; the customer may or may not need more.
 * - `closed` — either side ended it. A new message from the customer reopens it.
 */

export const TICKET_STATUSES = ['open', 'answered', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const MESSAGE_LIMIT = 100;
export const MESSAGE_MAX_LENGTH = 5000;
/**
 * A nuisance limit, not a security boundary: it is checked before the insert rather than
 * inside it, so two tabs at once could make a sixth. It exists so a confused person opens
 * one conversation about a parcel rather than seven.
 */
export const OPEN_TICKET_LIMIT = 5;

const messageSchema = new Schema({
  from: { type: String, required: true, enum: ['customer', 'shop'] },
  /** Which admin wrote a shop message. Shown in the console, never to the customer. */
  staff: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  staffEmail: { type: String, default: null },
  body: { type: String, required: true, trim: true, maxlength: MESSAGE_MAX_LENGTH },
  at: { type: Date, required: true, default: () => new Date() },
});

const supportTicketSchema = new Schema(
  {
    /** `SUP-XXXXXX`. What a customer quotes; see support-reference.ts. */
    reference: { type: String, required: true, unique: true, uppercase: true, trim: true },

    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** The address replies are sent to, as it was proven when the thread was opened. */
    email: { type: String, required: true, lowercase: true, trim: true },

    subject: { type: String, required: true, trim: true, maxlength: 160 },

    /** An order of the customer's own that the conversation is about, if they named one. */
    order: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    orderNumber: { type: String, default: null },

    status: { type: String, required: true, enum: TICKET_STATUSES, default: 'open' },

    messages: {
      type: [messageSchema],
      validate: {
        validator: (messages: unknown[]) =>
          messages.length >= 1 && messages.length <= MESSAGE_LIMIT,
        message: `A conversation holds between 1 and ${MESSAGE_LIMIT} messages.`,
      },
    },

    /** Sorts both inboxes. The customer's newest first; the shop's longest-waiting first. */
    lastMessageAt: { type: Date, required: true },

    /** When the customer last opened the thread, so a reply they have not seen is marked. */
    customerReadAt: { type: Date, default: null },

    closedAt: { type: Date, default: null },
    closedBy: { type: String, enum: ['customer', 'shop', null], default: null },
  },
  { timestamps: true, collection: 'support_tickets' },
);

/** The customer's own conversations. */
supportTicketSchema.index({ user: 1, lastMessageAt: -1 });
/** How many a customer has open. */
supportTicketSchema.index({ user: 1, status: 1 });
/** The inbox, filtered by who owes a reply and sorted by how long they have waited. */
supportTicketSchema.index({ status: 1, lastMessageAt: 1 });
/** The console's search by the start of an address. */
supportTicketSchema.index({ email: 1, lastMessageAt: -1 });

export type SupportTicketAttrs = InferSchemaType<typeof supportTicketSchema>;
export type SupportTicketDoc = HydratedDocument<SupportTicketAttrs>;
export type SupportMessageAttrs = InferSchemaType<typeof messageSchema>;

export const SupportTicket = registerModel('SupportTicket', supportTicketSchema);
