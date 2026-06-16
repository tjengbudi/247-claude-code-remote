/**
 * Main server entry point - Express HTTP server with WebSocket support.
 * Routes and handlers are split into separate modules for maintainability.
 */

import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createServer as createHttpServer } from 'http';
import { execSync } from 'child_process';
import { initDatabase, closeDatabase } from './db/index.js';
import * as sessionsDb from './db/sessions.js';
import { config } from './config.js';
import { verifyAgentToken } from './lib/auth.js';

// Routes
import {
  createProjectRoutes,
  createSessionRoutes,
  createPairRoutes,
  createHooksRoutes,
} from './routes/index.js';

// WebSocket
import { handleTerminalConnection, handleSessionsConnection } from './websocket-handlers.js';

// Utility to get active tmux sessions
function getActiveTmuxSessions(): Set<string> {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', {
      encoding: 'utf-8',
    });
    return new Set(
      output
        .trim()
        .split('\n')
        .filter((s: string) => s)
    );
  } catch {
    return new Set();
  }
}

/**
 * Extract the agent-auth token from the Sec-WebSocket-Protocol header.
 * Wire contract (ws-token.ts): the client offers exactly ["247", token],
 * so the token is the element AFTER the fixed "247" subprotocol.
 * Returns undefined if the header is absent or only "247" was offered (tokenless).
 *
 * Position-based (not "first non-247"): a token whose value happens to equal
 * "247" must still survive, and a token must not be shadowed by any stray
 * leading element. We anchor on the "247" marker and take what follows it.
 *
 * Exported for unit testing (server.helpers.test.ts).
 */
export function extractTokenFromProtocol(req: { headers: { [key: string]: string | string[] | undefined } }): string | undefined {
  const header = req.headers['sec-websocket-protocol'];
  if (!header) return undefined;

  // Header can be comma-separated string or array
  const protocols = Array.isArray(header) ? header : header.split(',');
  const trimmed = protocols.map((p) => p.trim()).filter(Boolean);

  // Token is the element immediately following the "247" marker.
  const markerIndex = trimmed.indexOf('247');
  if (markerIndex === -1) return undefined;
  return trimmed[markerIndex + 1];
}

/**
 * Decide whether to accept a WS upgrade based on the agent-auth token.
 *
 * - Enforcement ON (default): accept if (a) no token provisioned (nothing to enforce),
 *   or (b) presented token matches expected. Reject otherwise.
 * - Enforcement OFF (opt-out via `AGENT_TOKEN_ENFORCE=false`): always accept, optionally log a warn on mismatch.
 *
 * Story 3.4 flipped AGENT_TOKEN_ENFORCE to secure-by-default (ON unless explicitly set to "false").
 * Escape hatch: set `AGENT_TOKEN_ENFORCE=false` to revert to OFF (for testing or legacy deployments).
 *
 * Exported for unit testing (server.helpers.test.ts).
 *
 * @param presentedToken Token from Sec-WebSocket-Protocol header
 * @returns `true` to accept, `false` to reject
 */
export function shouldAcceptUpgrade(presentedToken: string | undefined): boolean {
  const expectedToken = config.dashboard?.apiKey;
  const enforce = process.env.AGENT_TOKEN_ENFORCE !== 'false';

  // No token provisioned → nothing to enforce, always accept
  if (!expectedToken) {
    return true;
  }

  const verified = verifyAgentToken(presentedToken);

  if (!enforce) {
    // Enforcement OFF: accept regardless, but log a warn if would have failed
    if (!verified) {
      console.warn(`[Auth] Token mismatch (enforcement OFF, accepting anyway)`);
    }
    return true;
  }

  // Enforcement ON: accept only if verified
  return verified;
}

/**
 * Reject a WS upgrade with HTTP 401 before destroying the socket.
 * Prevents the infinite-reconnect footgun (AC7).
 *
 * Exported for unit testing (server.helpers.test.ts).
 */
export function rejectUpgrade(socket: { write: (data: string) => void; destroy: () => void }): void {
  // try/finally: if the socket is already half-closed/errored, write() can throw
  // synchronously — destroy() must still run so we never leak the fd.
  try {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
  } finally {
    socket.destroy();
  }
}

/**
 * Select the accepted WebSocket subprotocol on a passing upgrade (AC3).
 * Echo ONLY the fixed "247" marker; the token element must NEVER be echoed.
 * Returning false suppresses the Sec-WebSocket-Protocol response header.
 * ws ≥8 passes a Set<string>.
 *
 * Exported for unit testing (server.helpers.test.ts).
 */
export function selectSubprotocol(protocols: Set<string>): string | false {
  return protocols.has('247') ? '247' : false;
}

export async function createServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = createHttpServer(app);
  // handleProtocols: echo "247" (the fixed subprotocol) when offered.
  // The token element must NEVER be echoed — only "247". Returning false
  // rejects the subprotocol negotiation; ws ≥8 passes a Set<string>.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: selectSubprotocol,
  });

  // Initialize SQLite database
  initDatabase();

  // Reconcile sessions with active tmux sessions
  const activeTmuxSessions = getActiveTmuxSessions();
  sessionsDb.reconcileWithTmux(activeTmuxSessions);

  // Load existing sessions
  const dbSessions = sessionsDb.getAllSessions();
  console.log(`[DB] Loaded ${dbSessions.length} sessions from database`);

  // Health check endpoint for container orchestration
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Mount API routes
  app.use('/api', createProjectRoutes());
  app.use('/api/sessions', createSessionRoutes());

  // Mount pairing routes (both at /pair and /api/pair for flexibility)
  app.use('/pair', createPairRoutes());
  app.use('/api/pair', createPairRoutes());

  // Mount hooks routes for Claude Code hook notifications
  app.use('/api/hooks', createHooksRoutes());

  // Handle WebSocket upgrades
  // Token gate sits AHEAD of the empty-whitelist=allow path (websocket-handlers.ts:110)
  // so an unauthorized client never reaches whitelist logic.
  // Excluded routes (HTTP, not WS upgrades — already outside server.on('upgrade')):
  //   - /health (liveness, line 127)
  //   - /pair, /api/pair (own ephemeral HMAC pairingToken, pair.ts)
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Token gate: verify before handleUpgrade runs the connection handler
    const presentedToken = extractTokenFromProtocol(req);
    const accepted = shouldAcceptUpgrade(presentedToken);

    if (!accepted) {
      rejectUpgrade(socket);
      return;
    }

    if (url.pathname === '/terminal') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleTerminalConnection(ws, url);
      });
      return;
    }

    if (url.pathname === '/sessions') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        handleSessionsConnection(ws, url);
      });
      return;
    }

    socket.destroy();
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[Server] Shutting down...');
    closeDatabase();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}
