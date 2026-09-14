import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import { AdminAudit } from './audit.model.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes an audit row for every admin mutation that succeeded.
 *
 * Mounted once on the admin router, directly under `requireRole`, so every route beneath
 * it is covered by being there — the same argument as the role gate itself.
 *
 * **Written after the response, on `finish`, and only for a status below 400.** A refused
 * request changed nothing, and its trace is already in the request log with the same
 * request id; auditing it too would bury the rows that matter under validation errors.
 * The cost of writing afterwards is a narrow window — a process that dies between
 * sending the response and inserting the row loses that row — which is accepted, and
 * logged loudly when an insert fails, because the alternative is holding every admin
 * response open on a second write.
 */
export const auditAdminMutations: RequestHandler = (req, res, next) => {
  if (READS.has(req.method)) {
    next();
    return;
  }

  res.on('finish', () => {
    const auth = req.auth;
    if (!auth || res.statusCode >= 400) return;

    void AdminAudit.create({
      actor: { userId: auth.userId, email: auth.email },
      method: req.method,
      route: routePatternOf(req),
      path: req.originalUrl.split('?')[0] ?? req.originalUrl,
      targetId: targetOf(req.params),
      status: res.statusCode,
      requestId: typeof req.id === 'string' || typeof req.id === 'number' ? String(req.id) : null,
    }).catch((err: Error) =>
      logger.error(
        { err: err.message, method: req.method, path: req.originalUrl },
        'admin: AUDIT ROW NOT WRITTEN for a mutation that succeeded',
      ),
    );
  });

  next();
};

/**
 * The route as declared, `/api/admin/orders/:id/status`, rather than as requested.
 *
 * By the time `finish` fires the router has matched and not unwound, so `baseUrl` still
 * names the mount and `route.path` the pattern inside it.
 */
export function routePatternOf(req: Pick<Request, 'baseUrl' | 'route' | 'originalUrl'>): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern !== 'string') return req.originalUrl.split('?')[0] ?? req.originalUrl;
  return `${req.baseUrl}${pattern === '/' ? '' : pattern}`;
}

/** What the mutation was aimed at, in whichever form the route names it. */
export function targetOf(params: Record<string, unknown> | undefined): string | null {
  if (!params) return null;
  const pick = (key: string) => (typeof params[key] === 'string' ? params[key] : null);

  const id = pick('id');
  if (id) return id;

  const handle = pick('handle');
  const version = pick('version');
  if (handle && version) return `${handle}@v${version}`;
  return handle;
}

export const auditQuerySchema = z.strictObject({
  targetId: z.string().trim().min(1).max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(60).default(50),
});

export async function listAudit(options: z.infer<typeof auditQuerySchema>) {
  const filter = options.targetId ? { targetId: options.targetId } : {};
  const [rows, total] = await Promise.all([
    AdminAudit.find(filter)
      .sort({ at: -1 })
      .skip((options.page - 1) * options.perPage)
      .limit(options.perPage)
      .lean(),
    AdminAudit.countDocuments(filter),
  ]);

  return {
    data: rows.map((row) => ({
      id: String(row._id),
      actor: { userId: String(row.actor.userId), email: row.actor.email },
      method: row.method,
      route: row.route,
      path: row.path,
      targetId: row.targetId ?? null,
      status: row.status,
      requestId: row.requestId ?? null,
      at: row.at.toISOString(),
    })),
    page: {
      page: options.page,
      perPage: options.perPage,
      total,
      totalPages: Math.max(Math.ceil(total / options.perPage), 1),
    },
  };
}
