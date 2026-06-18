/**
 * Pure coverage-verdict helper (Story 5.2).
 *
 * Maps (total, tokenless) counts → the shared Epic-5 vocabulary verdict.
 * Pure and unit-testable — no DB, no I/O.
 *
 * Status vocabulary (shared with Story 5.1 CLI):
 * - "covered"  — all connections hold a token
 * - "tokenless" — at least one connection has no token
 * - "empty"     — no connections exist yet
 *
 * Row-level concepts: "present" / "absent" (not tested here — CLI only).
 * CLI reach concepts: "reach-pass" / "reach-fail" (NOT used here — coverage
 * reports PRESENCE, not CORRECTNESS).
 */

export interface CoverageVerdict {
  status: 'covered' | 'tokenless' | 'empty';
  total: number;
  tokenless: number;
  covered: number;
  message: string;
}

/**
 * Compute the coverage verdict from raw counts.
 *
 * @param total    Total agent_connection rows for the user
 * @param tokenless  Count of rows where token IS NULL OR TRIM(token) = ''
 * @returns Structured verdict with status, counts, and operator-facing message
 */
export function computeCoverageVerdict(
  total: number,
  tokenless: number,
): CoverageVerdict {
  // Validate inputs - tokenless cannot exceed total
  if (tokenless > total) {
    throw new Error(
      `Invalid coverage data: tokenless (${tokenless}) cannot exceed total (${total})`
    );
  }

  const covered = total - tokenless;

  if (total === 0) {
    return {
      status: 'empty',
      total: 0,
      tokenless: 0,
      covered: 0,
      message:
        'PASS — 0 connections (nothing paired yet). This does NOT mean safe to flip enforcement ON — there is nothing to protect yet.',
    };
  }

  if (tokenless === 0) {
    return {
      status: 'covered',
      total,
      tokenless: 0,
      covered,
      message:
        'PASS — all connections tokenized. Run `247 token --test` to verify tokens actually authenticate (presence ≠ correctness).',
    };
  }

  return {
    status: 'tokenless',
    total,
    tokenless,
    covered,
    message: `ATTENTION — ${tokenless} of ${total} connection(s) are tokenless; re-pair them before enabling enforcement. Run \`247 token --test\` to verify existing tokens actually authenticate.`,
  };
}
