import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { escapeRegExp } from '../../lib/regex.js';
import { logger } from '../../lib/logger.js';
import type { Money } from '../../lib/money.js';
import { User } from '../auth/user.model.js';
import { destroyAllSessions, listDevices } from '../auth/session.js';
import { Order } from '../order/order.model.js';
import { toAdminOrderSummary } from '../order/admin-order.presenter.js';

const PAID_STATES = ['paid', 'processing', 'shipped', 'delivered'];

type OrderStats = { orderCount: number; spent: Money[]; lastOrderAt: string | null };

const NO_ORDERS: OrderStats = { orderCount: 0, spent: [], lastOrderAt: null };

/**
 * Order counts and money kept, per customer, for one page of customers.
 *
 * One aggregation for the page rather than one per row. Grouped by currency as well as
 * by customer, because summing minor units across currencies is a number that means
 * nothing — the shop is USD today, and the day it is not this must not quietly add yen
 * to dollars.
 */
async function orderStatsFor(userIds: mongoose.Types.ObjectId[]): Promise<Map<string, OrderStats>> {
  const rows = await Order.aggregate<{
    _id: { user: mongoose.Types.ObjectId; currency: string };
    orders: number;
    spent: number;
    lastOrderAt: Date;
  }>([
    { $match: { user: { $in: userIds } } },
    {
      $group: {
        _id: { user: '$user', currency: '$currency' },
        orders: { $sum: 1 },
        spent: {
          $sum: { $cond: [{ $in: ['$status', PAID_STATES] }, '$totals.grandTotal.amount', 0] },
        },
        lastOrderAt: { $max: '$createdAt' },
      },
    },
  ]);

  const stats = new Map<string, OrderStats>();
  for (const row of rows) {
    const key = String(row._id.user);
    const current = stats.get(key) ?? { orderCount: 0, spent: [], lastOrderAt: null };
    current.orderCount += row.orders;
    if (row.spent > 0) current.spent.push({ amount: row.spent, currency: row._id.currency });
    const last = row.lastOrderAt.toISOString();
    if (!current.lastOrderAt || last > current.lastOrderAt) current.lastOrderAt = last;
    stats.set(key, current);
  }
  return stats;
}

type UserRow = {
  _id: mongoose.Types.ObjectId;
  email: string;
  name?: string | null;
  roles: string[];
  createdAt: Date;
  lastSeenAt?: Date | null;
};

function toCustomerSummary(user: UserRow, stats: OrderStats = NO_ORDERS) {
  return {
    id: String(user._id),
    email: user.email,
    ...(user.name ? { name: user.name } : {}),
    roles: user.roles,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt ? user.lastSeenAt.toISOString() : null,
    ...stats,
  };
}

/**
 * The customer list. An account exists only once someone has verified a code, so this
 * is people who have signed in at least once — guests who checked out and never came
 * back are in the order list under their address, not here.
 */
export async function listCustomers(options: { q?: string; page: number; perPage: number }) {
  const filter = options.q
    ? { email: { $regex: `^${escapeRegExp(options.q.trim().toLowerCase())}` } }
    : {};

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((options.page - 1) * options.perPage)
      .limit(options.perPage)
      .select('email name roles createdAt lastSeenAt')
      .lean<UserRow[]>(),
    User.countDocuments(filter),
  ]);

  const stats = await orderStatsFor(users.map((u) => u._id));

  return {
    data: users.map((user) => toCustomerSummary(user, stats.get(String(user._id)))),
    page: {
      page: options.page,
      perPage: options.perPage,
      total,
      totalPages: Math.max(Math.ceil(total / options.perPage), 1),
    },
  };
}

export async function getCustomer(id: string, viewerId: string) {
  if (!mongoose.isValidObjectId(id)) throw notFound('Customer not found.');
  const user = await User.findById(id)
    .select('email name roles createdAt lastSeenAt')
    .lean<UserRow | null>();
  if (!user) throw notFound('Customer not found.');

  const [stats, orders, devices] = await Promise.all([
    orderStatsFor([user._id]),
    Order.find({ user: user._id }).sort({ createdAt: -1 }).limit(10),
    // An empty current-session id, so no row is marked "this device" — it is not the
    // viewer's device list.
    listDevices(id, ''),
  ]);

  return {
    ...toCustomerSummary(user, stats.get(id)),
    self: id === viewerId,
    /**
     * On the ADMIN_EMAILS allowlist, so the bootstrap grants `admin` at every sign-in.
     * The console needs to know, because revoking the role from such an address would be
     * silently undone the next time they signed in.
     */
    bootstrapAdmin: env.ADMIN_EMAILS.includes(user.email),
    activeSessions: devices.length,
    recentOrders: orders.map(toAdminOrderSummary),
  };
}

/**
 * Signs a customer out of every device, now.
 *
 * Both halves, in this order: `$inc sessionVersion` is the nuclear revoke that takes
 * effect on their next request whatever Redis holds, and the Redis sweep then removes the
 * sessions so the device list is honest immediately rather than on next read.
 *
 * Refused for the caller's own account. Signing yourself out of everywhere from a page
 * about someone else is a mistake, and the account page already has the button for
 * doing it on purpose.
 */
export async function revokeCustomerSessions(id: string, actorId: string): Promise<number> {
  if (id === actorId) {
    throw badRequest('That is your own account. Use “Signed-in devices” on your account page.');
  }
  if (!mongoose.isValidObjectId(id)) throw notFound('Customer not found.');

  const user = await User.findByIdAndUpdate(id, { $inc: { sessionVersion: 1 } });
  if (!user) throw notFound('Customer not found.');

  const revoked = await destroyAllSessions(id);
  logger.info({ userId: id, by: actorId, revoked }, 'admin: customer signed out everywhere');
  return revoked;
}

/**
 * Grants or removes `admin`.
 *
 * **Either direction signs the person out everywhere.** Removing the role does not need
 * it for the role to lapse — roles are read on every request (ADR-010) — but an open
 * admin tab should stop working rather than render a console that 404s on its next click.
 *
 * Granting needs it more, and for a less obvious reason. Session fixation defence is a
 * new session id at every privilege change, and the plan asks for one at a role grant.
 * The admin performing the grant cannot rotate someone else's cookie; ending all of that
 * person's sessions is the only rotation available, and it is a complete one — a session
 * id planted in their browser before the grant does not become an admin session after it.
 *
 * The filter only matches when the role would actually change, so pressing Grant on an
 * existing admin is a no-op that signs nobody out.
 */
export async function setAdminRole(id: string, admin: boolean, actorId: string) {
  if (id === actorId) {
    throw badRequest('You cannot change your own role. Another admin has to do it.');
  }
  if (!mongoose.isValidObjectId(id)) throw notFound('Customer not found.');

  const user = await User.findById(id).select('email roles').lean();
  if (!user) throw notFound('Customer not found.');

  if (!admin && env.ADMIN_EMAILS.includes(user.email)) {
    throw conflict(
      `${user.email} is in ADMIN_EMAILS, so it would be made an admin again the next time ` +
        'it signs in. Remove it from the environment first.',
    );
  }

  const changed = await User.findOneAndUpdate(
    { _id: id, roles: admin ? { $ne: 'admin' } : 'admin' },
    {
      ...(admin ? { $addToSet: { roles: 'admin' } } : { $pull: { roles: 'admin' } }),
      $inc: { sessionVersion: 1 },
    },
    { new: true },
  );

  if (changed) {
    await destroyAllSessions(id);
    logger.info({ userId: id, admin, by: actorId }, 'admin: role changed, sessions ended');
  }

  return { changed: changed !== null };
}
