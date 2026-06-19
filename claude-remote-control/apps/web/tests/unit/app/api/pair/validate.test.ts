import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/pair/validate/route';
import * as pairingCodes from '@/lib/pairing-codes';
import * as pairRateLimit from '@/lib/pair-rate-limit';

vi.mock('@/lib/pairing-codes');
vi.mock('@/lib/pair-rate-limit');

function makeRequest(body: unknown) {
  return new Request('http://localhost:3001/api/pair/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pair/validate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: not rate limited
    vi.mocked(pairRateLimit.isRateLimited).mockReturnValue(false);
    vi.mocked(pairRateLimit.getClientIP).mockReturnValue('127.0.0.1');
  });

  describe('code-based pairing (AC4 error messages)', () => {
    it('returns valid=true when code is found', async () => {
      vi.mocked(pairingCodes.lookupPairingCode).mockReturnValue({
        code: '123456',
        machineId: 'machine-1',
        machineName: 'Test Machine',
        agentUrl: '192.168.1.50:4678',
        token: 'test-token',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      });

      const response = await POST(makeRequest({ code: '123456' }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.machineId).toBe('machine-1');
      expect(data.token).toBe('test-token');
      expect(pairingCodes.lookupPairingCode).toHaveBeenCalledWith('123456');
    });

    it('returns improved restart-miss message when code not found', async () => {
      vi.mocked(pairingCodes.lookupPairingCode).mockReturnValue(null);

      const response = await POST(makeRequest({ code: '999999' }));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.valid).toBe(false);
      // AC4: improved copy — mention restart/expiration, not just "wrong code"
      expect(data.error).toContain('expired');
      expect(data.error).toContain('dashboard restarted');
      expect(data.error).toContain('generate a new code');
    });

    it('returns improved rate-limit message (429)', async () => {
      vi.mocked(pairRateLimit.isRateLimited).mockReturnValue(true);

      const response = await POST(makeRequest({ code: '123456' }));
      const data = await response.json();

      expect(response.status).toBe(429);
      // AC4: operator-actionable wait message
      expect(data.error).toContain('Too many attempts');
      expect(data.error).toContain('10 minutes');
      expect(pairingCodes.lookupPairingCode).not.toHaveBeenCalled();
    });
  });

  describe('token-based pairing', () => {
    it('decodes token payload and returns valid=true', async () => {
      // Build a real-looking token (base64url payload + dummy sig)
      const payload = {
        mid: 'machine-1',
        mn: 'Test Machine',
        url: '192.168.1.50:4678',
        tok: 'some-token',
        iat: Date.now(),
        exp: Date.now() + 300000,
      };
      const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const token = `${payloadStr}.dummy-signature`;

      const response = await POST(makeRequest({ token }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.machineId).toBe('machine-1');
      expect(data.agentUrl).toBe('192.168.1.50:4678');
    });

    it('returns 400 when token is expired', async () => {
      const payload = {
        mid: 'machine-1',
        mn: 'Test Machine',
        url: '192.168.1.50:4678',
        exp: Date.now() - 1000, // expired
      };
      const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const token = `${payloadStr}.dummy-signature`;

      const response = await POST(makeRequest({ token }));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.valid).toBe(false);
      expect(data.error).toContain('expired');
    });
  });

  describe('input validation', () => {
    it('returns 400 when neither code nor token provided', async () => {
      const response = await POST(makeRequest({}));
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.valid).toBe(false);
      expect(data.error).toContain('required');
    });
  });
});
