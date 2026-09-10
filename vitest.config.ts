import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. They touch no infrastructure and run in well under a second, which
 * is what makes them worth running on every save.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules/**'],
  },
});
