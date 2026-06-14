/**
 * Profile Command Tests
 *
 * Covers `247 profile create --copy-from`: copied profiles must own unique
 * secrets (machine.id, dashboard.apiKey), never share the source's. A shared
 * machine.id collides on the dashboard; a shared apiKey is one bearer secret
 * for two agents (defeats generate-once, Story 2.1 Task 5 / Epic 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

vi.mock('crypto', () => ({
  randomUUID: () => 'fresh-copied-uuid',
}));

vi.mock('../../../src/lib/config.js', () => ({
  listProfiles: vi.fn(),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  deleteProfile: vi.fn(),
  profileExists: vi.fn(),
  createConfig: vi.fn(),
  getProfilePath: vi.fn(() => '/tmp/profile.json'),
  generateAgentAuthToken: vi.fn(() => 'fresh-copied-token'),
}));

describe('Profile Command — create --copy-from', () => {
  let originalConsoleLog: typeof console.log;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  it('regenerates machine.id and dashboard.apiKey so the copy never shares secrets', async () => {
    const { loadConfig, saveConfig, profileExists } = await import('../../../src/lib/config.js');

    const sourceConfig = {
      machine: { id: 'source-uuid', name: 'Source Machine' },
      agent: { port: 4678 },
      projects: { basePath: '~/Dev', whitelist: ['project-a'] },
      dashboard: { apiUrl: 'https://dash.example.com', apiKey: 'source-token' },
    };

    vi.mocked(profileExists).mockReturnValue(false);
    vi.mocked(loadConfig).mockReturnValue(sourceConfig as never);

    const { profileCommand } = await import('../../../src/commands/profile.js');
    await profileCommand.parseAsync(['node', 'profile', 'create', 'copy', '--copy-from', 'default']);

    expect(saveConfig).toHaveBeenCalledTimes(1);
    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0] as typeof sourceConfig;

    // Secrets must be fresh, never the source's.
    expect(savedConfig.machine.id).toBe('fresh-copied-uuid');
    expect(savedConfig.machine.id).not.toBe(sourceConfig.machine.id);
    expect(savedConfig.dashboard.apiKey).toBe('fresh-copied-token');
    expect(savedConfig.dashboard.apiKey).not.toBe(sourceConfig.dashboard.apiKey);

    // A copied dashboard.apiUrl is preserved (only the secret rotates).
    expect(savedConfig.dashboard.apiUrl).toBe('https://dash.example.com');
  });

  it('overrides machine.name when --machine-name is given, still rotating secrets', async () => {
    const { loadConfig, saveConfig, profileExists } = await import('../../../src/lib/config.js');

    const sourceConfig = {
      machine: { id: 'source-uuid', name: 'Source Machine' },
      agent: { port: 4678 },
      projects: { basePath: '~/Dev', whitelist: [] },
      dashboard: { apiKey: 'source-token' },
    };

    vi.mocked(profileExists).mockReturnValue(false);
    vi.mocked(loadConfig).mockReturnValue(sourceConfig as never);

    const { profileCommand } = await import('../../../src/commands/profile.js');
    await profileCommand.parseAsync([
      'node', 'profile', 'create', 'copy',
      '--copy-from', 'default',
      '--machine-name', 'Renamed',
    ]);

    const savedConfig = vi.mocked(saveConfig).mock.calls[0][0] as typeof sourceConfig;
    expect(savedConfig.machine.name).toBe('Renamed');
    expect(savedConfig.machine.id).toBe('fresh-copied-uuid');
    expect(savedConfig.dashboard.apiKey).toBe('fresh-copied-token');
  });
});
