import { Router, type Request } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireStepUp } from '../../middleware/session.js';
import { body, param, validateBody } from '../../middleware/validate.js';
import {
  handleParamSchema,
  publishDraftSchema,
  saveDraftSchema,
  type SaveDraftInput,
  type Section,
  type StorefrontHandle,
} from './storefront.schema.js';
import {
  discardDraft,
  getDraft,
  getPublished,
  getVersion,
  listVersions,
  openDraft,
  publishDraft,
  republishVersion,
  saveDraft,
  sectionsToServe,
  toLayoutResponse,
} from './storefront.service.js';
import { resolveSections } from './storefront.resolve.js';

function handleOf(req: Request): StorefrontHandle {
  const parsed = handleParamSchema.safeParse(param(req, 'handle'));
  // Not a 400: an unknown handle is simply a page that does not exist.
  if (!parsed.success) throw new AppError(404, 'NOT_FOUND', 'There is no such page.');
  return parsed.data;
}

function versionOf(req: Request): number {
  const parsed = z.coerce.number().int().min(1).safeParse(param(req, 'version'));
  if (!parsed.success) throw new AppError(400, 'BAD_REQUEST', '"version" is not a version number.');
  return parsed.data;
}

/**
 * The public half: what the front page renders.
 *
 * Only ever the published version, or the built-in default when nothing has been
 * published. A draft cannot reach this route by any parameter — there is no parameter.
 */
export const storefrontRouter: Router = Router();

storefrontRouter.get('/:handle', async (req, res) => {
  const handle = handleOf(req);
  const served = await sectionsToServe(handle);
  const { sections } = await resolveSections(served.sections);
  res.json({
    data: { handle, version: served.version, publishedAt: served.publishedAt, sections },
  });
});

/**
 * The composer. Mounted under the admin router, which gates and audits it.
 */
export const adminStorefrontRouter: Router = Router();

const actorId = (req: Request) => req.auth?.userId ?? '';

adminStorefrontRouter.get('/:handle', async (req, res) => {
  const handle = handleOf(req);
  const [published, draft, versions] = await Promise.all([
    getPublished(handle),
    getDraft(handle),
    listVersions(handle),
  ]);
  res.json({
    data: {
      handle,
      published: published ? toLayoutResponse(published) : null,
      draft: draft ? toLayoutResponse(draft) : null,
      versions,
    },
  });
});

/** Open the draft, creating it from what is live if there is none. Idempotent. */
adminStorefrontRouter.post('/:handle/draft', async (req, res) => {
  const draft = await openDraft(handleOf(req), actorId(req));
  res.json({ data: toLayoutResponse(draft) });
});

adminStorefrontRouter.put('/:handle/draft', validateBody(saveDraftSchema), async (req, res) => {
  const saved = await saveDraft(handleOf(req), body<SaveDraftInput>(req), actorId(req));
  res.json({ data: toLayoutResponse(saved) });
});

adminStorefrontRouter.delete('/:handle/draft', async (req, res) => {
  await discardDraft(handleOf(req));
  res.status(204).end();
});

/**
 * What the draft — or any version — will look like, with warnings.
 *
 * The same resolver the public route uses, so the preview cannot disagree with the page
 * it previews. Warnings are the one addition: a hand-picked product that has since been
 * archived is silently skipped on the storefront and named here.
 */
adminStorefrontRouter.get('/:handle/versions/:version/preview', async (req, res) => {
  const version = await getVersion(handleOf(req), versionOf(req));
  const resolved = await resolveSections(version.sections as Section[]);
  res.json({ data: { version: toLayoutResponse(version), ...resolved } });
});

adminStorefrontRouter.get('/:handle/versions/:version', async (req, res) => {
  const version = await getVersion(handleOf(req), versionOf(req));
  res.json({ data: toLayoutResponse(version) });
});

/**
 * Publishing changes the front page for every visitor. Behind step-up, like the other
 * admin actions whose effect is immediate and public — although it is reversible, it is
 * reversible only by someone noticing.
 */
adminStorefrontRouter.post(
  '/:handle/draft/publish',
  requireStepUp(),
  validateBody(publishDraftSchema),
  async (req, res) => {
    const { revision } = body<{ revision: number }>(req);
    const published = await publishDraft(handleOf(req), revision, actorId(req));
    res.json({ data: toLayoutResponse(published) });
  },
);

/** Rollback: publish an earlier version again. */
adminStorefrontRouter.post(
  '/:handle/versions/:version/publish',
  requireStepUp(),
  async (req, res) => {
    const published = await republishVersion(handleOf(req), versionOf(req), actorId(req));
    res.json({ data: toLayoutResponse(published) });
  },
);
