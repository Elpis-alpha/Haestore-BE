import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests spin up real stores; give them room without hiding a hang.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] },
  },
});
