import { test, expect } from '@playwright/test';

// Helper to get an authenticated session for E2E tests.
// Tries bootstrap first (single-owner system), falls back to login if owner already exists.
async function getSessionCookie(baseUrl: string, username: string, password: string): Promise<string> {
  // Try bootstrap (201 = new owner, 409 = owner exists)
  const bootstrapRes = await fetch(`${baseUrl}/api/auth/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (bootstrapRes.status === 201) {
    const setCookie = bootstrapRes.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/(__Host-247_session|247_session)=[^;]+/);
      if (match) return match[0];
    }
  }

  // Owner exists (409) or no cookie from bootstrap — login instead
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  if (!loginRes.ok) {
    throw new Error(`Auth failed: bootstrap=${bootstrapRes.status}, login=${loginRes.status}`);
  }

  const loginCookie = loginRes.headers.get('set-cookie');
  if (loginCookie) {
    const match = loginCookie.match(/(__Host-247_session|247_session)=[^;]+/);
    if (match) return match[0];
  }

  throw new Error('No session cookie from login');
}

test.describe('Code entry input normalization (AC2)', () => {
  test('normalizes paste with separators: 123-456 → 123456', async ({ page, baseURL }) => {
    // Get authenticated session first (button requires auth)
    const cookieString = await getSessionCookie(baseURL!, 'testuser-e2e-1', 'testpass123');
    const eqIdx = cookieString.indexOf('=');
    const cookieName = cookieString.slice(0, eqIdx);
    const cookieValue = cookieString.slice(eqIdx + 1);

    // Navigate to home page with session cookie
    await page.goto('/');
    await page.context().addCookies([{ name: cookieName, value: cookieValue, domain: 'localhost', path: '/' }]);
    await page.reload();

    // Click "Connect Agent" button to open the AgentConnectionSettings modal
    // (NoConnectionView.tsx:578-579 triggers onModalOpenChange(true))
    const connectButton = page.getByRole('button', { name: 'Connect Agent' });
    await expect(connectButton).toBeVisible({ timeout: 10_000 });
    await connectButton.click();

    // Find the "Have a pairing code?" input (AgentConnectionSettings.tsx:674-700)
    const codeInput = page.getByPlaceholder('000000');
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    // Type/paste "123-456" — the onChange handler strips non-digits and clamps to 6
    await codeInput.fill('123-456');

    // After normalization, the input value should be "123456"
    await expect(codeInput).toHaveValue('123456');

    // Press Enter to trigger navigation (AgentConnectionSettings.tsx:684-692)
    await codeInput.press('Enter');

    // Should navigate to /connect?code=123456
    await expect(page).toHaveURL(/\/connect\?code=123456/);
  });

  test('normalizes paste with whitespace: " 123456 " → 123456', async ({ page, baseURL }) => {
    // Get authenticated session — same credentials as first test (single-owner system)
    const cookieString = await getSessionCookie(baseURL!, 'testuser-e2e-1', 'testpass123');
    const eqIdx = cookieString.indexOf('=');
    const cookieName = cookieString.slice(0, eqIdx);
    const cookieValue = cookieString.slice(eqIdx + 1);

    await page.goto('/');
    await page.context().addCookies([{ name: cookieName, value: cookieValue, domain: 'localhost', path: '/' }]);
    await page.reload();

    // Open the modal first
    const connectButton = page.getByRole('button', { name: 'Connect Agent' });
    await expect(connectButton).toBeVisible({ timeout: 10_000 });
    await connectButton.click();

    const codeInput = page.getByPlaceholder('000000');
    await expect(codeInput).toBeVisible({ timeout: 10_000 });

    // Paste " 123456 " — whitespace should be stripped
    await codeInput.fill(' 123456 ');

    // After normalization, the input value should be "123456"
    await expect(codeInput).toHaveValue('123456');

    // Click the Pair button (AgentConnectionSettings.tsx:701-718)
    const pairButton = page.getByRole('button', { name: 'Pair' });
    await pairButton.click();

    // Should navigate to /connect?code=123456
    await expect(page).toHaveURL(/\/connect\?code=123456/);
  });
});
