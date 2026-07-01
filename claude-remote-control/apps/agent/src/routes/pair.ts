/**
 * Pairing routes: Allow users to pair their agent with the dashboard.
 * Provides a web page with pairing link, QR code, and 6-digit fallback code.
 */

import { Router } from 'express';
import { createHmac } from 'crypto';
import { networkInterfaces } from 'os';
import { config } from '../config.js';

// In-memory store for pairing codes (6-digit codes with 5-minute expiry)
interface PairingCode {
  code: string;
  machineId: string;
  machineName: string;
  agentUrl: string;
  token?: string;
  createdAt: number;
  expiresAt: number;
}

const pairingCodes = new Map<string, PairingCode>();

// Clean up expired codes every minute
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pairingCodes.entries()) {
    if (data.expiresAt < now) {
      pairingCodes.delete(code);
    }
  }
}, 60 * 1000);

// Generate a 6-digit code
function generateCode(): string {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  // Ensure uniqueness
  if (pairingCodes.has(code)) {
    return generateCode();
  }
  return code;
}

// Create a signed token
function createToken(payload: object, secret: string, expiresInMs: number): string {
  const exp = Date.now() + expiresInMs;
  const data = { ...payload, iat: Date.now(), exp };
  const payloadStr = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadStr).digest('base64url');
  return `${payloadStr}.${signature}`;
}

// Verify and decode a token
export function verifyToken(
  token: string,
  secret: string
): { valid: boolean; payload?: Record<string, unknown>; error?: string } {
  try {
    const [payloadStr, signature] = token.split('.');
    if (!payloadStr || !signature) {
      return { valid: false, error: 'Invalid token format' };
    }

    const expectedSignature = createHmac('sha256', secret).update(payloadStr).digest('base64url');
    if (signature !== expectedSignature) {
      return { valid: false, error: 'Invalid signature' };
    }

    const payload = JSON.parse(Buffer.from(payloadStr, 'base64url').toString());

    if (payload.exp && payload.exp < Date.now()) {
      return { valid: false, error: 'Token expired' };
    }

    return { valid: true, payload };
  } catch {
    return { valid: false, error: 'Failed to parse token' };
  }
}

/**
 * Detect a reachable LAN IPv4 address for this machine.
 *
 * Picks the first non-internal IPv4 interface, preferring RFC-1918 private
 * ranges (192.168/16, 10/8, 172.16–31/12) so the browser on another device can
 * reach the agent. Skips loopback (127.x), link-local (169.254.x), and internal
 * interfaces. Returns null when no candidate exists (e.g. loopback-only host).
 */
export function getLocalNetworkIp(): string | null {
  const isPrivate = (ip: string): boolean =>
    /^192\.168\./.test(ip) ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

  let fallback: string | null = null;
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      // Node 18+ reports family as the string 'IPv4'; older as number 4.
      const isIPv4 = iface.family === 'IPv4' || (iface.family as unknown) === 4;
      if (!isIPv4 || iface.internal) continue;
      if (/^169\.254\./.test(iface.address)) continue; // link-local
      if (isPrivate(iface.address)) return iface.address; // best candidate
      if (!fallback) fallback = iface.address; // public/other — keep as fallback
    }
  }
  return fallback;
}

/**
 * Resolve the URL the agent advertises to the dashboard during pairing.
 * Priority:
 *   1. config.agent.url        — explicit operator setting (never overridden)
 *   2. detected LAN IPv4        — reachable from other devices on the network
 *   3. localhost:<port>         — last resort; rejected by the loopback guard
 *      in the QR/token routes so it is never silently embedded in a token.
 */
function getAgentUrl(): string {
  if (config.agent?.url) {
    return config.agent.url;
  }
  const port = config.agent?.port || 4678;
  const lanIp = getLocalNetworkIp();
  if (lanIp) {
    return `${lanIp}:${port}`;
  }
  return `localhost:${port}`;
}

/**
 * Strip protocol prefix and path from a URL, returning host[:port].
 * Path A and manual connection storage both persist without protocol;
 * URL builders add it back later (web utils.ts:28-39).
 */
export function normalizeAgentUrlForPairing(url: string): string {
  if (!url) return '';
  let normalized = url.trim();
  // Strip all leading http:// or https:// prefixes with a single greedy pass
  normalized = normalized.replace(/^(https?:\/\/)+/, '');
  // Strip any path component after host[:port] and trailing slashes
  const slashIdx = normalized.indexOf('/');
  if (slashIdx !== -1) {
    normalized = normalized.slice(0, slashIdx);
  }
  return normalized;
}

/**
 * Escape HTML entities to prevent XSS when interpolating into HTML templates.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Detect loopback/non-reachable hosts. After protocol strip, the host portion
 * is checked against known loopback shapes: localhost, 127.x.x.x, ::1.
 * A loopback URL produces a code the browser cannot reach from another machine.
 */
export function isLoopbackHost(url: string): boolean {
  const host = normalizeAgentUrlForPairing(url);
  if (!host) return false;

  // Extract host without port (handle both host:port and [::1]:port)
  let hostOnly = host;
  if (hostOnly.startsWith('[')) {
    // IPv6 bracket notation: [::1]:4678 → ::1
    const bracketEnd = hostOnly.indexOf(']');
    if (bracketEnd > 0) {
      hostOnly = hostOnly.slice(1, bracketEnd);
    } else {
      // Malformed bracket like [::1 — treat as non-reachable
      hostOnly = hostOnly.slice(1);
    }
  } else if (hostOnly.includes(':')) {
    const parts = hostOnly.split(':');
    if (parts.length > 2) {
      // Multiple colons = bare IPv6. Check for loopback before stripping port.
      // ::1 alone or ::1:<port> (ambiguous notation without brackets) → loopback
      if (/^::1(:\d+)?$/.test(hostOnly)) return true;
      // Leave hostOnly for Set check below (will not match, correctly passes)
    } else {
      hostOnly = parts[0] || '';
    }
  }

  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
  if (LOOPBACK_HOSTS.has(hostOnly)) return true;
  // Also match any 127.x.x.x (IPv4 loopback range) with strict octet validation
  if (/^127\.(25[0-5]|2[0-4]\d|1\d{2}|\d{1,2})\.(25[0-5]|2[0-4]\d|1\d{2}|\d{1,2})\.(25[0-5]|2[0-4]\d|1\d{2}|\d{1,2})$/.test(hostOnly)) return true;
  return false;
}

/**
 * Register a pairing code with the dashboard's web store over HTTP.
 *
 * AC1: posts {code, machineId, machineName, agentUrl, token} to {dashboardUrl}/api/pair/code.
 * AC2: rejects loopback agentUrl before registering.
 * Trap #5: surfaces failure to operator, never silently returns a dead code.
 * Uses AbortSignal.timeout to match validate/route.ts's 5s pattern.
 *
 * Returns { success: true } on 2xx, or { success: false, error } on failure.
 *
 * AC4 RESIDUAL RISKS (documented per story spec):
 * - 6-digit collision: negligible (1M code space × 5-min TTL, generateCode retries on collision)
 * - Web-restart invalidation: dashboard is single-instance in-memory (NFR6), restart wipes codes
 *   → post-restart lookup miss is "regenerate", not "wrong code"
 */
export async function registerCodeWithDashboard(params: {
  code: string;
  machineId: string;
  machineName: string;
  agentUrl: string;
  token?: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  // AC2: loopback guard — reject before making a network call
  if (isLoopbackHost(params.agentUrl)) {
    return {
      success: false,
      error: `loopback agentUrl rejected: "${params.agentUrl}" is not reachable from the browser. Set config.agent.url to a LAN/Tailnet address.`,
    };
  }

  const dashboardUrl = getDashboardUrl();
  const normalizedAgentUrl = normalizeAgentUrlForPairing(params.agentUrl);

  try {
    const res = await fetch(`${dashboardUrl}/api/pair/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: params.code,
        machineId: params.machineId,
        machineName: params.machineName,
        agentUrl: normalizedAgentUrl,
        token: params.token,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = (body as { error?: string }).error || `HTTP ${res.status}`;
      return {
        success: false,
        error: `registration failed: dashboard returned ${msg}`,
      };
    }

    return { success: true };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'timeout: dashboard did not respond within 5s'
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      success: false,
      error: `registration failed: ${reason}`,
    };
  }
}

// Get dashboard URL
function getDashboardUrl(): string {
  // Use config if available
  if (config.dashboard?.apiUrl) {
    // Extract base URL from API URL (remove /api suffix)
    return config.dashboard.apiUrl.replace(/\/api\/?$/, '');
  }
  // Fall back to local IP on default Docker port
  const localIp = getLocalNetworkIp();
  return localIp ? `http://${localIp}:3001` : 'http://localhost:3001';
}

// Generate QR code as SVG using a simple implementation
function generateQRCodeSVG(data: string): string {
  // Use a simple QR code approach - encode the URL in a data URI
  // For production, you'd use a proper QR library like 'qrcode'
  // Here we'll use Google Charts API as a simple fallback
  const encoded = encodeURIComponent(data);
  return `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}" alt="QR Code" width="200" height="200" style="image-rendering: pixelated;" />`;
}

/**
 * Build the operator-facing message shown when the resolved agent URL is a
 * loopback address — unreachable from the browser, so pairing it would silently
 * produce a dead connection. Mirrors registerCodeWithDashboard's AC2 message.
 */
export function loopbackErrorMessage(agentUrl: string): string {
  return (
    `Agent URL resolved to loopback ("${agentUrl}") and is not reachable from your browser. ` +
    `Set "agent.url" to a LAN or Tailnet address in ~/.247/config.json, then restart the agent.`
  );
}

/** Minimal HTML error page for the loopback guard on GET /pair. */
function loopbackErrorPage(agentUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pairing unavailable</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a10 0%, #1a1a2e 100%); color: #e6e6f0;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 480px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
      border-radius: 16px; padding: 32px; }
    h1 { font-size: 18px; margin-bottom: 12px; color: #f59e0b; }
    p { font-size: 14px; line-height: 1.6; color: #c8c8d4; }
    code { font-family: ui-monospace, monospace; background: rgba(255,255,255,0.06);
      padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠️ Pairing unavailable</h1>
    <p>${escapeHtml(loopbackErrorMessage(agentUrl))}</p>
  </div>
</body>
</html>`;
}

export function createPairRoutes(): Router {
  const router = Router();

  // GET /pair - HTML page with pairing info
  router.get('/', async (_req, res) => {
    const machineId = config.machine.id;
    const machineName = config.machine.name;
    const agentUrl = getAgentUrl();
    const dashboardUrl = getDashboardUrl();

    // Loopback guard: never embed an unreachable localhost URL into a pairing
    // token/code. Fail loud so the operator sets a LAN/Tailnet agent.url.
    if (isLoopbackHost(agentUrl)) {
      res.status(409).type('html').send(loopbackErrorPage(agentUrl));
      return;
    }

    // Create token (5 minute expiry)
    const token = createToken(
      {
        mid: machineId,
        mn: machineName,
        url: agentUrl,
        tok: config.dashboard?.apiKey,
      },
      machineId,
      5 * 60 * 1000
    );

    // Generate or reuse existing code for this machine
    let existingCode: string | undefined;
    for (const [code, data] of pairingCodes.entries()) {
      if (data.machineId === machineId && data.expiresAt > Date.now()) {
        existingCode = code;
        break;
      }
    }

    const code =
      existingCode ||
      (() => {
        const newCode = generateCode();
        pairingCodes.set(newCode, {
          code: newCode,
          machineId,
          machineName,
          agentUrl,
          token: config.dashboard?.apiKey,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        return newCode;
      })();

    // AC1: Register code with dashboard web store (both new and reused codes)
    let registrationError: string | undefined;
    const regResult = await registerCodeWithDashboard({
      code,
      machineId,
      machineName,
      agentUrl,
      token: config.dashboard?.apiKey,
    });
    // AC3: always print code to stdout so headless operators see it regardless of registration outcome
    console.log(`[pair] Pairing code: ${code}`);
    if (!regResult.success) {
      registrationError = regResult.error;
      console.error(`[pair] Code registration failed: ${registrationError}`);
    } else {
      console.log(`[pair] Code registered with dashboard (${dashboardUrl})`);
    }

    const pairingLink = `${dashboardUrl}/connect?token=${encodeURIComponent(token)}`;
    const qrCodeSvg = generateQRCodeSVG(pairingLink);

    // Calculate time remaining — guard against cleanup-interval eviction between selection and access
    const codeData = pairingCodes.get(code);
    if (!codeData) {
      res.status(500).json({ error: 'Pairing code evicted; please refresh to generate a new code.' });
      return;
    }
    const secondsRemaining = Math.floor((codeData.expiresAt - Date.now()) / 1000);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pair Agent - ${machineName}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a10 0%, #1a1a2e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      color: #fff;
    }
    .container {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 24px;
      padding: 40px;
      max-width: 480px;
      width: 100%;
      text-align: center;
    }
    .machine-icon {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #f97316 0%, #f59e0b 100%);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .machine-name {
      color: #f97316;
      font-size: 20px;
      font-weight: 500;
      margin-bottom: 32px;
    }
    .qr-section {
      background: #fff;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 24px;
      display: inline-block;
    }
    .qr-section img {
      display: block;
    }
    .link-section {
      margin-bottom: 24px;
    }
    .pair-button {
      display: inline-block;
      background: linear-gradient(135deg, #f97316 0%, #f59e0b 100%);
      color: #fff;
      text-decoration: none;
      padding: 16px 32px;
      border-radius: 12px;
      font-weight: 600;
      font-size: 16px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .pair-button:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(249, 115, 22, 0.3);
    }
    .divider {
      display: flex;
      align-items: center;
      margin: 24px 0;
      color: rgba(255, 255, 255, 0.4);
      font-size: 14px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: rgba(255, 255, 255, 0.1);
    }
    .divider span {
      padding: 0 16px;
    }
    .code-section {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 20px;
    }
    .code-label {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.6);
      margin-bottom: 12px;
    }
    .code {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 36px;
      font-weight: 700;
      letter-spacing: 8px;
      color: #f97316;
    }
    .expires {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.4);
      margin-top: 12px;
    }
    .refresh-note {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.3);
      margin-top: 24px;
    }
    .agent-info {
      font-size: 12px;
      color: rgba(255, 255, 255, 0.4);
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .registration-error {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: 12px;
      padding: 16px;
      margin-top: 24px;
      color: #fca5a5;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="machine-icon">💻</div>
    <h1>Pair Your Agent</h1>
    <p class="machine-name">${escapeHtml(machineName)}</p>

    <div class="qr-section">
      ${qrCodeSvg}
    </div>

    <div class="link-section">
      <a href="${pairingLink}" class="pair-button" target="_blank">Open Dashboard to Pair</a>
    </div>

    <div class="divider"><span>or enter this code</span></div>

    <div class="code-section">
      <p class="code-label">Pairing Code</p>
      <p class="code">${code}</p>
      <p class="expires">Expires in <span id="countdown">${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, '0')}</span></p>
    </div>

    ${registrationError ? `<div class="registration-error">⚠️ Registration failed: ${escapeHtml(registrationError)}</div>` : ''}

    <p class="refresh-note">Page will auto-refresh when code expires</p>

    <p class="agent-info">
      Agent URL: ${escapeHtml(agentUrl)}<br>
      Machine ID: ${escapeHtml(machineId)}
    </p>
  </div>

  <script>
    let remaining = ${secondsRemaining};
    const countdown = document.getElementById('countdown');

    setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        location.reload();
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      countdown.textContent = mins + ':' + String(secs).padStart(2, '0');
    }, 1000);
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // GET /pair/info - JSON API for pairing info
  router.get('/info', async (_req, res) => {
    const machineId = config.machine.id;
    const machineName = config.machine.name;
    const agentUrl = getAgentUrl();
    const dashboardUrl = getDashboardUrl();

    // Loopback guard: refuse to mint a token/code that embeds an unreachable
    // localhost URL (see GET / above).
    if (isLoopbackHost(agentUrl)) {
      res.status(409).json({ error: loopbackErrorMessage(agentUrl) });
      return;
    }

    // Create token (5 minute expiry)
    const token = createToken(
      {
        mid: machineId,
        mn: machineName,
        url: agentUrl,
        tok: config.dashboard?.apiKey,
      },
      machineId,
      5 * 60 * 1000
    );

    // Generate or reuse existing code
    let existingCode: string | undefined;
    for (const [code, data] of pairingCodes.entries()) {
      if (data.machineId === machineId && data.expiresAt > Date.now()) {
        existingCode = code;
        break;
      }
    }

    const code =
      existingCode ||
      (() => {
        const newCode = generateCode();
        pairingCodes.set(newCode, {
          code: newCode,
          machineId,
          machineName,
          agentUrl,
          token: config.dashboard?.apiKey,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
        return newCode;
      })();

    // Guard against cleanup-interval eviction between selection and access
    const codeData = pairingCodes.get(code);
    if (!codeData) {
      res.status(500).json({ error: 'Pairing code evicted; please retry.' });
      return;
    }

    // AC1: Register code with dashboard web store (both new and reused codes)
    let registrationStatus: 'success' | 'failed' = 'success';
    let registrationError: string | undefined;
    const regResult = await registerCodeWithDashboard({
      code,
      machineId,
      machineName,
      agentUrl,
      token: config.dashboard?.apiKey,
    });
    // AC3: always print code to stdout so headless operators see it
    console.log(`[pair] Pairing code: ${code}`);
    if (!regResult.success) {
      registrationStatus = 'failed';
      registrationError = regResult.error;
      console.error(`[pair] Code registration failed: ${registrationError}`);
    } else {
      console.log(`[pair] Code registered with dashboard (${dashboardUrl})`);
    }

    res.json({
      machineId,
      machineName,
      agentUrl,
      token,
      code,
      pairingLink: `${dashboardUrl}/connect?token=${encodeURIComponent(token)}`,
      expiresAt: codeData.expiresAt,
      registrationStatus,
      ...(registrationError ? { registrationError } : {}),
    });
  });

  // GET /pair/code/:code - Lookup a pairing code (for dashboard to verify)
  router.get('/code/:code', (req, res) => {
    const { code } = req.params;
    const data = pairingCodes.get(code);

    if (!data || data.expiresAt < Date.now()) {
      return res.status(404).json({ error: 'Code not found or expired' });
    }

    res.json({
      machineId: data.machineId,
      machineName: data.machineName,
      agentUrl: data.agentUrl,
      token: data.token,
      expiresAt: data.expiresAt,
    });
  });

  // POST /pair/verify - Verify a token (for dashboard to validate)
  router.post('/verify', (req, res) => {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    const machineId = config.machine.id;
    const result = verifyToken(token, machineId);

    if (!result.valid) {
      return res.status(401).json({ error: result.error });
    }

    res.json({
      valid: true,
      machineId: result.payload?.mid,
      machineName: result.payload?.mn,
      agentUrl: result.payload?.url,
    });
  });

  return router;
}

// Export for testing
export { pairingCodes, generateCode, createToken, getAgentUrl, getDashboardUrl };
