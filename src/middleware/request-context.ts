import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../lib/logger.js';

/** Correlates every log line for one request. Echoed back so clients can quote it in bug reports. */
export const requestContext: RequestHandler = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers['x-request-id'];
    const id = (Array.isArray(existing) ? existing[0] : existing) ?? randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Health checks are polled constantly and would drown everything else.
  autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
});
