import mongoose from 'mongoose';
import { AppError, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { DEFAULT_HOME_SECTIONS } from './storefront.defaults.js';
import { StorefrontLayout, type StorefrontLayoutDoc } from './storefront.model.js';
import {
  sectionsSchema,
  type SaveDraftInput,
  type Section,
  type StorefrontHandle,
} from './storefront.schema.js';

/**
 * The storefront composer.
 *
 * The design fits in one sentence from the plan: **publishing is a version insert plus a
 * status flip in one transaction, never an in-place edit.** Everything below is that
 * sentence made concrete, plus the two things it leaves unsaid — how the draft is edited
 * safely by more than one person, and what the database does when two people publish at
 * once.
 */

const defaultsFor = (handle: StorefrontHandle): Section[] =>
  handle === 'home' ? DEFAULT_HOME_SECTIONS : [];

export function toLayoutResponse(doc: StorefrontLayoutDoc | (StorefrontLayoutDoc & object)) {
  return {
    id: String(doc._id),
    handle: doc.handle as StorefrontHandle,
    version: doc.version,
    status: doc.status,
    sections: doc.sections as Section[],
    note: doc.note ?? '',
    revision: doc.revision,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    publishedAt: doc.publishedAt ? doc.publishedAt.toISOString() : null,
    retiredAt: doc.retiredAt ? doc.retiredAt.toISOString() : null,
  };
}

export type LayoutResponse = ReturnType<typeof toLayoutResponse>;

export async function getPublished(handle: StorefrontHandle) {
  return StorefrontLayout.findOne({ handle, status: 'published' });
}

/** What the storefront renders: the published version, or the built-in default. */
export async function sectionsToServe(
  handle: StorefrontHandle,
): Promise<{ version: number | null; publishedAt: string | null; sections: Section[] }> {
  const published = await getPublished(handle);
  if (!published) return { version: null, publishedAt: null, sections: defaultsFor(handle) };
  return {
    version: published.version,
    publishedAt: published.publishedAt ? published.publishedAt.toISOString() : null,
    sections: published.sections as Section[],
  };
}

/** Every version, newest first, without their sections — the history panel's rows. */
export async function listVersions(handle: StorefrontHandle, limit = 50) {
  const rows = await StorefrontLayout.aggregate<{
    _id: mongoose.Types.ObjectId;
    version: number;
    status: 'draft' | 'published' | 'retired';
    note?: string;
    sectionCount: number;
    createdAt: Date;
    updatedAt: Date;
    publishedAt: Date | null;
    retiredAt: Date | null;
  }>([
    { $match: { handle } },
    { $sort: { version: -1 } },
    { $limit: limit },
    {
      $project: {
        version: 1,
        status: 1,
        note: 1,
        sectionCount: { $size: '$sections' },
        createdAt: 1,
        updatedAt: 1,
        publishedAt: 1,
        retiredAt: 1,
      },
    },
  ]);

  return rows.map((row) => ({
    id: String(row._id),
    version: row.version,
    status: row.status,
    note: row.note ?? '',
    sectionCount: row.sectionCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    retiredAt: row.retiredAt ? row.retiredAt.toISOString() : null,
  }));
}

export async function getVersion(handle: StorefrontHandle, version: number) {
  const doc = await StorefrontLayout.findOne({ handle, version });
  if (!doc) throw notFound(`There is no version ${version}.`);
  return doc;
}

export async function getDraft(handle: StorefrontHandle) {
  return StorefrontLayout.findOne({ handle, status: 'draft' });
}

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

/**
 * Returns the draft, creating one from the published version if there is none.
 *
 * The new draft takes the next version number and a copy of what is live — or of the
 * built-in default, on a shop that has never published — so "open the composer, change
 * one heading, publish" is the whole workflow.
 *
 * Two admins opening the composer at the same moment both compute the same next number
 * and both insert. The unique indexes refuse the second, and the loser reads the draft
 * the winner made: both people end up editing the same draft, which is what they would
 * have got had they arrived a second apart.
 */
export async function openDraft(handle: StorefrontHandle, actorId: string) {
  const existing = await getDraft(handle);
  if (existing) return existing;

  const [latest, published] = await Promise.all([
    StorefrontLayout.findOne({ handle }).sort({ version: -1 }).select('version').lean(),
    getPublished(handle),
  ]);

  try {
    return await StorefrontLayout.create({
      handle,
      version: (latest?.version ?? 0) + 1,
      status: 'draft',
      sections: published ? published.sections : defaultsFor(handle),
      note: '',
      revision: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const winner = await getDraft(handle);
    if (!winner) throw err;
    return winner;
  }
}

/**
 * Saves the draft in place, against the revision it was loaded at.
 *
 * In place is safe because a draft is not live. Unguarded it would still lose work: two
 * admins load revision 4, both edit, and the second save silently replaces the first. The
 * revision in the filter turns that second save into a 409 carrying the current revision,
 * and the composer tells its user to reload rather than pretending the save worked.
 */
export async function saveDraft(handle: StorefrontHandle, input: SaveDraftInput, actorId: string) {
  const saved = await StorefrontLayout.findOneAndUpdate(
    { handle, status: 'draft', revision: input.revision },
    {
      $set: { sections: input.sections, note: input.note, updatedBy: actorId },
      $inc: { revision: 1 },
    },
    { new: true },
  );
  if (saved) return saved;

  const draft = await getDraft(handle);
  if (!draft) throw notFound('There is no draft to save. Open the composer again to start one.');
  throw conflict(
    'Someone else saved this draft after you opened it. Reload to see their changes.',
    {
      revision: draft.revision,
    },
  );
}

export async function discardDraft(handle: StorefrontHandle): Promise<void> {
  const result = await StorefrontLayout.deleteOne({ handle, status: 'draft' });
  if (result.deletedCount === 0) throw notFound('There is no draft to discard.');
}

/**
 * Runs `work` in a transaction and returns what it produced.
 *
 * Retiring the live version and promoting its replacement must commit together or not at
 * all: between the two writes there is either no published version or two, and a
 * storefront read landing in that gap would render the default page or fail the index.
 */
async function inPublishTransaction(
  work: (session: mongoose.ClientSession) => Promise<StorefrontLayoutDoc>,
): Promise<StorefrontLayoutDoc> {
  const session = await mongoose.startSession();
  try {
    const holder: { doc: StorefrontLayoutDoc | null } = { doc: null };
    await session.withTransaction(async () => {
      holder.doc = await work(session);
    });
    if (!holder.doc) throw new Error('publish transaction produced no version');
    return holder.doc;
  } finally {
    await session.endSession();
  }
}

/**
 * Publishes the draft.
 *
 * **Retire first, then promote.** MongoDB checks a unique index on each write, not at
 * commit, so promoting first would collide with the version being replaced. If the
 * promotion then matches nothing — the draft was saved again since this person loaded it,
 * or someone else published it a moment ago — throwing aborts the transaction and the
 * retirement rolls back with it: the live page never changes on a publish that failed.
 *
 * The sections are validated again here as well as on save. A draft written by an older
 * build of the composer is still a draft, and publishing it must not put a shape on the
 * front page that the current renderer does not understand.
 */
export async function publishDraft(handle: StorefrontHandle, revision: number, actorId: string) {
  const draft = await getDraft(handle);
  if (!draft) throw notFound('There is no draft to publish.');

  const parsed = sectionsSchema.safeParse(draft.sections);
  if (!parsed.success) {
    throw new AppError(
      422,
      'VALIDATION_FAILED',
      'This draft has sections that cannot be published.',
      {
        details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    );
  }

  const published = await inPublishTransaction(async (session) => {
    const now = new Date();
    await StorefrontLayout.updateOne(
      { handle, status: 'published' },
      { $set: { status: 'retired', retiredAt: now } },
      { session },
    );

    const promoted = await StorefrontLayout.findOneAndUpdate(
      { handle, status: 'draft', revision },
      { $set: { status: 'published', publishedAt: now, publishedBy: actorId, retiredAt: null } },
      { new: true, session },
    );

    if (!promoted) {
      throw conflict(
        'The draft changed or was published by someone else. Reload before publishing.',
      );
    }
    return promoted;
  });

  logger.info({ handle, version: published.version, by: actorId }, 'storefront: published');
  return published;
}

/**
 * Puts an earlier version back on the front page. This is rollback.
 *
 * The same retire-then-promote transaction as a publish, applied to a retired version
 * instead of the draft. Nothing is copied and nothing is edited: version 3 republished is
 * version 3, so the history reads as what actually happened.
 */
export async function republishVersion(handle: StorefrontHandle, version: number, actorId: string) {
  const target = await getVersion(handle, version);
  if (target.status === 'published') return target;
  if (target.status === 'draft') {
    throw conflict('That version is the current draft. Publish it from the composer.');
  }

  const published = await inPublishTransaction(async (session) => {
    const now = new Date();
    await StorefrontLayout.updateOne(
      { handle, status: 'published' },
      { $set: { status: 'retired', retiredAt: now } },
      { session },
    );

    const promoted = await StorefrontLayout.findOneAndUpdate(
      { _id: target._id, status: 'retired' },
      { $set: { status: 'published', publishedAt: now, publishedBy: actorId, retiredAt: null } },
      { new: true, session },
    );
    if (!promoted) throw conflict('That version changed while you were looking at it.');
    return promoted;
  });

  logger.info({ handle, version, by: actorId }, 'storefront: earlier version republished');
  return published;
}
