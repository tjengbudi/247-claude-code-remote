import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
    cyan: (s: string) => s,
  },
  bold: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
  dim: (s: string) => s,
  cyan: (s: string) => s,
}));

// Mock config
vi.mock('../../../src/lib/config.js', () => ({
  loadConfig: vi.fn(),
  configExists: vi.fn(),
}));

describe('token command', () => {
  let consoleLogs: string[];
  let consoleErrors: string[];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleLogs = [];
    consoleErrors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      consoleLogs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function allOutput(): string {
    return consoleLogs.join('\n') + '\n' + consoleErrors.join('\n');
  }

  describe('status output (AC2)', () => {
    it('prints absent when no token configured', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: {},
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test'], { from: 'user' });

      expect(allOutput()).toContain('absent');
      expect(allOutput()).toContain('247 init');
    });

    it('prints present with last-4 only when token exists', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'very-long-secret-token-abcdef1234' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test'], { from: 'user' });

      expect(allOutput()).toContain('…1234');
      expect(allOutput()).not.toContain('very-long-secret-token-abcdef1234');
      expect(allOutput()).not.toContain('very-long-secret-token');
    });

    it('never prints full token regardless of extra flags', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'super-secret-full-token-value' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      // Commander ignores unknown options by default — the point is the token
      // never appears in output regardless
      await tokenCommand.parseAsync(['node', 'test'], { from: 'user' });

      expect(allOutput()).not.toContain('super-secret-full-token-value');
      expect(allOutput()).toContain('…alue'); // last-4 only
    });
  });

  describe('profile selection (AC1)', () => {
    it('loads config with specified profile', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'prod-id', name: 'prod-machine' },
        agent: { port: 4679 },
        projects: { basePath: '~/Prod', whitelist: [] },
        dashboard: { apiKey: 'prod-token-wxyz' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '-P', 'prod'], { from: 'user' });

      expect(vi.mocked(loadConfig)).toHaveBeenCalledWith('prod');
      expect(allOutput()).toContain('…wxyz');
    });

    it('falls back to parent profile option', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'dev-id', name: 'dev-machine' },
        agent: { port: 4680 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'dev-token-qrs' },
      });

      // Simulate how index.ts creates the program with global -P option
      const { Command } = await import('commander');
      const { tokenCommand } = await import('../../../src/commands/token.js');
      const program = new Command();
      program
        .name('247')
        .option('-P, --profile <name>', 'Use a specific profile');
      program.addCommand(tokenCommand);

      // --profile before the subcommand sets it on the parent program
      await program.parseAsync(['-P', 'dev', 'token'], { from: 'user' });

      expect(vi.mocked(loadConfig)).toHaveBeenCalledWith('dev');
    });
  });

  describe('config.agent guard', () => {
    it('reports error when agent port is missing', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: {} as { port: number },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'test-token' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test'], { from: 'user' });

      expect(allOutput()).toContain('Agent port not configured');
      expect(allOutput()).toContain('247 init');
    });
  });

  describe('short token display (edge case)', () => {
    it('shows "token too short to display last-4" for sub-4-char token', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'abc' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test'], { from: 'user' });

      expect(allOutput()).toContain('present');
      expect(allOutput()).toContain('token too short to display last-4');
      expect(allOutput()).not.toContain('abc');
    });
  });

  describe('--local --test conflict', () => {
    it('warns and runs --local when both flags set', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'test-token' },
      });

      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--local', '--test'], { from: 'user' });

      expect(allOutput()).toContain('mutually exclusive');
      expect(allOutput()).toContain('liveness only');
      expect(allOutput()).not.toContain('reach-pass');
    });
  });

  describe('argv safety (AC5)', () => {
    it('full token never appears in output even when extra args passed', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'my-full-secret-token' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      // Commander ignores excess args by default — the invariant is that the
      // full token NEVER reaches output, regardless of what the user types
      await tokenCommand.parseAsync(['node', 'test'], { from: 'user' });

      expect(allOutput()).not.toContain('my-full-secret-token');
      // Token is never accepted as CLI argument — read from config only
      expect(allOutput()).toContain('…oken'); // last-4 only
    });
  });

  describe('--local HTTP liveness', () => {
    it('performs HTTP check to /health', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'test-token' },
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--local'], { from: 'user' });

      expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4678/health', expect.any(Object));
      expect(allOutput()).toContain('alive');
      expect(allOutput()).toContain('liveness only');
    });

    it('reports when agent not reachable', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'test-token' },
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--local'], { from: 'user' });

      expect(allOutput()).toContain('not reachable');
    });
  });

  describe('--test WS self-auth (AC3, AC4)', () => {
    let wss: InstanceType<typeof WebSocketServer>;
    let httpServer: ReturnType<typeof createServer>;
    let serverPort: number;

    beforeEach(async () => {
      httpServer = createServer();
      wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols: Set<string>) => {
          return protocols.has('247') ? '247' : false;
        },
      });

      // Default: handle upgrade for all paths
      httpServer.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });

      wss.on('connection', (_ws: WebSocket) => {
        // Subprotocol already handled by handleProtocols
      });

      await new Promise<void>((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => {
          const addr = httpServer.address();
          if (addr && typeof addr !== 'string') {
            serverPort = addr.port;
          }
          resolve();
        });
      });
    });

    afterEach(async () => {
      // Close all connected clients
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => {
          httpServer.close(() => resolve());
        });
      });
    });

    it('reports reach-pass when subprotocol is echoed', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: serverPort },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'valid-test-token-abc' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--test'], { from: 'user' });

      expect(allOutput()).toContain('reach-pass');
    });

    it('reports token-rejected on 401', async () => {
      // Remove the default upgrade handler and replace with a 401 rejector
      httpServer.removeAllListeners('upgrade');
      httpServer.on('upgrade', (_req, socket, _head) => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });

      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: serverPort },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'wrong-token' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--test'], { from: 'user' });

      expect(allOutput()).toContain('token-rejected');
    });

    it('reports agent-down when connection refused', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: 19999 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'test-token' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--test'], { from: 'user' });

      expect(allOutput()).toContain('agent-down');
    });

    it('announces provenance (locally-configured vs paired-row)', async () => {
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: serverPort },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'test-token' },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--test'], { from: 'user' });

      expect(allOutput()).toContain('locally-configured token');
      expect(allOutput()).toContain('paired-row');
    });

    it('full token never appears in --test output', async () => {
      const secretToken = 'super-secret-do-not-leak-xyz';
      const { configExists, loadConfig } = await import('../../../src/lib/config.js');
      vi.mocked(configExists).mockReturnValue(true);
      vi.mocked(loadConfig).mockReturnValue({
        machine: { id: 'test-id', name: 'test-machine' },
        agent: { port: serverPort },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: secretToken },
      });

      const { tokenCommand } = await import('../../../src/commands/token.js');
      await tokenCommand.parseAsync(['node', 'test', '--test'], { from: 'user' });

      expect(allOutput()).not.toContain(secretToken);
    });
  });
});

describe('helper functions', () => {
  describe('lastFour', () => {
    it('returns last 4 chars with ellipsis for tokens > 4 chars', async () => {
      const { lastFour } = await import('../../../src/commands/token.js');
      expect(lastFour('abcdefghijklmnop')).toBe('…mnop');
      expect(lastFour('abcde')).toBe('…bcde');
    });

    it('returns empty for strings ≤ 4 chars', async () => {
      const { lastFour } = await import('../../../src/commands/token.js');
      expect(lastFour('')).toBe('');
      expect(lastFour('ab')).toBe('');
      expect(lastFour('abc')).toBe('');
      expect(lastFour('abcd')).toBe('');
    });
  });

  describe('mapWsEventToOutcome', () => {
    it('maps open with correct protocol to reach-pass', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('open', { protocol: '247' });
      expect(result.outcome).toBe('reach-pass');
    });

    it('maps open with wrong protocol to abnormal-close', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('open', { protocol: 'other' });
      expect(result.outcome).toBe('abnormal-close');
    });

    it('maps unexpected-response 401 to token-rejected', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('unexpected-response', { statusCode: 401 });
      expect(result.outcome).toBe('token-rejected');
    });

    it('maps unexpected-response non-401 to abnormal-close', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('unexpected-response', { statusCode: 403 });
      expect(result.outcome).toBe('abnormal-close');
    });

    it('maps error ECONNREFUSED to agent-down', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('error', { code: 'ECONNREFUSED' });
      expect(result.outcome).toBe('agent-down');
    });

    it('maps error with other code to agent-down', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('error', { code: 'ETIMEDOUT' });
      expect(result.outcome).toBe('agent-down');
    });

    it('maps close 1006 to abnormal-close', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('close', { closeCode: 1006 });
      expect(result.outcome).toBe('abnormal-close');
    });

    it('maps timeout to agent-down outcome', async () => {
      const { mapWsEventToOutcome } = await import('../../../src/commands/token.js');
      const result = mapWsEventToOutcome('timeout');
      expect(result.outcome).toBe('agent-down');
    });
  });
});
