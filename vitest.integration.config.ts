import { defineConfig } from 'vitest/config';

/**
 * Integration tests, against a real in-process MongoDB replica set and a real Redis.
 *
 * Single-threaded and sequential: the suite wipes both stores between tests, so
 * parallel files would delete each other's fixtures.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['./src/test/setup-integration.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
