/**
 * Shared WebSocket builder for agent connections (Story 3.3).
 *
 * Centralizes the `new WebSocket(url, ["247", token])` call so all 5 client
 * sites use ONE builder — no per-site `["247", …]` literals (anti-pattern).
 *
 * Subprotocol "247" is the fixed element; the agent echoes it back on accept.
 * The token (URL-safe base64, Story 3.1 contract) is optional — when absent,
 * the builder still offers `["247"]` so the agent's echo has something to
 * match (enforcement OFF allows tokenless connections; Story 3.3/3.4 split).
 *
 * Do NOT URL-encode or transform the token — it is already URL-safe base64.
 */

const SUBPROTOCOL = '247';

/**
 * Open a WebSocket to an agent, offering the subprotocol and optional token.
 *
 * @param url Full WebSocket URL (wss:// or ws://) — use `buildWebSocketUrl` from `lib/utils.ts`
 * @param token URL-safe base64 agent-auth token (may be undefined for test sites or pre-3.2 rows)
 * @returns WebSocket instance
 */
export function openAgentWebSocket(url: string, token?: string): WebSocket {
  const protocols = token ? [SUBPROTOCOL, token] : [SUBPROTOCOL];
  return new WebSocket(url, protocols);
}
