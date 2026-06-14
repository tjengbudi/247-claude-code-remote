import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// URL-safe base64 token, representative of what Story 3.1 produces.
const API_KEY = 'aGVsbG93b3JsZHRoaXNpc3Rlc3R0b2tlbjEyMzQ1Njc4OTAxMg';

async function loadServerHelpers(apiKey: string | undefined, enforce: boolean) {
  vi.resetModules();
  vi.doMock('../../src/config.js', () => ({
    config: {
      machine: { id: 'test-machine-id', name: 'Test Machine' },
      agent: { port: 4678, url: 'localhost:4678' },
      dashboard: apiKey !== undefined ? { apiUrl: 'http://localhost:3001/api', apiKey } : undefined,
      projects: { basePath: '~/Dev', whitelist: [] },
    },
  }));
  if (enforce) {
    process.env.AGENT_TOKEN_ENFORCE = 'true';
  } else {
    delete process.env.AGENT_TOKEN_ENFORCE;
  }
  return import('../../src/server.js');
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.AGENT_TOKEN_ENFORCE;
});

afterEach(() => {
  delete process.env.AGENT_TOKEN_ENFORCE;
});

describe('extractTokenFromProtocol', () => {
  it('extracts token from comma-separated string header', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    const req = { headers: { 'sec-websocket-protocol': '247, my-token-value' } };
    expect(extractTokenFromProtocol(req)).toBe('my-token-value');
  });

  it('extracts token from array header', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    const req = { headers: { 'sec-websocket-protocol': ['247', 'my-token'] } };
    expect(extractTokenFromProtocol(req)).toBe('my-token');
  });

  it('returns undefined when header absent', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    expect(extractTokenFromProtocol({ headers: {} })).toBeUndefined();
  });

  it('returns undefined when only "247" offered', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    const req = { headers: { 'sec-websocket-protocol': '247' } };
    expect(extractTokenFromProtocol(req)).toBeUndefined();
  });

  it('trims whitespace from token', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    const req = { headers: { 'sec-websocket-protocol': '247,   spaced-token   ' } };
    expect(extractTokenFromProtocol(req)).toBe('spaced-token');
  });

  it('extracts a token whose value is literally "247" (position-based, not value-based)', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    const req = { headers: { 'sec-websocket-protocol': '247, 247' } };
    // The element AFTER the "247" marker is the token, even if it equals "247".
    expect(extractTokenFromProtocol(req)).toBe('247');
  });

  it('takes the element following the "247" marker, not a stray leading element', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    const req = { headers: { 'sec-websocket-protocol': ['247', 'real-token', 'extra'] } };
    expect(extractTokenFromProtocol(req)).toBe('real-token');
  });

  it('returns undefined when "247" marker is absent even if other elements exist', async () => {
    const { extractTokenFromProtocol } = await loadServerHelpers(API_KEY, false);
    const req = { headers: { 'sec-websocket-protocol': 'garbage, more-garbage' } };
    expect(extractTokenFromProtocol(req)).toBeUndefined();
  });
});

describe('selectSubprotocol', () => {
  it('echoes "247" when offered (AC3)', async () => {
    const { selectSubprotocol } = await loadServerHelpers(API_KEY, false);
    expect(selectSubprotocol(new Set(['247', 'some-token']))).toBe('247');
  });

  it('never echoes the token element', async () => {
    const { selectSubprotocol } = await loadServerHelpers(API_KEY, false);
    const result = selectSubprotocol(new Set(['247', 'secret-token']));
    expect(result).toBe('247');
    expect(result).not.toBe('secret-token');
  });

  it('returns false when "247" not offered', async () => {
    const { selectSubprotocol } = await loadServerHelpers(API_KEY, false);
    expect(selectSubprotocol(new Set(['some-token']))).toBe(false);
  });

  it('returns false for an empty protocol set', async () => {
    const { selectSubprotocol } = await loadServerHelpers(API_KEY, false);
    expect(selectSubprotocol(new Set())).toBe(false);
  });
});

describe('shouldAcceptUpgrade', () => {
  describe('enforcement OFF (default)', () => {
    it('accepts when token matches', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(API_KEY, false);
      expect(shouldAcceptUpgrade(API_KEY)).toBe(true);
    });

    it('accepts when token is missing', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(API_KEY, false);
      expect(shouldAcceptUpgrade(undefined)).toBe(true);
    });

    it('accepts when token is wrong', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(API_KEY, false);
      expect(shouldAcceptUpgrade('wrong-token')).toBe(true);
    });

    it('accepts when no apiKey provisioned', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(undefined, false);
      expect(shouldAcceptUpgrade('any-token')).toBe(true);
    });
  });

  describe('enforcement ON', () => {
    it('accepts when token matches', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(API_KEY, true);
      expect(shouldAcceptUpgrade(API_KEY)).toBe(true);
    });

    it('rejects when token is missing', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(API_KEY, true);
      expect(shouldAcceptUpgrade(undefined)).toBe(false);
    });

    it('rejects when token is wrong', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(API_KEY, true);
      expect(shouldAcceptUpgrade('wrong-token')).toBe(false);
    });

    it('accepts when no apiKey provisioned (nothing to enforce)', async () => {
      const { shouldAcceptUpgrade } = await loadServerHelpers(undefined, true);
      expect(shouldAcceptUpgrade('any-token')).toBe(true);
    });
  });
});

describe('rejectUpgrade', () => {
  it('writes HTTP 401 line then destroys socket', async () => {
    const { rejectUpgrade } = await loadServerHelpers(API_KEY, false);
    const writes: string[] = [];
    let destroyed = false;
    const socket = {
      write: (data: string) => { writes.push(data); },
      destroy: () => { destroyed = true; },
    };

    rejectUpgrade(socket);

    expect(writes).toEqual(['HTTP/1.1 401 Unauthorized\r\n\r\n']);
    expect(destroyed).toBe(true);
  });

  it('writes before destroying (socket.write called first)', async () => {
    const { rejectUpgrade } = await loadServerHelpers(API_KEY, false);
    const callOrder: string[] = [];
    const socket = {
      write: () => { callOrder.push('write'); },
      destroy: () => { callOrder.push('destroy'); },
    };

    rejectUpgrade(socket);

    expect(callOrder).toEqual(['write', 'destroy']);
  });

  it('still destroys the socket when write throws (half-closed socket)', async () => {
    const { rejectUpgrade } = await loadServerHelpers(API_KEY, false);
    let destroyed = false;
    const socket = {
      write: () => { throw new Error('socket already closed'); },
      destroy: () => { destroyed = true; },
    };

    // write() throwing must propagate, but destroy() must still have run.
    expect(() => rejectUpgrade(socket)).toThrow('socket already closed');
    expect(destroyed).toBe(true);
  });
});
