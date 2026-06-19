import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '@/app/api/pair/code/route';
import * as pairingCodes from '@/lib/pairing-codes';
import * as pairRateLimit from '@/lib/pair-rate-limit';

vi.mock('@/lib/pairing-codes');
vi.mock('@/lib/pair-rate-limit');

function makeGetRequest(code?: string) {
  const url = code
    ? `http://localhost:3001/api/pair/code?code=${code}`
    : 'http://localhost:3001/api/pair/code';
  return new Request(url);
}

describe('GET /api/pair/code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pairRateLimit.isRateLimited).mockReturnValue(false);
    vi.mocked(pairRateLimit.getClientIP).mockReturnValue('127.0.0.1');
  });

  it('returns 429 with actionable wait message when rate-limited', async () => {
    vi.mocked(pairRateLimit.isRateLimited).mockReturnValue(true);

    const response = await GET(makeGetRequest('123456'));
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data.error).toContain('Too many attempts');
    expect(data.error).toContain('10 minutes');
  });

  it('returns 404 with restart-aware message when code not found', async () => {
    vi.mocked(pairingCodes.lookupPairingCode).mockReturnValue(null);

    const response = await GET(makeGetRequest('999999'));
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toContain('expired');
    expect(data.error).toContain('dashboard restarted');
    expect(data.error).toContain('generate a new code');
  });

  it('returns 200 with code info when found', async () => {
    vi.mocked(pairingCodes.lookupPairingCode).mockReturnValue({
      code: '123456',
      machineId: 'machine-1',
      machineName: 'Test Machine',
      agentUrl: '192.168.1.50:4678',
      token: 'test-token',
      createdAt: Date.now(),
      expiresAt: Date.now() + 300000,
    });

    const response = await GET(makeGetRequest('123456'));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.valid).toBe(true);
    expect(data.machineId).toBe('machine-1');
    expect(data.token).toBe('test-token');
  });

  it('returns 400 when code param is missing', async () => {
    const response = await GET(makeGetRequest());
    expect(response.status).toBe(400);
  });
});

describe('POST /api/pair/code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a valid 6-digit code', async () => {
    vi.mocked(pairingCodes.registerPairingCode).mockImplementation(() => {});

    const req = new Request('http://localhost:3001/api/pair/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: '123456',
        machineId: 'machine-1',
        machineName: 'Test Machine',
        agentUrl: '192.168.1.50:4678',
        token: 'tok',
      }),
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(pairingCodes.registerPairingCode).toHaveBeenCalledOnce();
  });

  it('rejects non-6-digit code', async () => {
    const req = new Request('http://localhost:3001/api/pair/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'abcdef',
        machineId: 'machine-1',
        machineName: 'Test Machine',
        agentUrl: '192.168.1.50:4678',
      }),
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
  });

  it('rejects missing required fields', async () => {
    const req = new Request('http://localhost:3001/api/pair/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
  });
});
