import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/pairing/**/*.test.ts'],
    // Integration tests spawn a real `next start` server + temp SQLite DB,
    // so they need more time than units.
    testTimeout: 90000,
    hookTimeout: 60000,
    // Run sequentially to avoid port collisions between parallel spawns.
    sequence: {
      concurrent: false,
    },
    // Retry once — flaky process spawns / timing-dependent rate-limit windows.
    retry: 1,
    reporters: ['default'],
  },
});
