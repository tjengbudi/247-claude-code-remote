import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'pnpm build && pnpm start --port 3000',
    port: 3000,
    reuseExistingServer: false,
    timeout: 120_000, // 2 minutes for first build
    env: {
      NODE_ENV: 'production',
      WEB_DB_PATH: './test-e2e.db',
      // Node 20+ global crypto; avoids require() in ESM config
      WEB_AUTH_SECRET: process.env.WEB_AUTH_SECRET ||
        Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
