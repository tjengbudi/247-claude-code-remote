/**
 * In-memory pairing code storage for dashboard.
 * Codes are registered by agents and looked up by users.
 * TTL: 5 minutes. Codes are multi-use within the TTL — lookupPairingCode does
 * NOT consume the code; only expiry (swept every minute) removes it.
 *
 * AC4 RESIDUAL RISKS (Story 5.3):
 * - 6-digit collision: negligible (1M code space × 5-min TTL, agents retry on collision)
 * - Web-restart invalidation: single-instance in-memory store (NFR6), restart wipes all codes
 *   → post-restart lookup miss is "regenerate code", not "wrong code" (see validate/route.ts message)
 * - Rate limit: 5 failures/IP/10-min → 429 (pair-rate-limit.ts), guards brute-force of 6-digit space
 */

export interface PairingCodeInfo {
  code: string;
  machineId: string;
  machineName: string;
  agentUrl: string;
  token?: string;
  createdAt: number;
  expiresAt: number;
}

// In-memory store - codes expire after 5 minutes
const pairingCodes = new Map<string, PairingCodeInfo>();

// Cleanup interval - remove expired codes every minute
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [code, data] of pairingCodes.entries()) {
      if (data.expiresAt < now) {
        pairingCodes.delete(code);
      }
    }
  }, 60 * 1000);
}

/**
 * Register a pairing code from an agent
 */
export function registerPairingCode(info: Omit<PairingCodeInfo, 'createdAt' | 'expiresAt'>): void {
  // Remove any existing code for this machine
  for (const [existingCode, data] of pairingCodes.entries()) {
    if (data.machineId === info.machineId) {
      pairingCodes.delete(existingCode);
    }
  }

  const now = Date.now();
  pairingCodes.set(info.code, {
    ...info,
    createdAt: now,
    expiresAt: now + 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Lookup a pairing code - returns info if valid, null if not found or expired
 * Does NOT consume the code (allows multiple lookups)
 */
export function lookupPairingCode(code: string): PairingCodeInfo | null {
  const data = pairingCodes.get(code);

  if (!data) {
    return null;
  }

  // Check expiry
  if (data.expiresAt < Date.now()) {
    pairingCodes.delete(code);
    return null;
  }

  return data;
}

// Export for testing
export { pairingCodes };
