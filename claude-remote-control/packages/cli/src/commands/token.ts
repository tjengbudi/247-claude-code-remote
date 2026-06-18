import { Command } from 'commander';
import chalk from 'chalk';
import WebSocket from 'ws';
import { loadConfig, configExists } from '../lib/config.js';

/**
 * Format a token for display: last 4 characters only.
 * Returns empty string if token is too short.
 * Never prints the full token — security invariant.
 *
 * Exported for unit testing.
 */
export function lastFour(apiKey: string): string {
  if (!apiKey || apiKey.length < 5) return '';
  return '…' + apiKey.slice(-4);
}

/**
 * Diagnosis outcomes for `--test` WS-upgrade self-auth.
 * Matches the shared Epic-5 vocabulary: reach-pass / reach-fail.
 *
 * Exported for unit testing.
 */
export type TokenTestOutcome =
  | 'reach-pass'
  | 'agent-down'
  | 'token-rejected'
  | 'abnormal-close';

export interface TokenTestResult {
  outcome: TokenTestOutcome;
  message: string;
  hint?: string;
}

/**
 * Map a WS client event to a diagnosis outcome.
 * Pure function — no side effects, easily testable.
 *
 * Node `ws` client event mapping:
 * - 'open' + ws.protocol === '247' → reach-pass
 * - 'unexpected-response' with res.statusCode === 401 → token-rejected
 * - 'error' with ECONNREFUSED or timeout → agent-down
 * - 'close' with code 1006 → abnormal-close
 *
 * Exported for unit testing.
 */
export function mapWsEventToOutcome(
  event: string,
  extra?: { statusCode?: number; code?: string; closeCode?: number; protocol?: string }
): TokenTestResult {
  switch (event) {
    case 'open':
      if (extra?.protocol === '247') {
        return {
          outcome: 'reach-pass',
          message: 'Token accepted, subprotocol echoed',
        };
      }
      return {
        outcome: 'abnormal-close',
        message: 'Connection opened but subprotocol not echoed',
        hint: 'Agent may have a subprotocol mismatch',
      };
    case 'unexpected-response':
      if (extra?.statusCode === 401) {
        return {
          outcome: 'token-rejected',
          message: 'Token rejected by agent',
          hint: 'Re-pair this connection',
        };
      }
      return {
        outcome: 'abnormal-close',
        message: `Unexpected HTTP response: ${extra?.statusCode ?? 'unknown'}`,
        hint: 'Check agent logs',
      };
    case 'error':
      if (extra?.code === 'ECONNREFUSED') {
        return {
          outcome: 'agent-down',
          message: 'Agent not reachable',
          hint: 'Start it with: 247 start',
        };
      }
      return {
        outcome: 'agent-down',
        message: `Connection error: ${extra?.code ?? 'unknown'}`,
        hint: 'Check if the agent is running',
      };
    case 'timeout':
      return {
        outcome: 'agent-down',
        message: 'Connection timed out (5s)',
        hint: 'Agent may be unresponsive — try: 247 start',
      };
    case 'close':
      if (extra?.closeCode === 1006) {
        return {
          outcome: 'abnormal-close',
          message: 'Connection closed abnormally after upgrade',
          hint: 'Possible subprotocol issue or unknown path',
        };
      }
      return {
        outcome: 'abnormal-close',
        message: `Connection closed with code ${extra?.closeCode ?? 'unknown'}`,
      };
    default:
      return {
        outcome: 'abnormal-close',
        message: `Unhandled event: ${event}`,
      };
  }
}

/**
 * Run a real WS-upgrade self-auth test against the local agent.
 * Connects to ws://127.0.0.1:<port>/sessions with ['247', token].
 * Returns a promise that resolves with the diagnosis.
 */
async function runWsSelfAuth(port: number, token: string): Promise<TokenTestResult> {
  const url = `ws://127.0.0.1:${port}/sessions`;

  return new Promise<TokenTestResult>((resolve) => {
    let settled = false;

    const settle = (result: TokenTestResult) => {
      if (settled) return;
      settled = true;
      try {
        // ws may not be assigned yet if construction threw synchronously
        if (ws) ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    // Hard timeout — 5 seconds
    const timer = setTimeout(() => {
      settle(mapWsEventToOutcome('timeout'));
    }, 5000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['247', token]);
    } catch (err) {
      clearTimeout(timer);
      settle({
        outcome: 'agent-down',
        message: `Failed to create WebSocket: ${(err as Error).message}`,
        hint: 'Check if the agent is running',
      });
      return;
    }

    ws.on('open', () => {
      clearTimeout(timer);
      settle(mapWsEventToOutcome('open', { protocol: ws.protocol }));
    });

    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      settle(mapWsEventToOutcome('unexpected-response', { statusCode: res.statusCode }));
    });

    ws.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      settle(mapWsEventToOutcome('error', { code: err.code }));
    });

    ws.on('close', (code: number) => {
      clearTimeout(timer);
      // Only handle close if we haven't settled yet (i.e., no 'open' or 'unexpected-response' fired)
      if (!settled) {
        settle(mapWsEventToOutcome('close', { closeCode: code }));
      }
    });
  });
}

/**
 * Run a simple HTTP liveness check against /health.
 * This does NOT verify the token gate — only that the process is alive.
 */
async function runHttpLiveness(port: number): Promise<{ ok: boolean; message: string }> {
  const url = `http://127.0.0.1:${port}/health`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      return { ok: true, message: `Agent is alive (HTTP ${res.status})` };
    }
    return { ok: false, message: `Agent returned HTTP ${res.status}` };
  } catch (err) {
    const name = (err as Error).name;
    const msg = (err as Error).message;
    if (name === 'AbortError' || msg.includes('aborted') || msg.includes('timeout')) {
      return { ok: false, message: 'HTTP liveness check timed out' };
    }
    return { ok: false, message: `Agent not reachable: ${msg}` };
  }
}

export const tokenCommand = new Command('token')
  .description('Show agent token status and test self-authentication (host-native, agent-side)')
  .addHelpText(
    'after',
    `\nThis is the agent-side / host-native tool that inspects ~/.247/config.json\non the machine the agent runs on. For web-side coverage, see Story 5.2.`
  )
  .option('-P, --profile <name>', 'Use a specific profile')
  .option('--test', 'Run a real WS-upgrade self-auth test against the local agent')
  .option('--local', 'Run an HTTP-only liveness check (does NOT verify the token gate)')
  .action(async (options, cmd) => {
    // Profile precedence: local -P flag → global parent -P option
    const profileName = options.profile || cmd.parent?.opts().profile;

    // Load config
    if (!configExists(profileName)) {
      if (profileName) {
        console.log(
          chalk.red(`Profile '${profileName}' not found. Run: 247 profile create ${profileName}\n`)
        );
      } else {
        console.log(chalk.red('Configuration not found. Run: 247 init\n'));
      }
      return;
    }

    const config = loadConfig(profileName);
    if (!config) {
      console.log(chalk.red('Failed to load configuration.\n'));
      return;
    }

    const token = config.dashboard?.apiKey;

    // Guard against malformed config (hand-edited or partial write)
    if (!config.agent?.port) {
      console.log(chalk.red('Agent port not configured. Run: 247 init\n'));
      return;
    }

    // --local and --test together: --local wins; warn user
    if (options.local && options.test) {
      console.log(chalk.yellow('Warning: --local and --test are mutually exclusive; running --local only.\n'));
    }

    // --local mode: HTTP-only liveness check
    if (options.local) {
      console.log(chalk.bold('\n247 Token — HTTP Liveness Check\n'));
      console.log(
        chalk.dim(
          'Scope: liveness only — does NOT verify the token gate.\nUse --test for full WS-upgrade authentication.\n'
        )
      );

      const result = await runHttpLiveness(config.agent.port);
      if (result.ok) {
        console.log(chalk.green(`✓ ${result.message}`));
      } else {
        console.log(chalk.red(`✗ ${result.message}`));
        console.log(chalk.dim('  → Agent may not be running. Try: 247 start'));
      }
      console.log();
      return;
    }

    // --test mode: real WS-upgrade self-auth
    if (options.test) {
      console.log(chalk.bold('\n247 Token — Self-Auth Test\n'));

      if (!token) {
        console.log(
          chalk.red('No token configured. Run: 247 init\n')
        );
        return;
      }

      console.log(chalk.dim('Testing locally-configured token against the local agent.'));
      console.log(
        chalk.dim(
          'Note: the browser uses the paired-row token, so a pass here does not prove\na stale/un-re-paired agent_connection row is healthy.\n'
        )
      );

      console.log(chalk.dim(`Connecting to ws://127.0.0.1:${config.agent.port}/sessions ...`));

      const result = await runWsSelfAuth(config.agent.port, token);

      switch (result.outcome) {
        case 'reach-pass':
          console.log(chalk.green(`✓ reach-pass: ${result.message}`));
          console.log(
            chalk.dim(
              '\n  Note: under AGENT_TOKEN_ENFORCE=false the agent accepts any token,'
            )
          );
          console.log(
            chalk.dim(
              '  so a reach-pass proves "the gate let this token through," not "enforcement is on."'
            )
          );
          console.log(
            chalk.dim('  Proving the reject side against a live wrong token is Story 5.5\'s job.')
          );
          break;
        case 'token-rejected':
          console.log(chalk.red(`✗ reach-fail (${result.outcome}): ${result.message}`));
          if (result.hint) console.log(chalk.dim(`  → ${result.hint}`));
          break;
        case 'agent-down':
          console.log(chalk.red(`✗ reach-fail (${result.outcome}): ${result.message}`));
          if (result.hint) console.log(chalk.dim(`  → ${result.hint}`));
          break;
        case 'abnormal-close':
          console.log(chalk.yellow(`⚠ reach-fail (${result.outcome}): ${result.message}`));
          if (result.hint) console.log(chalk.dim(`  → ${result.hint}`));
          break;
      }
      console.log();
      return;
    }

    // Default: status output (AC2)
    console.log(chalk.bold('\n247 Token Status\n'));

    if (!token) {
      console.log(chalk.yellow('token: absent'));
      console.log(chalk.dim('  → No dashboard.apiKey configured.'));
      console.log(chalk.dim('  → Run "247 init" to provision a token.\n'));
      return;
    }

    const suffix = lastFour(token);
    const display = suffix ? `(${suffix})` : '(token too short to display last-4)';
    console.log(`token: ${chalk.green('present')} ${display}`);
    console.log(
      chalk.dim('\n  No flag prints the full token — the secret has no code path to stdout.\n')
    );
  });
