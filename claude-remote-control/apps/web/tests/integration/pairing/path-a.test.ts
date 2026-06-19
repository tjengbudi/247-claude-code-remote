import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnServer, type ServerInstance } from '../helpers/spawn-server';
import { createPathAToken } from '../helpers/path-a-token';

describe('Path A full round trip (AC5)', () => {
  let server: ServerInstance;

  beforeAll(async () => {
    server = await spawnServer();
  }, 60_000);

  afterAll(async () => {
    if (server) {
      await server.cleanup();
    }
  }, 30_000);

  it('validates path-A token → bootstraps owner → persists connection with NON-NULL token', async () => {
    const machineId = 'test-machine-a';
    const machineName = 'Test Machine A';
    const agentUrl = 'example.com:4678';
    const agentApiKey = 'agent-api-key-456';

    // Build a valid path-A token (mirror createToken from apps/agent/src/routes/pair.ts)
    const token = createPathAToken({
      machineId,
      machineName,
      agentUrl,
      agentApiKey,
    });

    // Step 1: Validate path-A token
    // POST /api/pair/validate {token} → 200 {valid:true,…, token, verified}
    const validateRes = await server.post('/api/pair/validate', { token });
    expect(validateRes.status).toBe(200);
    const validateData = await validateRes.json();
    expect(validateData).toMatchObject({
      valid: true,
      machineId,
      machineName,
      agentUrl,
      token: agentApiKey,
    });
    // Path A includes a `verified` field (path B does not)
    expect(validateData).toHaveProperty('verified');

    // Step 2: Auth bootstrap
    const bootstrapRes = await server.post('/api/auth/bootstrap', {
      username: 'testuser-a',
      password: 'testpass123',
    });
    // 201 = new owner, 409 = owner exists (retry case)
    expect([201, 409]).toContain(bootstrapRes.status);

    let sessionCookie = server.extractSessionCookie(bootstrapRes);
    if (!sessionCookie) {
      const loginRes = await server.post('/api/auth/login', {
        username: 'testuser-a',
        password: 'testpass123',
      });
      expect(loginRes.status).toBe(200);
      sessionCookie = server.extractSessionCookie(loginRes);
    }
    expect(sessionCookie).toBeTruthy();

    // Step 3: Persist connection via path A
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

    // Step 4: Assert NON-NULL token (no path-A regression from path-B wiring)
    const rows = server.db
      .prepare('SELECT token FROM agent_connection WHERE machine_id = ?')
      .all(machineId);
    expect(rows).toHaveLength(1);
    const [row] = rows as Array<{ token: string | null }>;
    expect(row.token).not.toBeNull();
    expect(row.token).toBe(agentApiKey);
  });
});
