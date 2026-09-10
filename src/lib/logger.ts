import pino from 'pino';
import { env, isProduction, isTest } from '../config/env.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  // Structured JSON in production so a log aggregator can parse it; human-readable
  // in development. The 2022 app used chalk-coloured console.log, which is neither.
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      '*.password',
      '*.code',
      '*.token',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
