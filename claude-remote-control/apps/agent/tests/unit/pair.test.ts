import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyToken, createToken, generateCode, pairingCodes } from '../../src/routes/pair.js';
import { config } from '../../src/config.js';

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
});
