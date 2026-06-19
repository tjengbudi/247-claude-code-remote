import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnServer, type ServerInstance } from '../helpers/spawn-server';

describe('Path B full round trip (AC3)', () => {
  let server: ServerInstance;

  beforeAll(async () => {
    server = await spawnServer();
  }, 60_000);

  afterAll(async () => {
    if (server) {
      await server.cleanup();
    }
  }, 30_000);

  it('registers code → validates → bootstraps owner → persists connection with NON-NULL token', async () => {
    const code = '987654';
    const machineId = 'test-machine-b';
    const machineName = 'Test Machine B';
    const agentUrl = 'example.com:4678'; // non-loopback
    const agentApiKey = 'agent-api-key-123';

    // Step 1: Register (simulate agent producer)
    // POST /api/pair/code → 200 {success:true}
    const registerRes = await server.post('/api/pair/code', {
      code,
      machineId,
      machineName,
      agentUrl,
      token: agentApiKey,
    });
    expect(registerRes.status).toBe(200);
    const registerData = await registerRes.json();
    expect(registerData).toMatchObject({ success: true, code });

    // Step 2: Validate (consumer backend)
    // POST /api/pair/validate {code} → 200 {valid:true,…, token}
    const validateRes = await server.post('/api/pair/validate', { code });
    expect(validateRes.status).toBe(200);
    const validateData = await validateRes.json();
    expect(validateData).toMatchObject({
      valid: true,
      machineId,
      machineName,
      agentUrl,
      token: agentApiKey,
    });

    // Step 3: Auth bootstrap
    // POST /api/auth/bootstrap {username, password≥8} → 201 (or 409 if owner exists)
    // Capture 247_session cookie (plain name over http, no __Host- prefix)
    const bootstrapRes = await server.post('/api/auth/bootstrap', {
      username: 'testuser',
      password: 'testpass123', // ≥8 chars
    });
    // 201 = new owner, 409 = owner exists (retry case)
    expect([201, 409]).toContain(bootstrapRes.status);

    // Extract session cookie from Set-Cookie header
    // Bootstrap auto-login is best-effort; fall back to login if no cookie
    let sessionCookie = server.extractSessionCookie(bootstrapRes);

    if (!sessionCookie) {
      // Fall back to POST /api/auth/login
      const loginRes = await server.post('/api/auth/login', {
        username: 'testuser',
        password: 'testpass123',
      });
      expect(loginRes.status).toBe(200);
      sessionCookie = server.extractSessionCookie(loginRes);
    }

    expect(sessionCookie).toBeTruthy();

    // Step 4: Persist connection
    // POST /api/connections with validate payload + session cookie → success
    const connectionRes = await server.post(
      '/api/connections',
      {
        url: agentUrl,
        name: machineName,
        machineId,
        method: 'tailscale',
        token: agentApiKey,
      },
      { cookie: sessionCookie }
    );
    expect(connectionRes.status).toBe(200);
    const connectionData = await connectionRes.json();
    expect(connectionData).toMatchObject({
      url: agentUrl,
      name: machineName,
      machineId,
    });

    // Step 5: Assert NON-NULL token (the re-rot guard)
    // Open the same WEB_DB_PATH with better-sqlite3 and read the row directly
    const rows = server.db
      .prepare('SELECT token FROM agent_connection WHERE machine_id = ?')
      .all(machineId);
    expect(rows).toHaveLength(1);
    const [row] = rows as Array<{ token: string | null }>;
    expect(row.token).not.toBeNull();
    expect(row.token).toBe(agentApiKey);
  });
});
