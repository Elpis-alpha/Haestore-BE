import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { ADMIN_EMAIL, ORIGIN, signIn, staleStepUp, type TestSession } from '../../test/sign-in.js';
import { Category } from '../catalog/category.model.js';
import { Product } from '../catalog/product.model.js';
import { StorefrontLayout } from './storefront.model.js';
import { openDraft, publishDraft, republishVersion, saveDraft } from './storefront.service.js';
import type { Section } from './storefront.schema.js';

/**
 * The composer, against a real replica set.
 *
 * What is being proved is the sentence from the plan — publishing is a version insert
 * plus a status flip in one transaction, never an in-place edit — and the two things the
 * sentence does not say: that the database, not the service, refuses a second published
 * version, and that two people working at once lose neither the page nor each other's
 * edits.
 */

const app = createApp();
let admin: TestSession;

beforeEach(async () => {
  admin = await signIn(app, ADMIN_EMAIL);
});

type Layout = { version: number; status: string; revision: number; sections: Section[] };
type PublicHome = {
  data: { version: number | null; sections: (Section & Record<string, unknown>)[] };
};

const bodyOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

const hero = (heading: string): Section => ({
  id: 'hero-doorway',
  kind: 'hero',
  heading,
  body: '',
  primary: { label: 'Browse', href: '/shop' },
});

const as = (verb: 'post' | 'put' | 'delete', path: string) =>
  request(app)[verb](path).set('Origin', ORIGIN).set('Cookie', admin.cookie);

async function publishHeading(heading: string): Promise<number> {
  const draft = await openDraft('home', admin.userId);
  const saved = await saveDraft(
    'home',
    { sections: [hero(heading)], note: heading, revision: draft.revision },
    admin.userId,
  );
  const published = await publishDraft('home', saved.revision, admin.userId);
  return published.version;
}

const homeHeading = async () => {
  const res = await request(app).get('/api/storefront/home').expect(200);
  const body = res.body as PublicHome;
  return { version: body.data.version, heading: body.data.sections[0]?.heading };
};

describe('before anything is published', () => {
  it('serves the built-in front page, resolving its shelves from the live tree', async () => {
    await Category.create({ name: 'Ceramics', slug: 'ceramics', path: 'ceramics', depth: 0 });
    await Category.create({
      name: 'Hidden',
      slug: 'hidden',
      path: 'hidden',
      depth: 0,
      status: 'hidden',
    });

    const res = await request(app).get('/api/storefront/home').expect(200);
    const body = res.body as PublicHome;

    expect(body.data.version).toBeNull();
    expect(body.data.sections.map((s) => s.kind)).toEqual(['hero', 'shelves', 'product-row']);
    const shelves = body.data.sections[1] as unknown as { shelves: { name: string }[] };
    expect(shelves.shelves.map((s) => s.name)).toEqual(['Ceramics']);
  });

  it('answers 404 for a page the composer does not know', async () => {
    await request(app).get('/api/storefront/about').expect(404);
  });
});

describe('the draft', () => {
  it('opens from the default as version 1, and opening it again returns the same draft', async () => {
    const first = bodyOf<Layout>(await as('post', '/api/admin/storefront/home/draft').expect(200));
    const second = bodyOf<Layout>(await as('post', '/api/admin/storefront/home/draft').expect(200));

    expect(first).toMatchObject({ version: 1, status: 'draft', revision: 0 });
    expect(second.version).toBe(1);
    expect(await StorefrontLayout.countDocuments()).toBe(1);
  });

  it('gives two admins opening the composer at once the same draft', async () => {
    const drafts = await Promise.all([
      openDraft('home', admin.userId),
      openDraft('home', admin.userId),
    ]);
    expect(String(drafts[0]._id)).toBe(String(drafts[1]._id));
    expect(await StorefrontLayout.countDocuments({ status: 'draft' })).toBe(1);
  });

  /** The lost update, turned into a 409. */
  it('refuses a save made against a revision someone else has already saved over', async () => {
    await as('post', '/api/admin/storefront/home/draft').expect(200);

    await as('put', '/api/admin/storefront/home/draft')
      .send({ sections: [hero('Mine')], revision: 0 })
      .expect(200);
    const stale = await as('put', '/api/admin/storefront/home/draft')
      .send({ sections: [hero('Theirs')], revision: 0 })
      .expect(409);

    expect(stale.body).toMatchObject({ error: { code: 'CONFLICT', details: { revision: 1 } } });
    const draft = await StorefrontLayout.findOne({ status: 'draft' }).lean();
    expect((draft!.sections[0] as { heading: string }).heading).toBe('Mine');
  });

  it('refuses a link that leaves the site', async () => {
    await as('post', '/api/admin/storefront/home/draft').expect(200);
    await as('put', '/api/admin/storefront/home/draft')
      .send({
        sections: [{ ...hero('x'), primary: { label: 'Go', href: '//evil.test' } }],
        revision: 0,
      })
      .expect(422);
  });

  it('never reaches the storefront', async () => {
    await publishHeading('Live');
    const draft = await openDraft('home', admin.userId);
    await saveDraft(
      'home',
      { sections: [hero('Unpublished')], note: '', revision: draft.revision },
      admin.userId,
    );

    expect(await homeHeading()).toEqual({ version: 1, heading: 'Live' });
  });
});

describe('publishing', () => {
  it('needs a fresh verification, and changes nothing without one', async () => {
    const draft = bodyOf<Layout>(await as('post', '/api/admin/storefront/home/draft').expect(200));
    await staleStepUp(admin.sessionId);

    const res = await as('post', '/api/admin/storefront/home/draft/publish')
      .send({ revision: draft.revision })
      .expect(403);
    expect(res.body).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
    expect(await StorefrontLayout.countDocuments({ status: 'published' })).toBe(0);
  });

  it('puts the draft on the front page and retires what was there', async () => {
    expect(await publishHeading('First')).toBe(1);
    expect(await publishHeading('Second')).toBe(2);

    expect(await homeHeading()).toEqual({ version: 2, heading: 'Second' });
    const statuses = await StorefrontLayout.find()
      .sort({ version: 1 })
      .select('version status')
      .lean();
    expect(statuses.map((s) => [s.version, s.status])).toEqual([
      [1, 'retired'],
      [2, 'published'],
    ]);
  });

  it('starts the next draft from what is live', async () => {
    await publishHeading('Live copy');
    const draft = await openDraft('home', admin.userId);
    expect(draft.version).toBe(2);
    expect((draft.sections[0] as { heading: string }).heading).toBe('Live copy');
  });

  /**
   * Two people press Publish on the same draft. One wins, and the loser's transaction
   * rolls back whole — including the retirement it had already performed — so the front
   * page is never left with no published version.
   */
  it('publishes once when two admins publish the same draft at the same moment', async () => {
    await publishHeading('Before');
    const draft = await openDraft('home', admin.userId);

    const outcomes = await Promise.allSettled([
      publishDraft('home', draft.revision, admin.userId),
      publishDraft('home', draft.revision, admin.userId),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await StorefrontLayout.countDocuments({ status: 'published' })).toBe(1);
    expect((await homeHeading()).version).toBe(2);
  });

  it('refuses to publish a draft that was saved again since it was loaded', async () => {
    const draft = await openDraft('home', admin.userId);
    await saveDraft(
      'home',
      { sections: [hero('Newer')], note: '', revision: draft.revision },
      admin.userId,
    );

    await expect(publishDraft('home', draft.revision, admin.userId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await StorefrontLayout.countDocuments({ status: 'published' })).toBe(0);
  });

  /** The service is not the only thing standing in the way. */
  it('is refused by the database itself when a second published version is inserted', async () => {
    await publishHeading('Only one');
    await expect(
      StorefrontLayout.create({ handle: 'home', version: 9, status: 'published', sections: [] }),
    ).rejects.toMatchObject({ code: 11000 });
    // Retired versions are not constrained: any number can share a handle.
    await StorefrontLayout.create({ handle: 'home', version: 10, status: 'retired', sections: [] });
    await StorefrontLayout.create({ handle: 'home', version: 11, status: 'retired', sections: [] });
  });
});

describe('rollback', () => {
  it('republishes an earlier version as itself, not as a copy', async () => {
    await publishHeading('Autumn');
    await publishHeading('Winter');

    await as('post', '/api/admin/storefront/home/versions/1/publish').expect(200);

    expect(await homeHeading()).toEqual({ version: 1, heading: 'Autumn' });
    expect(await StorefrontLayout.countDocuments()).toBe(2);
    const winter = await StorefrontLayout.findOne({ version: 2 }).lean();
    expect(winter!.status).toBe('retired');
  });

  it('is a no-op on the version that is already live, and refuses the draft', async () => {
    await publishHeading('Live');
    const again = await republishVersion('home', 1, admin.userId);
    expect(again.status).toBe('published');

    const draft = await openDraft('home', admin.userId);
    await expect(republishVersion('home', draft.version, admin.userId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('references that go stale', () => {
  it('skips an archived hand-picked product on the storefront and names it in the preview', async () => {
    const category = await Category.create({ name: 'Tools', slug: 'tools', path: 'tools' });
    const product = (title: string, status: string) =>
      Product.create({
        title,
        slug: title.toLowerCase(),
        category: category._id,
        categoryAncestors: [category._id],
        status,
        inStock: true,
        priceRange: { min: 2400, max: 2400, currency: 'USD' },
      });
    const trowel = await product('Trowel', 'active');
    const hoe = await product('Hoe', 'archived');

    const draft = await openDraft('home', admin.userId);
    await saveDraft(
      'home',
      {
        sections: [
          {
            id: 'row-picks',
            kind: 'product-row',
            title: 'Picks',
            note: '',
            source: 'handpicked',
            productIds: [String(hoe._id), String(trowel._id)],
            limit: 6,
          },
        ],
        note: '',
        revision: draft.revision,
      },
      admin.userId,
    );

    const preview = await request(app)
      .get(`/api/admin/storefront/home/versions/${draft.version}/preview`)
      .set('Cookie', admin.cookie)
      .expect(200);
    const body = (
      preview.body as {
        data: { warnings: string[]; sections: { products: { title: string }[] }[] };
      }
    ).data;
    expect(body.sections[0]!.products.map((p) => p.title)).toEqual(['Trowel']);
    expect(body.warnings).toEqual([
      'Section 1 (product-row): 1 hand-picked product is not on sale and will not be shown.',
    ]);
  });
});
