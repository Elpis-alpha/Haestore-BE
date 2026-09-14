import { Queue, Worker, type Job } from 'bullmq';
import { redis } from '../../cache/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { Order } from './order.model.js';
import { OrderOutbox, type OrderOutboxDoc } from './order-outbox.model.js';
import { releaseReservation } from './order.service.js';
import { transition } from './order.service.js';
import { sendOrderConfirmation } from './order.mail.js';
import { SupportTicket } from '../support/support-ticket.model.js';
import { sendSupportReply } from '../support/support.mail.js';

/**
 * The two background jobs the checkout needs.
 *
 * **The sweeper** returns stock from checkouts that were never paid for. Without it, an
 * abandoned payment holds its reservation forever and the shop sells out to people who
 * never paid — the exact failure that makes a *reserving cart* a bad idea, moved to the
 * one place where a hold is justified and bounded.
 *
 * **The mail drain** turns order-outbox rows into emails. It is a sweep rather than a
 * change stream, for the reasons in order-outbox.model.ts: nobody notices a receipt
 * three seconds late, and a second change stream is a second lease and reconnect loop to
 * maintain. The post-commit enqueue is the fast path and is allowed to fail, because the
 * row is already durable.
 */

export const ORDER_QUEUE = 'order-jobs';

export type OrderMailJob = { kind: 'order-mail'; outboxId: string };
export type SweepJob = { kind: 'sweep-reservations' };
export type OrderJob = OrderMailJob | SweepJob;

let queue: Queue<OrderJob> | null = null;

export function orderQueue(): Queue<OrderJob> {
  queue ??= new Queue<OrderJob>(ORDER_QUEUE, {
    connection: redis.duplicate(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      // Same reasoning as the search queue: BullMQ treats a custom job id as unique
      // across retained states, so keeping completed jobs would suppress the next
      // enqueue for the same outbox row.
      removeOnComplete: true,
      removeOnFail: { count: 1_000 },
    },
  });
  return queue;
}

/**
 * The opportunistic fast path, called after the transaction commits.
 *
 * Deliberately fire-and-forget: the outbox row is the guarantee and the sweep will find
 * it within the interval, so a failure here costs latency and nothing else. Job ids use
 * `__` rather than `:` — BullMQ rejects a colon, and the resulting throw is caught and
 * logged, which presents as mail that silently never sends.
 */
export async function enqueueOrderMail(outboxId: string): Promise<void> {
  await orderQueue()
    .add('order-mail', { kind: 'order-mail', outboxId }, { jobId: `order-mail__${outboxId}` })
    .catch((err: Error) =>
      logger.warn(
        { err: err.message, outboxId },
        'order: fast-path mail enqueue failed, the sweep will get it',
      ),
    );
}

/**
 * Cancels unpaid orders whose hold has run out, and gives the stock back.
 *
 * The status filter is the guard, exactly as everywhere else: `transition` to `canceled`
 * matches only an order still in `pending_payment`, so an order that was paid in the
 * instant between the query and the write is not canceled out from under its customer.
 * `markOrderPaid` also clears `reservationExpiresAt`, so a paid order stops being
 * visible to this query at all — two independent reasons the race is safe.
 */
export async function sweepExpiredReservations(now = new Date()): Promise<number> {
  const expired = await Order.find({
    status: 'pending_payment',
    reservationExpiresAt: { $ne: null, $lte: now },
  })
    .limit(200)
    .select('_id orderNumber lines stockReserved');

  let canceled = 0;

  for (const order of expired) {
    const result = await transition(order._id, 'canceled', 'sweeper', 'reservation expired');
    if (!result.moved) continue;

    await releaseReservation(result.order, 'sweeper');
    canceled += 1;
  }

  if (canceled > 0) logger.info({ canceled }, 'order: swept expired reservations');
  return canceled;
}

/** Drains unprocessed outbox rows. The safety net under the post-commit enqueue. */
export async function sweepOrderOutbox(): Promise<number> {
  const rows = await OrderOutbox.find({ processedAt: null }).sort({ createdAt: 1 }).limit(100);
  let sent = 0;

  for (const row of rows) {
    try {
      await deliver(row);
      await OrderOutbox.updateOne({ _id: row._id }, { $set: { processedAt: new Date() } });
      sent += 1;
    } catch (err) {
      await OrderOutbox.updateOne(
        { _id: row._id },
        { $inc: { attempts: 1 }, $set: { lastError: (err as Error).message } },
      );
      logger.error(
        { err: (err as Error).message, outboxId: String(row._id) },
        'order: outbox delivery failed',
      );
    }
  }

  return sent;
}

async function deliver(row: OrderOutboxDoc): Promise<void> {
  if (row.kind === 'support-reply') {
    const ticket = await SupportTicket.findById(row.ticket);
    // The message is named, not "the latest", so two replies sent a minute apart are two
    // emails with two different bodies rather than the second one twice.
    const message = ticket?.messages.find((m) => String(m._id) === String(row.messageId));
    if (ticket && message) await sendSupportReply(ticket, message);
    return;
  }

  const order = await Order.findById(row.order);
  if (!order) return;
  if (row.kind === 'order-confirmation') await sendOrderConfirmation(order);
}

async function handleOrderJob(job: Job<OrderJob>): Promise<void> {
  if (job.data.kind === 'sweep-reservations') {
    await sweepExpiredReservations();
    return;
  }

  const row = await OrderOutbox.findById(job.data.outboxId);
  // Already drained by the sweep. Both paths racing for the same row is expected, and
  // the loser doing nothing is the correct outcome.
  if (!row || row.processedAt) return;

  await deliver(row);
  await OrderOutbox.updateOne({ _id: row._id }, { $set: { processedAt: new Date() } });
}

let worker: Worker<OrderJob> | null = null;
let sweepTimer: NodeJS.Timeout | null = null;

export function startOrderWorker(): Worker<OrderJob> | null {
  if (!env.ORDER_JOBS_ENABLED) {
    logger.info('order: background jobs disabled in this process (ORDER_JOBS_ENABLED=false)');
    return null;
  }
  if (worker) return worker;

  worker = new Worker<OrderJob>(ORDER_QUEUE, handleOrderJob, {
    connection: redis.duplicate(),
    concurrency: 4,
  });
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err: err.message }, 'order: job failed'),
  );
  worker.on('error', (err) => logger.error({ err: err.message }, 'order: worker error'));

  /**
   * The sweep runs on a plain interval in-process rather than as a BullMQ repeatable
   * job. Both sweeps are idempotent and cheap, several replicas running them is
   * harmless, and an interval has no scheduler state to get wedged — which a repeatable
   * job absolutely does, and diagnosing one that has stopped firing is unpleasant.
   */
  sweepTimer = setInterval(() => {
    void sweepExpiredReservations().catch((err: Error) =>
      logger.error({ err: err.message }, 'order: reservation sweep failed'),
    );
    void sweepOrderOutbox().catch((err: Error) =>
      logger.error({ err: err.message }, 'order: outbox sweep failed'),
    );
  }, env.ORDER_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  logger.info('order: worker and sweeper started');
  return worker;
}

export async function stopOrderWorker(): Promise<void> {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
