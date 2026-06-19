import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { createServer as createNetServer } from 'net';
import Database from 'better-sqlite3';

export interface ServerInstance {
  baseUrl: string;
  post: (
    path: string,
    body: unknown,
    options?: { cookie?: string; headers?: Record<string, string> }
  ) => Promise<Response>;
  get: (
    path: string,
    options?: { cookie?: string; headers?: Record<string, string> }
  ) => Promise<Response>;
  extractSessionCookie: (res: Response) => string | undefined;
  db: Database.Database;
  cleanup: () => Promise<void>;
}

/** Get an OS-assigned free port (avoids random collisions). */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('Failed to get free port'));
      }
    });
  });
}

export async function spawnServer(): Promise<ServerInstance> {
  const tmpDir = mkdtempSync(join(tmpdir(), '247-e2e-'));
  const dbPath = join(tmpDir, 'test.db');
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const webAuthSecret = randomBytes(32).toString('hex');

  // Always rebuild in CI to avoid stale .next from prior failed runs
  const nextBuildDir = join(process.cwd(), '.next');
  const buildExists = existsSync(nextBuildDir) && !process.env.CI;

  if (!buildExists) {
    const buildProc = spawn('pnpm', ['run', 'build'], {
      cwd: process.cwd(),
      env: { ...process.env, WEB_DB_PATH: dbPath, WEB_AUTH_SECRET: webAuthSecret },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buildOutput = '';
    buildProc.stdout?.on('data', (data) => {
      buildOutput += data.toString();
    });
    buildProc.stderr?.on('data', (data) => {
      buildOutput += data.toString();
    });

    await new Promise<void>((resolve, reject) => {
      buildProc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Build failed with code ${code}\n${buildOutput}`));
      });
    });
  }

  // Start next server — use `npx next start` so --port reaches next directly
  // (pnpm run start --port X passes --port to pnpm, NOT to the script)
  let serverStderr = '';
  const serverProc: ChildProcess = spawn('npx', ['next', 'start', '--port', String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEB_DB_PATH: dbPath,
      WEB_AUTH_SECRET: webAuthSecret,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  serverProc.stderr?.on('data', (data) => {
    // Keep last 4 KB for diagnostics on failure
    serverStderr += data.toString();
    if (serverStderr.length > 4096) serverStderr = serverStderr.slice(-4096);
  });

  // Wait for server to be ready — detect early exit (e.g. EADDRINUSE from port TOCTOU)
  let ready = false;
  let exited = false;
  serverProc.on('exit', () => { exited = true; });

  for (let i = 0; i < 30; i++) {
    if (exited) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`Server exited prematurely (port ${port} may be in use). stderr: ${serverStderr.slice(0, 500)}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/auth/session`);
      if (res.ok || res.status === 401) {
        ready = true;
        break;
      }
      // 500 from failed migration or crash-loop — bail early with diagnostics
      if (res.status >= 500) {
        serverProc.kill('SIGKILL');
        rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`Server returned ${res.status} during ready check. stderr: ${serverStderr.slice(0, 500)}`);
      }
    } catch (e) {
      // Re-throw our own errors (500 bail-out or premature exit)
      if (e instanceof Error && (e.message.includes('Server returned') || e.message.includes('Server exited'))) throw e;
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    serverProc.kill('SIGKILL');
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(`Server failed to start within 30 seconds. stderr: ${serverStderr.slice(0, 500)}`);
  }

  // Brief settle to let WAL checkpoint complete before readonly open
  await new Promise((r) => setTimeout(r, 500));
  const db = new Database(dbPath, { readonly: true });

  const post = async (
    path: string,
    body: unknown,
    options?: { cookie?: string; headers?: Record<string, string> }
  ) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options?.headers,
    };
    if (options?.cookie) {
      headers['Cookie'] = options.cookie;
    }
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  };

  const get = async (
    path: string,
    options?: { cookie?: string; headers?: Record<string, string> }
  ) => {
    const headers: Record<string, string> = { ...options?.headers };
    if (options?.cookie) {
      headers['Cookie'] = options.cookie;
    }
    return fetch(`${baseUrl}${path}`, { method: 'GET', headers });
  };

  const extractSessionCookie = (res: Response): string | undefined => {
    // Try getSetCookie() first (Node 22+)
    const cookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const cookie of cookies) {
      // Match full "name=value" — the Cookie header requires the name prefix, not just the value
      const match = cookie.match(/(__Host-247_session|247_session)=[^;]+/);
      if (match) return match[0];
    }
    // Fallback: parse get('set-cookie') which may comma-join multiple cookies
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const match = setCookie.match(/(__Host-247_session|247_session)=[^;]+/);
      if (match) return match[0];
    }
    return undefined;
  };

  const cleanup = async () => {
    // Graceful shutdown first so Next.js can flush WAL and close handles
    serverProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2000));
    if (!serverProc.killed) {
      serverProc.kill('SIGKILL');
    }
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  };

  return { baseUrl, post, get, extractSessionCookie, db, cleanup };
}
