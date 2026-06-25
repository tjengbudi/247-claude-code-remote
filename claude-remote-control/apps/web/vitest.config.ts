import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    // Default is 5000ms. Native better-sqlite3 init + drizzle migrate() in
    // lib/db/index.test.ts run synchronously and starve for CPU when Vitest
    // spawns ~1 worker/core (28 here), occasionally crossing 5s. Bump the
    // ceiling so genuinely-slow native init isn't reported as a flaky failure.
    testTimeout: 15000,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      'tests/e2e/**',
      'tests/integration/pairing/**',
      '**/*.spec.ts',
    ],
    reporters: ['dot'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/lib/**/*.ts', 'src/app/api/**/*.ts', 'src/hooks/**/*.ts', 'src/app/auth/**/*.tsx'],
    },
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
