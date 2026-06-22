import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { networkInterfaces } from 'os';
import {
  verifyToken,
  createToken,
  generateCode,
  pairingCodes,
  registerCodeWithDashboard,
  getDashboardUrl,
  getAgentUrl,
  getLocalNetworkIp,
  loopbackErrorMessage,
  normalizeAgentUrlForPairing,
  isLoopbackHost,
  createPairRoutes,
} from '../../src/routes/pair.js';
import { config } from '../../src/config.js';

// Mock os.networkInterfaces so LAN-IP detection is deterministic.
vi.mock('os', () => ({ networkInterfaces: vi.fn(() => ({})) }));
const mockNetworkInterfaces = vi.mocked(networkInterfaces);

// Mock the config module
vi.mock('../../src/config.js', () => ({
  config: {
    machine: {
      id: 'test-machine-id',
      name: 'Test Machine',
    },
    agent: {
      port: 4678,
      url: 'localhost:4678',
    },
    dashboard: {
      apiUrl: 'http://localhost:3001/api',
      apiKey: 'test-agent-auth-token-12345',
    },
    projects: {
      basePath: '~/Dev',
      whitelist: [],
    },
  },
}));

describe('Pairing Routes', () => {
  beforeEach(() => {
    // Clear pairing codes before each test
    pairingCodes.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createToken', () => {
    it('should create a valid token', () => {
      const payload = { mid: 'test-id', mn: 'Test', url: 'localhost:4678' };
      const secret = 'test-secret';
      const token = createToken(payload, secret, 10 * 60 * 1000);

      expect(token).toBeDefined();
      expect(token.split('.').length).toBe(2);
    });

    it('should include expiry in token payload', () => {
      const payload = { mid: 'test-id' };
      const secret = 'test-secret';
      const token = createToken(payload, secret, 10 * 60 * 1000);

      const [payloadStr] = token.split('.');
      const decodedPayload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());

      expect(decodedPayload.exp).toBeDefined();
      expect(decodedPayload.iat).toBeDefined();
      expect(decodedPayload.mid).toBe('test-id');
    });

    it('should include tok in HMAC payload when apiKey is present', () => {
      const payload = {
        mid: 'test-id',
        mn: 'Test',
        url: 'localhost:4678',
        tok: config.dashboard?.apiKey,
      };
      const token = createToken(payload, 'test-secret', 5 * 60 * 1000);

      const [payloadStr] = token.split('.');
      const decodedPayload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());

      expect(decodedPayload.tok).toBe('test-agent-auth-token-12345');
    });

    it('should omit tok from HMAC payload when apiKey is absent', () => {
      const payload = {
        mid: 'test-id',
        mn: 'Test',
        url: 'localhost:4678',
        tok: undefined,
      };
      const token = createToken(payload, 'test-secret', 5 * 60 * 1000);

      const [payloadStr] = token.split('.');
      const decodedPayload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());

      expect(decodedPayload.tok).toBeUndefined();
    });
  });

  describe('verifyToken', () => {
    it('should verify a valid token', () => {
      const payload = { mid: 'test-id', mn: 'Test', url: 'localhost:4678' };
      const secret = 'test-secret';
      const token = createToken(payload, secret, 10 * 60 * 1000);

      const result = verifyToken(token, secret);

      expect(result.valid).toBe(true);
      expect(result.payload?.mid).toBe('test-id');
      expect(result.payload?.mn).toBe('Test');
    });

    it('should reject token with wrong secret', () => {
      const payload = { mid: 'test-id' };
      const token = createToken(payload, 'correct-secret', 10 * 60 * 1000);

      const result = verifyToken(token, 'wrong-secret');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('should reject expired token', async () => {
      const payload = { mid: 'test-id' };
      const secret = 'test-secret';
      // Create token that expires immediately (negative expiry)
      const token = createToken(payload, secret, -1000);

      const result = verifyToken(token, secret);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Token expired');
    });

    it('should reject malformed token', () => {
      const result = verifyToken('invalid-token', 'secret');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid token format');
    });
  });

  describe('generateCode', () => {
    it('should generate a 6-digit code', () => {
      const code = generateCode();

      expect(code.length).toBe(6);
      expect(/^\d{6}$/.test(code)).toBe(true);
    });

    it('should generate unique codes', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) {
        codes.add(generateCode());
      }
      // With 100 attempts, we should have at least 95 unique codes
      expect(codes.size).toBeGreaterThan(95);
    });
  });

  describe('pairingCodes store', () => {
    it('should store and retrieve pairing codes', () => {
      const code = '123456';
      pairingCodes.set(code, {
        code,
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const retrieved = pairingCodes.get(code);

      expect(retrieved).toBeDefined();
      expect(retrieved?.machineId).toBe('test-machine');
      expect(retrieved?.machineName).toBe('Test Machine');
    });

    it('should return undefined for non-existent codes', () => {
      const retrieved = pairingCodes.get('nonexistent');

      expect(retrieved).toBeUndefined();
    });

    it('should store token in PairingCode when apiKey is present', () => {
      const code = '123456';
      pairingCodes.set(code, {
        code,
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
        token: config.dashboard?.apiKey,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const stored = pairingCodes.get(code);
      expect(stored?.token).toBe('test-agent-auth-token-12345');
    });

    it('should allow token to be undefined in PairingCode', () => {
      const code = '789012';
      pairingCodes.set(code, {
        code,
        machineId: 'test-machine',
        machineName: 'Test Machine',
        agentUrl: 'localhost:4678',
        token: undefined,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      const stored = pairingCodes.get(code);
      expect(stored?.token).toBeUndefined();
    });
  });

  describe('registerCodeWithDashboard', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should POST code with correct payload shape to dashboard', async () => {
      const code = '123456';
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '192.168.1.50:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe(`${getDashboardUrl()}/api/pair/code`);
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body).toEqual({
        code: '123456',
        machineId: 'test-machine-id',
        machineName: 'Test Machine',
        agentUrl: '192.168.1.50:4678',
        token: 'test-agent-auth-token-12345',
      });
    });

    it('should re-register reused local code (web restart recovery)', async () => {
      // Simulate agent has unexpired local code, web restarted, re-present triggers re-register
      const code = '654321';
      pairingCodes.set(code, {
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '10.0.0.5:4678',
        token: config.dashboard?.apiKey,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      });

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '10.0.0.5:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // P4: assert payload shape for reused code (matches new-code test)
      const [, reusedOpts] = fetchMock.mock.calls[0];
      const reusedBody = JSON.parse(reusedOpts.body);
      expect(reusedBody).toEqual({
        code: '654321',
        machineId: 'test-machine-id',
        machineName: 'Test Machine',
        agentUrl: '10.0.0.5:4678',
        token: 'test-agent-auth-token-12345',
      });
    });

    it('should reject loopback agentUrl (localhost)', async () => {
      const code = '111111';

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: 'localhost:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('loopback');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject loopback agentUrl (127.0.0.1)', async () => {
      const code = '222222';

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '127.0.0.1:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('loopback');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject loopback agentUrl (::1)', async () => {
      const code = '333333';

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '[::1]:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('loopback');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject loopback agentUrl with protocol prefix (http://localhost)', async () => {
      const code = '777777';

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: 'http://localhost:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('loopback');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject loopback agentUrl with protocol prefix (https://127.0.0.1)', async () => {
      const code = '888888';

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: 'https://127.0.0.1:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('loopback');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should reject loopback agentUrl in 127.x.x.x range', async () => {
      const code = '999999';

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '127.0.0.2:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('loopback');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should surface registration failure (non-2xx response)', async () => {
      const code = '444444';
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal server error' }),
      });

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '192.168.1.100:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('registration failed');
      }
    });

    it('should surface registration failure (fetch error)', async () => {
      const code = '555555';
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '192.168.1.100:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('registration failed');
      }
    });

    it('should timeout on hung dashboard', async () => {
      const code = '666666';
      // Simulate fetch hanging — but honor the AbortSignal so the timeout fires
      fetchMock.mockImplementationOnce(
        (_url: string, opts: { signal?: AbortSignal }) =>
          new Promise<never>((_resolve, reject) => {
            if (opts?.signal) {
              opts.signal.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'TimeoutError';
                reject(err);
              });
            }
            // Never resolves otherwise — signal abort is the only exit
          })
      );

      const result = await registerCodeWithDashboard({
        code,
        machineId: config.machine.id,
        machineName: config.machine.name,
        agentUrl: '192.168.1.100:4678',
        token: config.dashboard?.apiKey,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('timeout');
      }
    }, 15000); // 15s — AbortSignal.timeout is 5s inside the helper
  });

  describe('normalizeAgentUrlForPairing', () => {
    it('strips http:// prefix', () => {
      expect(normalizeAgentUrlForPairing('http://192.168.1.50:4678')).toBe('192.168.1.50:4678');
    });

    it('strips https:// prefix', () => {
      expect(normalizeAgentUrlForPairing('https://192.168.1.50:4678')).toBe('192.168.1.50:4678');
    });

    it('strips repeated protocol prefixes (e.g. https://http://host)', () => {
      expect(normalizeAgentUrlForPairing('https://http://192.168.1.50:4678')).toBe('192.168.1.50:4678');
    });

    it('strips path component after host:port', () => {
      expect(normalizeAgentUrlForPairing('192.168.1.50:4678/extra/path')).toBe('192.168.1.50:4678');
    });

    it('strips path after protocol strip', () => {
      expect(normalizeAgentUrlForPairing('https://192.168.1.50:4678/extra/path')).toBe('192.168.1.50:4678');
    });

    it('returns empty string for empty input', () => {
      expect(normalizeAgentUrlForPairing('')).toBe('');
    });

    it('leaves bare host:port unchanged', () => {
      expect(normalizeAgentUrlForPairing('machine.tailnet.ts.net:4678')).toBe('machine.tailnet.ts.net:4678');
    });
  });

  describe('isLoopbackHost — additional edge cases', () => {
    it('detects bare ::1 without brackets', () => {
      expect(isLoopbackHost('::1')).toBe(true);
    });

    it('detects bare ::1 with port notation (::1:4678) as loopback', () => {
      // After normalize: '::1:4678' has multiple colons → kept as-is, matches ::1 in Set check
      // NOTE: this form is ambiguous but we treat it conservatively as loopback
      expect(isLoopbackHost('::1:4678')).toBe(true);
    });

    it('rejects 0.0.0.0 as loopback/non-reachable', () => {
      expect(isLoopbackHost('0.0.0.0')).toBe(true);
    });

    it('rejects 0.0.0.0 with port', () => {
      expect(isLoopbackHost('0.0.0.0:4678')).toBe(true);
    });

    it('handles malformed bracket [::1 (no closing ]) as loopback', () => {
      expect(isLoopbackHost('[::1')).toBe(true);
    });

    it('does not flag valid LAN IP as loopback', () => {
      expect(isLoopbackHost('192.168.1.50:4678')).toBe(false);
    });

    it('does not flag Tailscale hostname as loopback', () => {
      expect(isLoopbackHost('machine.tailnet.ts.net:4678')).toBe(false);
    });
  });

  describe('getLocalNetworkIp', () => {
    const ipv4 = (address: string, internal = false) => ({
      address,
      family: 'IPv4' as const,
      internal,
      netmask: '255.255.255.0',
      mac: '00:00:00:00:00:00',
      cidr: null,
    });

    it('returns the first private (RFC-1918) IPv4 address', () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [ipv4('127.0.0.1', true)],
        eth0: [ipv4('192.168.1.50')],
      } as ReturnType<typeof networkInterfaces>);
      expect(getLocalNetworkIp()).toBe('192.168.1.50');
    });

    it('skips internal and link-local addresses', () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [ipv4('127.0.0.1', true)],
        eth0: [ipv4('169.254.10.10')],
        eth1: [ipv4('10.0.0.5')],
      } as ReturnType<typeof networkInterfaces>);
      expect(getLocalNetworkIp()).toBe('10.0.0.5');
    });

    it('prefers a private range over a public address', () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [ipv4('8.8.8.8')],
        eth1: [ipv4('172.16.0.9')],
      } as ReturnType<typeof networkInterfaces>);
      expect(getLocalNetworkIp()).toBe('172.16.0.9');
    });

    it('falls back to a public address when no private range exists', () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [ipv4('127.0.0.1', true)],
        eth0: [ipv4('203.0.113.7')],
      } as ReturnType<typeof networkInterfaces>);
      expect(getLocalNetworkIp()).toBe('203.0.113.7');
    });

    it('returns null on a loopback-only host', () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [ipv4('127.0.0.1', true)],
      } as ReturnType<typeof networkInterfaces>);
      expect(getLocalNetworkIp()).toBeNull();
    });
  });

  describe('getAgentUrl fallback resolution', () => {
    // The shared config mock sets agent.url; toggle it per-test and restore.
    const originalUrl = config.agent?.url;
    afterEach(() => {
      if (config.agent) config.agent.url = originalUrl;
    });

    it('prefers config.agent.url when set (never overridden by LAN detection)', () => {
      if (config.agent) config.agent.url = 'machine.tailnet.ts.net:4678';
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: '192.168.1.50', family: 'IPv4', internal: false } as never],
      } as ReturnType<typeof networkInterfaces>);
      expect(getAgentUrl()).toBe('machine.tailnet.ts.net:4678');
    });

    it('uses detected LAN IP when config.agent.url is unset', () => {
      if (config.agent) config.agent.url = undefined;
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        eth0: [{ address: '192.168.1.50', family: 'IPv4', internal: false } as never],
      } as ReturnType<typeof networkInterfaces>);
      expect(getAgentUrl()).toBe('192.168.1.50:4678');
    });

    it('falls back to localhost when no LAN IP is detected', () => {
      if (config.agent) config.agent.url = undefined;
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      } as ReturnType<typeof networkInterfaces>);
      expect(getAgentUrl()).toBe('localhost:4678');
    });
  });

  describe('loopback guard on QR/token routes', () => {
    const originalUrl = config.agent?.url;
    let app: express.Express;

    beforeEach(() => {
      app = express();
      app.use('/pair', createPairRoutes());
      // Stub dashboard registration so the reachable-URL path never hits network.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
      }) as unknown as typeof fetch;
    });

    afterEach(() => {
      if (config.agent) config.agent.url = originalUrl;
      vi.restoreAllMocks();
    });

    it('GET /pair/info returns 409 and never mints a localhost token', async () => {
      if (config.agent) config.agent.url = undefined;
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      } as ReturnType<typeof networkInterfaces>);

      const res = await request(app).get('/pair/info');
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('loopback');
      expect(res.body.token).toBeUndefined();
      expect(res.body.code).toBeUndefined();
    });

    it('GET /pair renders an error page (no token/pairing link) for loopback', async () => {
      if (config.agent) config.agent.url = 'localhost:4678';
      const res = await request(app).get('/pair');
      expect(res.status).toBe(409);
      expect(res.text).toContain('Pairing unavailable');
      expect(res.text).not.toContain('/connect?token=');
    });

    it('GET /pair/info succeeds with a reachable LAN agent URL', async () => {
      if (config.agent) config.agent.url = '192.168.1.50:4678';
      const res = await request(app).get('/pair/info');
      expect(res.status).toBe(200);
      expect(res.body.agentUrl).toBe('192.168.1.50:4678');
      expect(res.body.token).toBeTruthy();
      expect(res.body.code).toMatch(/^\d{6}$/);
    });
  });

  describe('loopbackErrorMessage', () => {
    it('includes the offending URL and the config remedy', () => {
      const msg = loopbackErrorMessage('localhost:4678');
      expect(msg).toContain('localhost:4678');
      expect(msg).toContain('agent.url');
    });
  });
});
