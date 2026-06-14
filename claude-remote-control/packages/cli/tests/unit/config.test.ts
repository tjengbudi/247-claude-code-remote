import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock paths module
vi.mock('../../src/lib/paths.js', () => ({
  getAgentPaths: () => ({
    configDir: '/mock/.247',
    configPath: '/mock/.247/config.json',
    dataDir: '/mock/.247/data',
    logDir: '/mock/.247/logs',
    pidFile: '/mock/.247/agent.pid',
  }),
  ensureDirectories: vi.fn(),
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Mock crypto
vi.mock('crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
  randomBytes: vi.fn((size: number) => Buffer.alloc(size, 0)),
}));

describe('CLI Config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const validConfig = {
    machine: { id: 'test-id', name: 'Test Machine' },
    agent: { port: 4678 },
    projects: { basePath: '~/Dev', whitelist: [] },
  };

  describe('getProfilePath', () => {
    it('returns default config path for undefined profile', async () => {
      const { getProfilePath } = await import('../../src/lib/config.js');
      expect(getProfilePath()).toBe('/mock/.247/config.json');
    });

    it('returns default config path for "default" profile', async () => {
      const { getProfilePath } = await import('../../src/lib/config.js');
      expect(getProfilePath('default')).toBe('/mock/.247/config.json');
    });

    it('returns profile path for named profile', async () => {
      const { getProfilePath } = await import('../../src/lib/config.js');
      expect(getProfilePath('dev')).toBe('/mock/.247/profiles/dev.json');
    });
  });

  describe('loadConfig', () => {
    it('returns null if config file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { loadConfig } = await import('../../src/lib/config.js');
      expect(loadConfig()).toBeNull();
    });

    it('loads and parses valid config', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/lib/config.js');
      const config = loadConfig();

      expect(config).toEqual(validConfig);
    });

    it('applies AGENT_247_PORT env override', async () => {
      process.env.AGENT_247_PORT = '5000';

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/lib/config.js');
      const config = loadConfig();

      expect(config?.agent.port).toBe(5000);
    });

    it('applies AGENT_247_PROJECTS env override', async () => {
      process.env.AGENT_247_PROJECTS = '/custom/projects';

      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(validConfig));

      const { loadConfig } = await import('../../src/lib/config.js');
      const config = loadConfig();

      expect(config?.projects.basePath).toBe('/custom/projects');
    });

    it('returns null for invalid JSON', async () => {
      const { existsSync, readFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('{ invalid json }');

      const { loadConfig } = await import('../../src/lib/config.js');
      expect(loadConfig()).toBeNull();
    });
  });

  describe('saveConfig', () => {
    it('writes config to file', async () => {
      const { existsSync, writeFileSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { saveConfig } = await import('../../src/lib/config.js');
      saveConfig(validConfig);

      expect(writeFileSync).toHaveBeenCalledWith(
        '/mock/.247/config.json',
        JSON.stringify(validConfig, null, 2),
        'utf-8'
      );
    });

    it('creates profiles directory for named profile', async () => {
      const { existsSync, writeFileSync, mkdirSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { saveConfig } = await import('../../src/lib/config.js');
      saveConfig(validConfig, 'dev');

      expect(mkdirSync).toHaveBeenCalledWith('/mock/.247/profiles', { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(
        '/mock/.247/profiles/dev.json',
        JSON.stringify(validConfig, null, 2),
        'utf-8'
      );
    });
  });

  describe('listProfiles', () => {
    it('returns empty array if no profiles exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { listProfiles } = await import('../../src/lib/config.js');
      expect(listProfiles()).toEqual([]);
    });

    it('includes default if config.json exists', async () => {
      const { existsSync, readdirSync } = await import('fs');
      vi.mocked(existsSync).mockImplementation((path) => {
        return String(path).endsWith('config.json');
      });
      vi.mocked(readdirSync).mockReturnValue([]);

      const { listProfiles } = await import('../../src/lib/config.js');
      expect(listProfiles()).toContain('default');
    });

    it('lists named profiles from profiles directory', async () => {
      const { existsSync, readdirSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockReturnValue(['dev.json', 'prod.json'] as any);

      const { listProfiles } = await import('../../src/lib/config.js');
      const profiles = listProfiles();

      expect(profiles).toContain('default');
      expect(profiles).toContain('dev');
      expect(profiles).toContain('prod');
    });
  });

  describe('profileExists', () => {
    it('returns true if profile file exists', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { profileExists } = await import('../../src/lib/config.js');
      expect(profileExists('dev')).toBe(true);
    });

    it('returns false if profile file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { profileExists } = await import('../../src/lib/config.js');
      expect(profileExists('nonexistent')).toBe(false);
    });
  });

  describe('deleteProfile', () => {
    it('throws error when trying to delete default profile', async () => {
      const { deleteProfile } = await import('../../src/lib/config.js');
      expect(() => deleteProfile('default')).toThrow('Cannot delete default profile');
    });

    it('returns false if profile does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { deleteProfile } = await import('../../src/lib/config.js');
      expect(deleteProfile('nonexistent')).toBe(false);
    });

    it('deletes profile and returns true', async () => {
      const { existsSync, unlinkSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { deleteProfile } = await import('../../src/lib/config.js');
      expect(deleteProfile('dev')).toBe(true);
      expect(unlinkSync).toHaveBeenCalledWith('/mock/.247/profiles/dev.json');
    });
  });

  describe('createConfig', () => {
    it('creates config with defaults and provided options', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const config = createConfig({ machineName: 'My Machine' });

      expect(config.machine.id).toBe('test-uuid-1234');
      expect(config.machine.name).toBe('My Machine');
      expect(config.agent.port).toBe(4678);
      expect(config.projects.basePath).toBe('~/Dev');
    });

    it('uses provided port and projects path', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const config = createConfig({
        machineName: 'My Machine',
        port: 5000,
        projectsPath: '/custom/path',
      });

      expect(config.agent.port).toBe(5000);
      expect(config.projects.basePath).toBe('/custom/path');
    });

    it('generates dashboard.apiKey as URL-safe base64 token', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const config = createConfig({ machineName: 'My Machine' });

      expect(config.dashboard).toBeDefined();
      expect(config.dashboard?.apiKey).toBeDefined();
      // Should be URL-safe base64 (no +, /, or = characters)
      expect(config.dashboard?.apiKey).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(config.dashboard?.apiKey?.length).toBe(43); // 32 bytes -> 43 chars base64url
    });

    it('preserves existing machine.id when provided', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const existing = {
        machine: { id: 'existing-uuid', name: 'Old Name' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
      };

      const config = createConfig({ machineName: 'New Name', existing });

      expect(config.machine.id).toBe('existing-uuid');
      expect(config.machine.name).toBe('New Name');
    });

    it('preserves existing dashboard.apiKey when provided', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const existing = {
        machine: { id: 'test-id', name: 'Test' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        dashboard: { apiKey: 'existing-token-abc123', apiUrl: 'https://example.com' },
      };

      const config = createConfig({ machineName: 'Test', existing });

      expect(config.dashboard?.apiKey).toBe('existing-token-abc123');
      expect(config.dashboard?.apiUrl).toBe('https://example.com');
    });

    it('per-secret generate-once survives a second re-init (missing apiKey minted once, then pinned)', async () => {
      const { randomBytes } = await import('crypto');
      const { createConfig } = await import('../../src/lib/config.js');

      // Queue ONE distinct non-zero value for the mint (fill 7 ≠ 0)
      // This makes the minted token different from the all-A baseline
      vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(32, 7));

      const existing = {
        machine: { id: 'seeded-real-uuid', name: 'Old Name' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        // No dashboard field - apiKey should be minted on first run
      };

      // Run 1: mints the missing apiKey
      const run1 = createConfig({ machineName: 'M', existing });

      expect(run1.machine.id).toBe('seeded-real-uuid');
      expect(run1.dashboard?.apiKey).toBeDefined();

      // The minted token should be base64url of all-7 buffer (not all-A baseline)
      const expectedToken = Buffer.alloc(32, 7).toString('base64url');
      expect(run1.dashboard?.apiKey).toBe(expectedToken);
      expect(run1.dashboard?.apiKey).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(run1.dashboard?.apiKey?.length).toBe(expectedToken.length);

      // Run 2: must preserve the once-minted token (not re-mint)
      const run2 = createConfig({ machineName: 'M', existing: run1 });

      expect(run2.machine.id).toBe('seeded-real-uuid');
      expect(run2.dashboard?.apiKey).toBe(run1.dashboard?.apiKey);

      // Lock the assumption that the queued mockReturnValueOnce was consumed exactly
      // once (by run1's mint) and run2 did NOT call randomBytes. vi.clearAllMocks()
      // does not drain a *Once queue, so if a future refactor stops run1 from minting,
      // the all-7 buffer would leak into the next test — this guard fails loudly first.
      expect(vi.mocked(randomBytes)).toHaveBeenCalledTimes(1);
    });

    it('generates new secrets when not in existing config', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const existing = {
        machine: { id: '', name: 'Test' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
      };

      const config = createConfig({ machineName: 'Test', existing });

      expect(config.machine.id).toBe('test-uuid-1234');
      expect(config.dashboard?.apiKey).toBeDefined();
    });

    it('handles partial existing config (only machine.id present)', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const existing = {
        machine: { id: 'preserved-uuid', name: 'Test' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        // No dashboard field - should generate apiKey
      };

      const config = createConfig({ machineName: 'Test', existing });

      expect(config.machine.id).toBe('preserved-uuid');
      expect(config.dashboard?.apiKey).toBeDefined();
      expect(config.dashboard?.apiKey).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('preserves existing projects.whitelist across re-init', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const existing = {
        machine: { id: 'test-id', name: 'Test' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: ['project-a', 'project-b'] },
      };

      const config = createConfig({ machineName: 'Test', existing });

      expect(config.projects.whitelist).toEqual(['project-a', 'project-b']);
    });

    it('preserves existing editor settings across re-init', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      const existing = {
        machine: { id: 'test-id', name: 'Test' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: [] },
        editor: { enabled: true, portRange: { start: 5000, end: 5010 }, idleTimeout: 60000 },
      };

      const config = createConfig({ machineName: 'Test', existing });

      expect(config.editor).toEqual({
        enabled: true,
        portRange: { start: 5000, end: 5010 },
        idleTimeout: 60000,
      });
    });

    it('does not throw when existing config is missing the machine key', async () => {
      const { createConfig } = await import('../../src/lib/config.js');
      // Hand-edited / older-format config with no machine block.
      const existing = { agent: { port: 4678 } } as never;

      const config = createConfig({ machineName: 'Test', existing });

      // Falls back to a freshly minted id rather than crashing.
      expect(config.machine.id).toBe('test-uuid-1234');
      expect(config.machine.name).toBe('Test');
    });

    it('247 init -f is idempotent: machine.id + apiKey stable across repeated re-inits', async () => {
      const { createConfig } = await import('../../src/lib/config.js');

      // CRITICAL: seeded values MUST differ from mocked-fresh constants
      // (randomUUID → 'test-uuid-1234', randomBytes(32) → all-zero base64url).
      // Otherwise a buggy regenerate-always createConfig would still pass.
      const existing = {
        machine: { id: 'seeded-real-uuid', name: 'Old Name' },
        agent: { port: 4678 },
        projects: { basePath: '~/Dev', whitelist: ['project-a', 'project-b'] },
        dashboard: { apiUrl: 'https://seeded.example.com', apiKey: 'seeded-real-token-xyz' },
        editor: { enabled: true, portRange: { start: 5000, end: 5010 }, idleTimeout: 60000 },
      };

      // Simulate the fixpoint loop: each run's output becomes the next run's existing
      const run1 = createConfig({ machineName: 'M', existing });
      const run2 = createConfig({ machineName: 'M', existing: run1 });
      const run3 = createConfig({ machineName: 'M', existing: run2 });

      // All runs preserve the seeded distinct values
      expect(run1.machine.id).toBe('seeded-real-uuid');
      expect(run2.machine.id).toBe('seeded-real-uuid');
      expect(run3.machine.id).toBe('seeded-real-uuid');

      expect(run1.dashboard?.apiKey).toBe('seeded-real-token-xyz');
      expect(run2.dashboard?.apiKey).toBe('seeded-real-token-xyz');
      expect(run3.dashboard?.apiKey).toBe('seeded-real-token-xyz');

      // apiUrl walks the `preservedApiUrl ? {apiUrl,apiKey} : {apiKey}` branch — guard
      // against a regression that drops it on the 2nd/3rd re-init.
      expect(run1.dashboard?.apiUrl).toBe('https://seeded.example.com');
      expect(run2.dashboard?.apiUrl).toBe('https://seeded.example.com');
      expect(run3.dashboard?.apiUrl).toBe('https://seeded.example.com');

      // User-curated state (whitelist, editor) must survive the fixpoint loop too.
      expect(run3.projects.whitelist).toEqual(['project-a', 'project-b']);
      expect(run3.editor).toEqual({
        enabled: true,
        portRange: { start: 5000, end: 5010 },
        idleTimeout: 60000,
      });
    });
  });

  describe('configExists', () => {
    it('returns true if config file exists', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(true);

      const { configExists } = await import('../../src/lib/config.js');
      expect(configExists()).toBe(true);
    });

    it('returns false if config file does not exist', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      const { configExists } = await import('../../src/lib/config.js');
      expect(configExists()).toBe(false);
    });
  });
});
