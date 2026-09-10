import { isProduction } from '../config/env.js';
import type { Message } from './mime.js';

/**
 * The last few messages this process produced, for local development and E2E.
 *
 * **Message bodies contain live sign-in codes**, so this is never populated in
 * production — the guard is here, at the only place that writes, as well as on the
 * route that reads. Two independent checks for the same thing is right when the
 * failure mode is publishing working credentials.
 *
 * It is deliberately in-process and lossy rather than a Redis list: a durable copy of
 * every code sent is a liability, and a test that needs one only ever needs the last.
 */
export type OutboxEntry = Message & { sentAt: string; driver: string };

const MAX_ENTRIES = 25;
const entries: OutboxEntry[] = [];

export function recordSentMessage(message: Message, driver: string): void {
  if (isProduction) return;
  entries.unshift({ ...message, driver, sentAt: new Date().toISOString() });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
}

export function readOutbox(): OutboxEntry[] {
  if (isProduction) return [];
  return entries;
}

export function clearOutbox(): void {
  entries.length = 0;
}
