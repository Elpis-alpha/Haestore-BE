import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCategory } from '../modules/catalog/category.service.js';
import { createProduct } from '../modules/catalog/product.service.js';
import { SearchOutbox } from './outbox.model.js';
import { sweepOutboxOnce } from './relay.js';
import { searchQueue, stopSearchWorker } from './queue.js';

/**
 * Draining the outbox.
 *
 * Two mechanisms carry a row from MongoDB to the queue, and this covers both halves of
 * the arrangement:
 *
 *  - The **change stream** is the fast path. Its availability is a property of the
 *    database rather than of this code, and is asserted in scripts/probe-infra.mjs; what
 *    matters here is that a stream over `search_outbox` really does deliver the inserts
 *    a domain write produces.
 *  - The **sweep** is the safety net, and it is the half that has to be right when
 *    everything else has gone wrong — the process was down when the row was written, or
 *    the resume token has fallen off the oplog. It must find those rows, enqueue them,
 *    and not re-enqueue them for ever afterwards.
 */

async function shop() {
  return createCategory({
    name: 'Shop',
    parent: null,
    order: 0,
    validationMode: 'lenient',
    status: 'active',
  });
}

const bag = (categoryId: string, title: string) =>
  createProduct({
    title,
    categoryId,
    status: 'active',
    attributes: {},
    variantAxes: [],
    variants: [
      {
        axisValues: [],
        price: { amount: 1800, currency: 'USD' },
        stock: { onHand: 3, lowStockThreshold: 3, backorderable: false },
        imagePublicIds: [],
        status: 'active',
        position: 0,
      },
    ],
    images: [],
  });

beforeEach(async () => {
  await searchQueue().obliterate({ force: true });
});

afterAll(async () => {
  await searchQueue().obliterate({ force: true });
  await stopSearchWorker();
});

describe('the change stream the relay is built on', () => {
  it('delivers an outbox insert written inside a domain transaction', async () => {
    const category = await shop();

    const stream = SearchOutbox.watch([{ $match: { operationType: 'insert' } }], {
      fullDocument: 'updateLookup',
    });

    const delivered = new Promise<{ kind: string; entityId: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no change delivered in 10s')), 10_000);
      stream.on('change', (event) => {
        clearTimeout(timer);
        const row = (event as { fullDocument?: { kind: string; entityId: string | null } })
          .fullDocument;
        if (row) resolve(row);
      });
    });

    const product = await bag(String(category._id), 'Ethiopian');
    const row = await delivered;
    await stream.close();

    expect(row.kind).toBe('product');
    expect(row.entityId).toBe(String(product._id));
  }, 20_000);
});

describe('the sweep beneath it', () => {
  it('enqueues a row the stream never saw, and marks it processed', async () => {
    const category = await shop();
    const product = await bag(String(category._id), 'Ethiopian');

    // Nothing is draining in this suite, so the row is exactly what a process that was
    // down at write time would find when it came back up.
    expect(await SearchOutbox.countDocuments({ processedAt: null })).toBe(1);

    // graceMs 0, because the row is milliseconds old and the point is the selection, not
    // the wait.
    const swept = await sweepOutboxOnce({ graceMs: 0 });
    expect(swept).toBe(1);

    const job = await searchQueue().getJob(`product__${String(product._id)}`);
    expect(job?.data).toEqual({ kind: 'product', productId: String(product._id) });

    expect(await SearchOutbox.countDocuments({ processedAt: null })).toBe(0);
  });

  it('does not pick the same row up twice', async () => {
    const category = await shop();
    await bag(String(category._id), 'Ethiopian');

    expect(await sweepOutboxOnce({ graceMs: 0 })).toBe(1);
    // A sweep that kept re-finding processed rows would re-index the whole catalogue
    // every minute for ever.
    expect(await sweepOutboxOnce({ graceMs: 0 })).toBe(0);
  });

  it('leaves a row alone until it is older than the grace period', async () => {
    const category = await shop();
    await bag(String(category._id), 'Ethiopian');

    // The grace period is what stops the sweep racing the change stream for every row
    // and doubling the work in the normal case.
    expect(await sweepOutboxOnce({ graceMs: 60_000 })).toBe(0);
    expect(await SearchOutbox.countDocuments({ processedAt: null })).toBe(1);
  });

  it('collapses repeated writes to one product into a single queued job', async () => {
    const category = await shop();
    const product = await bag(String(category._id), 'Ethiopian');

    const { updateProduct } = await import('../modules/catalog/product.service.js');
    await updateProduct(String(product._id), { title: 'Ethiopian Yirgacheffe' });
    await updateProduct(String(product._id), { title: 'Ethiopian Guji' });

    expect(await SearchOutbox.countDocuments({})).toBe(3);
    await sweepOutboxOnce({ graceMs: 0 });

    // Three rows, one job: the job id is the product id, so an admin saving repeatedly
    // produces one index write — and because the worker re-reads from Mongo, it is the
    // latest state that gets written rather than the first.
    const counts = await searchQueue().getJobCounts();
    const pending = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
    expect(pending).toBe(1);
  });

  /**
   * The other half of that collapse, and the one that is dangerous.
   *
   * A custom job id is unique across every state BullMQ retains, `completed` included,
   * and `add()` with an existing id creates nothing and reports success. So retaining
   * completed jobs would make the *second* edit of a product a silent no-op — the outbox
   * row written, the relay reporting it dispatched, and the index never told.
   *
   * Observed on a running server before it was fixed: one settings sync completed and
   * every subsequent one was discarded, so a newly defined attribute never arrived.
   */
  it('enqueues again once the previous job for the same entity has finished', async () => {
    const category = await shop();
    const product = await bag(String(category._id), 'Ethiopian');
    const id = String(product._id);

    await sweepOutboxOnce({ graceMs: 0 });
    const first = await searchQueue().getJob(`product__${id}`);
    expect(first).toBeDefined();

    // Stand in for the worker having finished it.
    await first?.remove();

    const { updateProduct } = await import('../modules/catalog/product.service.js');
    await updateProduct(id, { title: 'Ethiopian Yirgacheffe' });
    expect(await sweepOutboxOnce({ graceMs: 0 })).toBe(1);

    const second = await searchQueue().getJob(`product__${id}`);
    expect(second).toBeDefined();
    expect(second?.id).toBe(`product__${id}`);
  });

  it('does not retain completed job ids, which would suppress the next enqueue', () => {
    // Asserted on the queue's own configuration, because the failure it prevents leaves
    // no trace anywhere else: no error, no failed job, just an index that stops updating.
    const options = searchQueue().defaultJobOptions;
    expect(options.removeOnComplete).toBe(true);
  });
});
