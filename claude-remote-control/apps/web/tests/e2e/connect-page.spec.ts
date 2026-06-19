import { test, expect } from '@playwright/test';

test.describe('Connect page - valid code', () => {
  test('renders ready state with machine name for valid code', async ({ page, request }) => {
    // Seed a valid code into the web store via POST /api/pair/code
    const code = '123456';
    const registerRes = await request.post('/api/pair/code', {
      data: {
        code,
        machineId: 'test-machine-id',
        machineName: 'Test Machine',
        agentUrl: 'example.com:4678', // non-loopback
        token: 'test-api-key',
      },
    });
    expect(registerRes.ok()).toBeTruthy();

    // Navigate to /connect?code=123456
    await page.goto(`/connect?code=${code}`);

    // Wait for the page to reach ready state (shows machine name)
    // The ready state renders at connect/page.tsx:248-319 with agentInfo.machineName
    await expect(page.getByText('Test Machine')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('example.com:4678')).toBeVisible();
    await expect(page.getByText('test-machine-id')).toBeVisible();
  });

  test('renders error state for invalid/expired code', async ({ page }) => {
    // Navigate to /connect?code=000000 (unseeded, so it's a miss)
    await page.goto('/connect?code=000000');

    // The error state renders at connect/page.tsx:230-245 with errorMessage
    // PREP FINDING #5: restart-miss is 400 on /api/pair/validate (consumer path)
    // The error message comes from validate/route.ts:86-93
    await expect(page.getByText('Pairing Failed')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/Code not found.*expired or the dashboard restarted/)
    ).toBeVisible();
  });
});

test.describe('Connect page - path A token', () => {
  test('renders ready state for valid path-A token', async ({ page }) => {
    // Build a valid path-A token (mirror apps/agent/src/routes/pair.ts createToken)
    // decodeToken does NOT verify signature, so shape+unexpired suffices
    const payload = {
      mid: 'test-machine-id',
      mn: 'Test Machine',
      url: 'example.com:4678',
      tok: 'test-api-key',
      iat: Date.now(),
      exp: Date.now() + 5 * 60 * 1000, // 5 minutes in future
    };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${payloadStr}.fake-signature`; // sig not verified

    await page.goto(`/connect?token=${encodeURIComponent(token)}`);

    // Ready state should render with machine info
    await expect(page.getByText('Test Machine')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('example.com:4678')).toBeVisible();
  });
});
