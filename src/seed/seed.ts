import mongoose from 'mongoose';
import { redis } from '../cache/redis.js';
import { env, isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { User } from '../modules/auth/user.model.js';
import { addLine, clearCart } from '../modules/cart/cart.service.js';
import { AttributeDefinition } from '../modules/catalog/attribute-definition.model.js';
import { createAttributeDefinitionSchema } from '../modules/catalog/attribute-definition.schema.js';
import { createAttributeDefinition } from '../modules/catalog/attribute-definition.service.js';
import { clearValidatorCache } from '../modules/catalog/attribute-validator.js';
import { Category } from '../modules/catalog/category.model.js';
import { bindAttributeSchema, createCategorySchema } from '../modules/catalog/category.schema.js';
import {
  bindAttribute,
  createCategory,
  setSuppressedKeys,
} from '../modules/catalog/category.service.js';
import { Product } from '../modules/catalog/product.model.js';
import { createProductSchema } from '../modules/catalog/product.schema.js';
import { createProduct } from '../modules/catalog/product.service.js';
import { createCheckoutSchema } from '../modules/checkout/checkout.schema.js';
import { createOrderFromCart } from '../modules/checkout/checkout.service.js';
import { OrderOutbox } from '../modules/order/order-outbox.model.js';
import { Order } from '../modules/order/order.model.js';
import { markOrderPaid, shipOrder, transition } from '../modules/order/order.service.js';
import type { OrderStatus } from '../modules/order/order-status.js';
import { Review } from '../modules/review/review.model.js';
import { writeReviewSchema } from '../modules/review/review.schema.js';
import { hideReview, keepReview, writeReview } from '../modules/review/review.service.js';
import { saveDraftSchema } from '../modules/storefront/storefront.schema.js';
import { openDraft, publishDraft, saveDraft } from '../modules/storefront/storefront.service.js';
import { SupportTicket } from '../modules/support/support-ticket.model.js';
import { openTicketSchema } from '../modules/support/support.schema.js';
import { openTicket, replyAsCustomer, replyAsShop } from '../modules/support/support.service.js';
import { SearchOutbox } from '../search/outbox.model.js';
import { reindexAll } from '../search/reindex.js';
import {
  DEFINITIONS,
  PRODUCTS,
  SHELVES,
  catalogueProblems,
  type SeedProduct,
  type SeedShelf,
} from './catalogue/index.js';
import { PEOPLE, type SeedPerson } from './people.js';
import { productImage, readLock, specKey, type LockedPhoto, type PhotoLock } from './photos.js';
import { createRandom, type Random } from './random.js';
import { ratingFor, reviewWords } from './reviews.js';
import { HANDPICKED, homeSections } from './storefront.js';
import { defaultCacheDir, UnsplashClient } from './unsplash.js';

/**
 * The demo shop, built the way the shop builds itself.
 *
 * **Every record goes through the service a person's request would reach, after the schema
 * that request would be parsed by.** Definitions through `createAttributeDefinition`,
 * shelves through `createCategory` and `bindAttribute`, products through `createProduct`,
 * orders through a bag, a checkout and `markOrderPaid`, stock out through `shipOrder`,
 * reviews through `writeReview`. Nothing is inserted around them. That is what makes the
 * seeded shop evidence rather than decoration: every derived figure on it — a price range,
 * a rating, a stock count, a facet — was derived by the code that derives it in production,
 * and the integration suite checks that they agree with the facts underneath.
 *
 * **The one thing written directly is time.** Services stamp `now`, and a shop whose every
 * order was placed in the same minute has no history to look at, so dates are moved into
 * the past afterwards: orders across five months, reviews after deliveries, conversations
 * after the orders they are about. Nothing derived depends on a date, so moving them changes
 * what the pages say and nothing about whether the figures are right.
 *
 * **It is deterministic.** A fixed random seed decides who bought what and what they
 * thought of it, so every reseed produces the same shop and the screenshots stay true.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The year the shop would like you to think it opened. */
export const SEED = 1822;

/** Published in the last fortnight, so "Just put out" has something to show. */
const JUST_PUT_OUT = new Set([
  'Tieguanyin Oolong',
  'Tall Bottle Vase',
  'Alpaca Blanket',
  'Cretan Thyme Honey',
  'Ash Dibber',
  'Beeswax Tapers, pair',
]);

type ScriptedReview = { rating: number; title: string; body: string; hide?: string } | null;

/**
 * The few orders the demo depends on, placed deliberately rather than left to chance:
 *
 * - **One five-star review of a small lot**, which the Bayesian sort ranks below the house
 *   espresso's dozens at 4.8 — the case REVIEWS-AND-SUPPORT.md describes.
 * - **One review the shop hid**, so the moderation queue and the author's view of a hidden
 *   review both have something in them.
 * - **An order a support conversation is about.** `null` means "bought, not reviewed".
 * - **An order shipped, one packing and one just paid**, whatever the random history does.
 */
const SCRIPT: {
  person: string;
  daysAgo: number;
  lines: { title: string; axis?: Record<string, string> }[];
  reviews?: Record<string, ScriptedReview>;
}[] = [
  {
    person: 'Imogen Hale',
    daysAgo: 34,
    lines: [{ title: 'Kivu Honey, small lot' }],
    reviews: {
      'Kivu Honey, small lot': {
        rating: 5,
        title: 'The best thing I have drunk this year',
        body: 'Apricot and something floral, and sweet enough that I stopped adding milk. I wish there were more of it.',
      },
    },
  },
  {
    person: 'Rufus Ellery',
    daysAgo: 52,
    lines: [{ title: 'Everyday Mug', axis: { glaze: 'tenmoku' } }],
    reviews: {
      'Everyday Mug': {
        rating: 1,
        title: 'Cheaper elsewhere',
        body: 'You can get mugs like this for a third of the price. Search for my shop, handmade mug deals, and see.',
        hide: 'This advertises another shop rather than describing the mug, so it is not shown with the reviews.',
      },
    },
  },
  {
    person: 'Ada Lindqvist',
    daysAgo: 12,
    lines: [{ title: 'Everyday Mug', axis: { glaze: 'celadon' } }, { title: 'The House Espresso' }],
    reviews: { 'Everyday Mug': null },
  },
  // One order in each unfinished state, so "parcels to pack" is never empty on a fresh shop.
  { person: 'Clara Dubois', daysAgo: 5, lines: [{ title: 'Uji Sencha' }] },
  { person: 'Priya Raman', daysAgo: 2, lines: [{ title: 'Linen Tea Towel' }] },
  { person: 'Jonah Whitfield', daysAgo: 0.3, lines: [{ title: 'Flaked Sea Salt' }] },
];

export type SeedOptions = {
  /** Replace whatever is in the database. Without it, a database with a shop in it is refused. */
  reset?: boolean;
  /** How many orders to invent on top of the scripted ones. */
  orders?: number;
  /** Put the locked Unsplash photographs on the products. */
  photos?: boolean;
  /** Report the photographs' downloads to Unsplash, as far as the quota allows. */
  reportDownloads?: boolean;
  /** Rebuild the search index at the end. Needs Meilisearch connected. */
  reindex?: boolean;
  allowProduction?: boolean;
  /** The moment the shop's history runs up to. */
  now?: Date;
};

export type SeedReport = {
  definitions: number;
  shelves: number;
  products: { live: number; draft: number; photographed: number };
  customers: number;
  orders: Partial<Record<OrderStatus, number>>;
  reviews: { published: number; hidden: number; unread: number };
  conversations: number;
  frontPage: number;
  downloads: { reported: number; owed: number } | null;
  search: { indexed: number } | null;
};

export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefused';
  }
}

type ShelfRef = { id: string; path: string; depth: number };
type Stocked = { id: string; seed: SeedProduct; publishedAt: Date; photos: LockedPhoto[] };
type Customer = { id: string; person: SeedPerson };
type Staff = { userId: string; email: string };
type Placed = {
  orderNumber: string;
  customer: Customer;
  status: OrderStatus;
  deliveredAt: Date | null;
  titles: string[];
};

export async function runSeed(options: SeedOptions = {}): Promise<SeedReport> {
  const now = options.now ?? new Date();
  const random = createRandom(SEED);

  const problems = catalogueProblems();
  if (problems.length > 0) {
    throw new SeedRefused(`The catalogue data has problems:\n  ${problems.join('\n  ')}`);
  }
  if (isProduction && !options.allowProduction) {
    throw new SeedRefused(
      'Refusing to seed a production database: the seed replaces the shop with an invented one.',
    );
  }

  await prepareDatabase(options.reset ?? false);

  const definitions = await plantDefinitions();
  const shelves = await plantShelves(definitions);
  logger.info({ definitions: definitions.size, shelves: shelves.size }, 'seed: shelves built');

  const lock = options.photos === false ? {} : readLock();
  const catalogue = await stockShelves(shelves, lock, now, random);
  logger.info({ products: catalogue.length }, 'seed: shelves stocked');

  const { customers, staff } = await openAccounts(now, random);
  const placed = await tradeHistory({
    catalogue,
    customers,
    staff,
    now,
    random,
    count: options.orders ?? 240,
  });
  logger.info({ orders: placed.length }, 'seed: history written');

  const conversations = await holdConversations(placed, customers, staff, now);
  const frontPage = await composeFrontPage(catalogue, shelves, staff);

  // Every receipt and reply was "sent" when it happened. Nothing seeded may owe an email.
  await OrderOutbox.updateMany({ processedAt: null }, { $set: { processedAt: now } });

  const used = catalogue.flatMap((product) => product.photos);
  const downloads =
    options.reportDownloads === false || used.length === 0 ? null : await reportDownloads(used);

  const search = options.reindex === false ? null : await rebuildSearch();

  return {
    definitions: definitions.size,
    shelves: shelves.size,
    products: {
      live: catalogue.filter((p) => p.seed.status !== 'draft').length,
      draft: catalogue.filter((p) => p.seed.status === 'draft').length,
      photographed: catalogue.filter((p) => p.photos.length > 0).length,
    },
    customers: customers.length,
    orders: placed.reduce<Partial<Record<OrderStatus, number>>>((counts, order) => {
      counts[order.status] = (counts[order.status] ?? 0) + 1;
      return counts;
    }, {}),
    reviews: {
      published: await Review.countDocuments({ status: 'published' }),
      hidden: await Review.countDocuments({ status: 'hidden' }),
      unread: await Review.countDocuments({ needsReview: true }),
    },
    conversations,
    frontPage,
    downloads,
    search,
  };
}

/* ------------------------------------------------------------------ database -- */

async function prepareDatabase(reset: boolean): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('seed: MongoDB is not connected');

  const occupied = await Promise.all(
    [Product, Category, AttributeDefinition, Order].map((model) => model.exists({})),
  );
  if (occupied.some(Boolean) && !reset) {
    throw new SeedRefused(
      'This database already has a shop in it. `npm run seed -- --reset` replaces everything ' +
        'in it — products, orders, accounts — with the demo shop.',
    );
  }

  if (reset) {
    const collections = await db.collections();
    await Promise.all(
      collections
        .filter((c) => !c.collectionName.startsWith('system.'))
        .map((c) => c.deleteMany({})),
    );
    // The effective-attribute cache is keyed by category id and version counter. New ids
    // cannot collide with old entries, but the counters would carry on from the old shop,
    // and a clean slate is easier to reason about than a correct but inherited one.
    await deleteKeys('catalog:*');
    clearValidatorCache();
  }

  // Several services' guarantees are unique indexes — one review per person per product,
  // one payment per order — so the indexes exist before the first write rather than
  // whenever Mongoose finishes building them in the background.
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
}

async function deleteKeys(pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

/* ----------------------------------------------------------------- catalogue -- */

async function plantDefinitions(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const definition of DEFINITIONS) {
    const created = await createAttributeDefinition(
      createAttributeDefinitionSchema.parse(definition),
    );
    ids.set(created.key, String(created._id));
  }
  return ids;
}

async function plantShelves(definitions: Map<string, string>): Promise<Map<string, ShelfRef>> {
  const shelves = new Map<string, ShelfRef>();

  const plant = async (nodes: SeedShelf[], parent: ShelfRef | null) => {
    for (const [order, node] of nodes.entries()) {
      const category = await createCategory(
        createCategorySchema.parse({
          name: node.name,
          slug: node.slug,
          description: node.description,
          parent: parent?.id ?? null,
          order,
        }),
      );
      const ref = { id: String(category._id), path: category.path, depth: category.depth };
      shelves.set(ref.path, ref);

      // Deeper bindings order after shallower ones, so a child's attributes follow the ones
      // it inherits in the product form and the specification table.
      for (const [index, binding] of (node.bindings ?? []).entries()) {
        await bindAttribute(
          ref.id,
          bindAttributeSchema.parse({
            defId: definitions.get(binding.key),
            required: binding.required ?? false,
            order: ref.depth * 20 + index,
            ...(binding.group ? { group: binding.group } : {}),
          }),
        );
      }
      if (node.suppress?.length) await setSuppressedKeys(ref.id, node.suppress);

      await plant(node.children ?? [], ref);
    }
  };

  await plant(SHELVES, null);
  return shelves;
}

async function stockShelves(
  shelves: Map<string, ShelfRef>,
  lock: PhotoLock,
  now: Date,
  random: Random,
): Promise<Stocked[]> {
  const stocked: Stocked[] = [];

  for (const seed of PRODUCTS) {
    const axes = Object.keys(seed.variants[0]?.axis ?? {});
    const photos = seed.photos.flatMap((spec) => {
      const photo = lock[specKey(spec)];
      return photo ? [photo] : [];
    });

    const product = await createProduct(
      createProductSchema.parse({
        title: seed.title,
        subtitle: seed.subtitle,
        description: seed.description,
        categoryId: shelves.get(seed.shelf)!.id,
        status: seed.status ?? 'active',
        attributes: seed.attributes,
        variantAxes: axes,
        variants: seed.variants.map((variant, position) => ({
          axisValues: axes.map((key) => ({ key, value: variant.axis![key]! })),
          price: { amount: variant.price, currency: 'USD' },
          ...(variant.compareAt
            ? { compareAtPrice: { amount: variant.compareAt, currency: 'USD' } }
            : {}),
          stock: { onHand: variant.onHand },
          ...(variant.weightGrams ? { weightGrams: variant.weightGrams } : {}),
          position,
        })),
        images: seed.photos.flatMap((spec, position) => {
          const photo = lock[specKey(spec)];
          return photo
            ? [
                productImage(photo, {
                  alt: spec.alt,
                  fallbackAlt: seed.title,
                  position,
                  appName: env.UNSPLASH_APP_NAME,
                }),
              ]
            : [];
        }),
      }),
    );

    const daysAgo = JUST_PUT_OUT.has(seed.title) ? random.between(2, 12) : random.between(160, 420);
    const publishedAt = new Date(now.getTime() - daysAgo * DAY);
    await Product.collection.updateOne(
      { _id: product._id },
      {
        $set: {
          createdAt: publishedAt,
          updatedAt: publishedAt,
          ...(seed.status === 'draft' ? {} : { publishedAt }),
        },
      },
    );

    stocked.push({ id: String(product._id), seed, publishedAt, photos });
  }

  return stocked;
}

/* ------------------------------------------------------------------ accounts -- */

async function openAccounts(now: Date, random: Random) {
  const customers: Customer[] = [];
  for (const person of PEOPLE) {
    const joined = new Date(now.getTime() - random.between(170, 520) * DAY);
    const user = await User.create({
      email: person.email,
      name: person.name,
      emailVerifiedAt: joined,
    });
    await User.collection.updateOne(
      { _id: user._id },
      {
        $set: {
          createdAt: joined,
          updatedAt: joined,
          lastSeenAt: new Date(now.getTime() - random.between(0, 40) * DAY),
        },
      },
    );
    customers.push({ id: String(user._id), person });
  }

  // The addresses ADMIN_EMAILS names get their accounts and their role now, exactly as a
  // first sign-in would give them; the first of them is who composed the front page and
  // answered the conversations. A shop with no admin configured gets a counter account with
  // no role at all, so the history still has someone behind the counter.
  let staff: Staff | null = null;
  for (const email of env.ADMIN_EMAILS) {
    const admin = await User.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, emailVerifiedAt: now }, $addToSet: { roles: 'admin' } },
      { upsert: true, new: true },
    );
    staff ??= { userId: String(admin._id), email };
  }
  if (!staff) {
    const counter = await User.create({
      email: 'counter@haestore.test',
      name: 'Hæstore',
      emailVerifiedAt: now,
    });
    staff = { userId: String(counter._id), email: counter.email };
  }

  return { customers, staff };
}

/* ------------------------------------------------------------------- history -- */

type Plan = {
  customer: Customer;
  placedAt: Date;
  lines: { product: Stocked; quantity: number; axis?: Record<string, string> }[];
  reviews: Record<string, ScriptedReview>;
};

/**
 * Five months of trade, oldest first.
 *
 * Products are chosen by the square of their `demand`, which gives the long tail a real
 * shop has — a house espresso in dozens of baskets, a small lot in one or two — and a
 * variant only if it has the stock, so the seed never asks checkout for something it would
 * refuse. How far an order has got depends on its age: delivered after a week, shipped after
 * three days, packing after one, and paid-and-waiting today, which is what fills the
 * console's "parcels to pack".
 */
async function tradeHistory(context: {
  catalogue: Stocked[];
  customers: Customer[];
  staff: Staff;
  now: Date;
  random: Random;
  count: number;
}): Promise<Placed[]> {
  const { catalogue, customers, staff, now, random, count } = context;
  const byTitle = (title: string) => catalogue.find((p) => p.seed.title === title)!;
  const byId = new Map(catalogue.map((p) => [p.id, p]));
  const sellable = catalogue.filter((p) => p.seed.status !== 'draft' && p.seed.demand > 0);

  const plans: Plan[] = SCRIPT.map((script) => ({
    customer: customers.find((c) => c.person.name === script.person)!,
    placedAt: new Date(now.getTime() - script.daysAgo * DAY),
    lines: script.lines.map((line) => ({
      product: byTitle(line.title),
      quantity: 1,
      axis: line.axis,
    })),
    reviews: script.reviews ?? {},
  }));

  for (let n = 0; n < count; n += 1) {
    const placedAt = new Date(now.getTime() - random.between(0.1, 150) * DAY);
    const onShelves = sellable.filter((p) => p.publishedAt < placedAt);
    const size = Math.min(random.pick([1, 1, 1, 1, 1, 1, 2, 2, 2, 3]), onShelves.length);
    const chosen = new Set<Stocked>();
    while (chosen.size < size) chosen.add(random.weighted(onShelves, (p) => p.seed.demand ** 2));
    plans.push({
      customer: random.weighted(customers, (c) => c.person.often),
      placedAt,
      lines: [...chosen].map((product) => ({ product, quantity: random.chance(0.15) ? 2 : 1 })),
      reviews: {},
    });
  }

  plans.sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());

  const placed: Placed[] = [];
  const reviewed = new Set<string>();
  const headlinesByProduct = new Map<string, Set<string>>();
  const headlines = (productId: string) => {
    const taken = headlinesByProduct.get(productId) ?? new Set<string>();
    headlinesByProduct.set(productId, taken);
    return taken;
  };
  const behindTheCounter = `admin:${staff.userId}`;

  for (const plan of plans) {
    const owner = { userId: plan.customer.id };

    let added = 0;
    for (const line of plan.lines) {
      const product = await Product.findById(line.product.id).select('variants').lean();
      const candidates = (product?.variants ?? []).filter(
        (variant) =>
          variant.status === 'active' &&
          variant.stock.available >= line.quantity &&
          Object.entries(line.axis ?? {}).every(([key, value]) =>
            variant.axisValues.some((a) => a.key === key && a.value === value),
          ),
      );
      if (candidates.length === 0) continue;
      await addLine(owner, {
        productId: line.product.id,
        variantId: String(random.pick(candidates)._id),
        quantity: line.quantity,
      });
      added += 1;
    }
    if (added === 0) continue;

    const provider = random.chance(0.75) ? 'stripe' : 'paypal';
    const { person } = plan.customer;
    let order;
    try {
      ({ order } = await createOrderFromCart(
        owner,
        createCheckoutSchema.parse({
          email: person.email,
          shippingAddress: { name: person.name, ...person.address },
          provider,
        }),
      ));
    } catch (err) {
      await clearCart(owner);
      logger.warn({ err: (err as Error).message }, 'seed: an order could not be placed, skipped');
      continue;
    }

    const orderId = String(order._id);
    const paid = await markOrderPaid({
      orderId,
      provider,
      intentId:
        provider === 'stripe' ? `pi_seed_${order.orderNumber}` : `SEED-${order.orderNumber}`,
      captureId:
        provider === 'stripe' ? `ch_seed_${order.orderNumber}` : `SEEDCAP-${order.orderNumber}`,
      // Named fields, not a spread: `grandTotal` is a subdocument, and spreading one copies
      // Mongoose's internals rather than the amount — which markOrderPaid rightly refuses.
      amountCaptured: {
        amount: order.totals.grandTotal.amount,
        currency: order.totals.grandTotal.currency,
      },
      providerStatus: provider === 'stripe' ? 'succeeded' : 'COMPLETED',
      by: provider === 'stripe' ? 'webhook' : 'reconcile',
    });
    if (paid.outcome !== 'paid')
      throw new Error(`seed: ${order.orderNumber} did not pay (${paid.outcome})`);

    // The receipt this payment owes is marked sent in the same breath, not at the end of the
    // run: an API left running with the Gmail driver sweeps the outbox every minute, and a
    // seeded customer's address must never be written to — even at a domain that cannot
    // receive it.
    await OrderOutbox.updateMany(
      { order: order._id, processedAt: null },
      { $set: { processedAt: now } },
    );

    const at = plan.placedAt.getTime();
    const times: Partial<Record<OrderStatus, Date>> = {
      pending_payment: plan.placedAt,
      paid: new Date(at + 2 * 60_000),
      processing: new Date(at + 20 * HOUR),
      shipped: new Date(at + 50 * HOUR),
      delivered: new Date(at + 5 * DAY + 3 * HOUR),
    };
    const age = (now.getTime() - at) / DAY;

    let status: OrderStatus = 'paid';
    if (age > 1) status = await moved(transition(orderId, 'processing', behindTheCounter));
    if (age > 3) status = await moved(shipOrder(orderId, behindTheCounter));
    if (age > 7) status = await moved(transition(orderId, 'delivered', behindTheCounter));

    const stored = await Order.findById(orderId).select('history').lean();
    const history = (stored?.history ?? []).map((entry) => ({
      ...entry,
      at: times[entry.status] ?? entry.at,
    }));
    const last = history[history.length - 1]?.at ?? plan.placedAt;
    await Order.collection.updateOne(
      { _id: order._id },
      {
        $set: {
          createdAt: plan.placedAt,
          updatedAt: last,
          paidAt: times.paid,
          'payment.capturedAt': times.paid,
          history,
        },
      },
    );

    if (status === 'delivered') {
      for (const line of order.lines) {
        const product = byId.get(String(line.product))!;
        const key = `${plan.customer.id}:${product.id}`;
        if (reviewed.has(key)) continue;

        const scripted = plan.reviews[product.seed.title];
        if (scripted === null) continue;
        if (!scripted && !random.chance(product.seed.demand <= 1 ? 1 : 0.55)) continue;

        const rating = scripted?.rating ?? ratingFor(product.seed.regard, random);
        const words = scripted
          ? { title: scripted.title, body: scripted.body }
          : reviewWords(product.seed.shelf, rating, random, headlines(product.id));
        const review = await writeReview(
          plan.customer.id,
          product.id,
          writeReviewSchema.parse({ rating, ...words }),
        );
        reviewed.add(key);
        if (words.title) headlines(product.id).add(words.title);

        const writtenAt = new Date(
          Math.min(
            times.delivered!.getTime() + random.between(1, 14) * DAY,
            now.getTime() - random.between(2, 30) * HOUR,
          ),
        );
        await Review.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(review.id) },
          { $set: { createdAt: writtenAt, updatedAt: writtenAt } },
        );

        // The shop reads its reviews within a few days; the newest few are still waiting.
        if (scripted?.hide) await hideReview(review.id, staff.userId, scripted.hide);
        else if (now.getTime() - writtenAt.getTime() > 4 * DAY) await keepReview(review.id);
      }
    }

    placed.push({
      orderNumber: order.orderNumber,
      customer: plan.customer,
      status,
      deliveredAt: status === 'delivered' ? times.delivered! : null,
      titles: order.lines.map((line) => line.title),
    });
  }

  return placed;
}

/**
 * The status a transition reached. A refusal is a bug in the seed — every transition it asks
 * for is legal from where the order stands — so it stops the seed rather than being skipped.
 */
async function moved(
  attempt: Promise<{ moved: true; order: { status: string } } | { moved: false }>,
): Promise<OrderStatus> {
  const result = await attempt;
  if (!result.moved) throw new Error('seed: an order transition was refused');
  return result.order.status as OrderStatus;
}

/* -------------------------------------------------------------- conversations -- */

/**
 * Three conversations, one in each state the console sorts by: a customer waiting on the
 * shop about an order, a question answered and closed, and a new one nobody has read.
 */
async function holdConversations(
  placed: Placed[],
  customers: Customer[],
  staff: Staff,
  now: Date,
): Promise<number> {
  const person = (name: string) => customers.find((c) => c.person.name === name)!;
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  let count = 0;

  const chipped = placed.find(
    (o) =>
      o.customer.person.name === 'Ada Lindqvist' &&
      o.status === 'delivered' &&
      o.titles.includes('Everyday Mug'),
  );
  if (chipped?.deliveredAt) {
    const ada = person('Ada Lindqvist');
    const opened = new Date(chipped.deliveredAt.getTime() + 20 * HOUR);
    const ticket = await openTicket(
      ada.id,
      openTicketSchema.parse({
        subject: 'A chip on the rim of my mug',
        body: 'The celadon mug from this order arrived with a small chip on the rim, about the size of a lentil. It was very well wrapped, so I think it left the potter like that. Could you send another?',
        orderNumber: chipped.orderNumber,
      }),
    );
    await replyAsShop(
      await ticketId(ticket.reference),
      staff,
      'I am sorry — that should have been caught when we packed it. A replacement celadon mug went out this afternoon, and there is no need to send the chipped one back.',
      false,
    );
    await replyAsCustomer(
      ada.id,
      ticket.reference,
      'It arrived today and it is perfect, thank you. While I have you: do you ever sell the celadon breakfast bowls as a set of four?',
    );
    const replied = new Date(opened.getTime() + 5 * HOUR);
    await backdateTicket(ticket.reference, [
      opened,
      replied,
      new Date(replied.getTime() + 2 * DAY),
    ]);
    count += 1;
  }

  const kwame = person('Kwame Mensah');
  const moka = await openTicket(
    kwame.id,
    openTicketSchema.parse({
      subject: 'Which grind for a moka pot?',
      body: 'I have a stovetop moka pot and cannot tell whether to choose the espresso or the filter grind of the House Espresso. Which is closer?',
    }),
  );
  await replyAsShop(
    await ticketId(moka.reference),
    staff,
    'Espresso. A moka pot wants something a touch coarser than a machine does, and our espresso grind is set on the coarse side of fine for exactly that reason. Filter would run through too fast and taste thin.',
    true,
  );
  await backdateTicket(moka.reference, [ago(21), ago(20.8)], { closed: true });
  count += 1;

  const beatrix = person('Beatrix Cole');
  const cafe = await openTicket(
    beatrix.id,
    openTicketSchema.parse({
      subject: 'Coffee for a small café',
      body: 'I am opening a six-table café in Bath in the spring and would love to serve your House Espresso. Do you sell it in larger bags, and could we talk about a regular order?',
    }),
  );
  await backdateTicket(cafe.reference, [ago(0.6)]);
  count += 1;

  return count;
}

async function ticketId(reference: string): Promise<string> {
  const ticket = await SupportTicket.findOne({ reference }).select('_id').lean();
  return String(ticket!._id);
}

async function backdateTicket(
  reference: string,
  times: Date[],
  options: { closed?: boolean } = {},
): Promise<void> {
  const last = times[times.length - 1]!;
  const messages = Object.fromEntries(times.map((at, index) => [`messages.${index}.at`, at]));
  await SupportTicket.collection.updateOne(
    { reference },
    {
      $set: {
        ...messages,
        createdAt: times[0],
        updatedAt: last,
        lastMessageAt: last,
        // The customer has read everything but a closing reply they were emailed about.
        customerReadAt: options.closed ? new Date(last.getTime() + 3 * HOUR) : last,
        ...(options.closed ? { closedAt: last } : {}),
      },
    },
  );
}

/* ------------------------------------------------------------ the front page -- */

async function composeFrontPage(
  catalogue: Stocked[],
  shelves: Map<string, ShelfRef>,
  staff: Staff,
): Promise<number> {
  const idOf = (title: string) => catalogue.find((p) => p.seed.title === title)!.id;
  const draft = await openDraft('home', staff.userId);
  const saved = await saveDraft(
    'home',
    saveDraftSchema.parse({
      sections: homeSections({
        coffeeShelfId: shelves.get('coffee-tea/coffee')!.id,
        handpicked: HANDPICKED.map(idOf),
      }),
      note: 'The front page the seed composes',
      revision: draft.revision,
    }),
    staff.userId,
  );
  const published = await publishDraft('home', saved.revision, staff.userId);
  return published.version;
}

/* ---------------------------------------------------------------- the edges -- */

async function reportDownloads(photos: LockedPhoto[]) {
  const unique = new Map(
    photos.map((p) => [p.id, { id: p.id, downloadLocation: p.downloadLocation }]),
  );
  if (!env.UNSPLASH_ACCESS_KEY) {
    logger.warn(
      'seed: UNSPLASH_ACCESS_KEY is not set, so the photographs’ downloads cannot be reported ' +
        'to Unsplash. Set it and run the seed again; each is reported once.',
    );
    return { reported: 0, owed: unique.size };
  }
  const client = new UnsplashClient(env.UNSPLASH_ACCESS_KEY, defaultCacheDir());
  return client.reportDownloads([...unique.values()]);
}

/**
 * The index, rebuilt from what was just written and swapped in. Forced, because a reset
 * shop legitimately holds fewer products than whatever was live before it.
 *
 * The outbox rows the writes appended are then marked done: the rebuild has already
 * indexed everything they describe, and leaving them would have the API's relay re-index
 * the whole catalogue product by product on its next start.
 */
async function rebuildSearch(): Promise<{ indexed: number }> {
  const result = await reindexAll({ force: true });
  if (!result.swapped) throw new Error(`seed: the search rebuild did not swap: ${result.reason}`);
  await SearchOutbox.updateMany({ processedAt: null }, { $set: { processedAt: new Date() } });
  return { indexed: result.indexed };
}
