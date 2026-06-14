import { describe, it, expect, vi, beforeEach } from 'vitest';

// URL-safe base64 token, 54 chars — representative of what Story 3.1 produces.
const API_KEY = 'aGVsbG93b3JsZHRoaXNpc3Rlc3R0b2tlbjEyMzQ1Njc4OTAxMg';

// Helper: reset module registry + mock config with given apiKey, then re-import.
async function loadAuthModule(apiKey: string | undefined) {
  vi.resetModules();
  vi.doMock('../../src/config.js', () => ({
    config: {
      machine: { id: 'test-machine-id', name: 'Test Machine' },
      agent: { port: 4678, url: 'localhost:4678' },
      dashboard: apiKey !== undefined ? { apiUrl: 'http://localhost:3001/api', apiKey } : undefined,
      projects: { basePath: '~/Dev', whitelist: [] },
    },
  }));
  return import('../../src/lib/auth.js');
}

beforeEach(() => {
  vi.resetModules();
});

describe('verifyAgentToken', () => {
  it('returns true on exact match when apiKey is provisioned', async () => {
    const { verifyAgentToken } = await loadAuthModule(API_KEY);
    expect(verifyAgentToken(API_KEY)).toBe(true);
  });

  it('returns false on mismatch (same length)', async () => {
    const { verifyAgentToken } = await loadAuthModule(API_KEY);
    // Same byte length, different content — exercises timingSafeEqual path.
    const wrong = API_KEY.slice(0, -1) + (API_KEY.at(-1) === 'A' ? 'B' : 'A');
    expect(verifyAgentToken(wrong)).toBe(false);
  });

  it('returns false on length-diff without throwing (timingSafeEqual would RangeError)', async () => {
    const { verifyAgentToken } = await loadAuthModule(API_KEY);
    expect(() => verifyAgentToken('short')).not.toThrow();
    expect(verifyAgentToken('short')).toBe(false);
    expect(() => verifyAgentToken(API_KEY + 'EXTRA')).not.toThrow();
    expect(verifyAgentToken(API_KEY + 'EXTRA')).toBe(false);
  });

  it('returns false when presented is undefined', async () => {
    const { verifyAgentToken } = await loadAuthModule(API_KEY);
    expect(verifyAgentToken(undefined)).toBe(false);
  });

  it('returns false when presented is empty string', async () => {
    const { verifyAgentToken } = await loadAuthModule(API_KEY);
    expect(verifyAgentToken('')).toBe(false);
  });

  it('returns false when apiKey is not provisioned (call site owns accept policy)', async () => {
    const { verifyAgentToken } = await loadAuthModule(undefined);
    // Pure pass/fail — no expected token means no match.
    // The upgrade-handler (Task 2) treats this as "nothing to enforce" → accept.
    expect(verifyAgentToken(API_KEY)).toBe(false);
    expect(verifyAgentToken(undefined)).toBe(false);
  });
});
