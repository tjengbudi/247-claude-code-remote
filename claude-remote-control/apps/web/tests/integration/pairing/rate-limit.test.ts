import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnServer, type ServerInstance } from '../helpers/spawn-server';

describe('Rate limiter and edge copy (AC4)', () => {
  let server: ServerInstance;

  beforeAll(async () => {
    server = await spawnServer();
  }, 60_000);

  afterAll(async () => {
    if (server) {
      await server.cleanup();
    }
  }, 30_000);

  it('restart-miss returns 400 with restart copy (fresh bucket)', async () => {
    // One invalid code, fresh bucket
    // PREP FINDING #5: restart-miss is 400 on /api/pair/validate (consumer path)
    const res = await server.post('/api/pair/validate', { code: '000000' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toMatchObject({
      valid: false,
      error: 'Code not found. It may have expired or the dashboard restarted. Ask the agent to generate a new code.',
    });
  });

  it('rate limiter fires 429 on the 6th bad request (off-by-one: 5th still 400)', async () => {
    // PREP FINDING #6: isRateLimited returns count >= 5, checked BEFORE recordFailure
    // So: req#1→count 0→served→count→1, #2→1→2, #3→2→3, #4→3→4,
    //     #5→4 (<5)→served (400)→count→5,
    //     #6→5 (≥5)→429
    // Send 6 invalid codes to trigger the limiter

    // Use a distinct x-forwarded-for to scope a fresh bucket (isolate from other tests)
    const headers = { 'x-forwarded-for': '192.168.1.100' };

    // Send 5 bad codes — all should return 400 (not 429 yet)
    for (let i = 0; i < 5; i++) {
      const res = await server.post('/api/pair/validate', { code: '111111' }, { headers });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.valid).toBe(false);
    }

    // The 6th request should trip the limiter (429)
    const sixthRes = await server.post('/api/pair/validate', { code: '111111' }, { headers });
    expect(sixthRes.status).toBe(429);
    const sixthData = await sixthRes.json();
    expect(sixthData).toMatchObject({
      error: 'Too many attempts. Please wait 10 minutes before trying again.',
    });
  });
});
