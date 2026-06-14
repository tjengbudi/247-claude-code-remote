import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID, randomBytes } from 'crypto';
import { getAgentPaths, ensureDirectories } from './paths.js';

export interface AgentConfig {
  machine: {
    id: string;
    name: string;
  };
  agent: {
    port: number;
  };
  projects: {
    basePath: string;
    whitelist: string[];
  };
  editor?: {
    enabled: boolean;
    portRange: { start: number; end: number };
    idleTimeout: number;
  };
  dashboard?: {
    apiUrl?: string;
    apiKey?: string;
  };
}

/**
 * Generate a URL-safe base64 token for agent authentication.
 * 32 bytes -> 43 chars base64url (no +, /, or = characters).
 * Suitable for Sec-WebSocket-Protocol values per D7 wire contract.
 */
export function generateAgentAuthToken(): string {
  return randomBytes(32).toString('base64url');
}

const DEFAULT_CONFIG: AgentConfig = {
  machine: {
    id: '',
    name: '',
  },
  agent: {
    port: 4678,
  },
  projects: {
    basePath: '~/Dev',
    whitelist: [],
  },
  editor: {
    enabled: false,
    portRange: { start: 4680, end: 4699 },
    idleTimeout: 1800000,
  },
};

/**
 * Get the profiles directory path
 */
export function getProfilesDir(): string {
  const paths = getAgentPaths();
  return join(paths.configDir, 'profiles');
}

/**
 * Get the config file path for a specific profile
 * @param profileName - Profile name, or undefined/null/'default' for default config
 */
export function getProfilePath(profileName?: string | null): string {
  const paths = getAgentPaths();

  if (!profileName || profileName === 'default') {
    return paths.configPath;
  }

  return join(getProfilesDir(), `${profileName}.json`);
}

/**
 * List all available profiles
 */
export function listProfiles(): string[] {
  const paths = getAgentPaths();
  const profilesDir = getProfilesDir();

  const profiles: string[] = [];

  // Add default profile if it exists
  if (existsSync(paths.configPath)) {
    profiles.push('default');
  }

  // Add named profiles
  if (existsSync(profilesDir)) {
    const files = readdirSync(profilesDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        profiles.push(file.replace('.json', ''));
      }
    }
  }

  return profiles;
}

/**
 * Check if a profile exists
 */
export function profileExists(profileName?: string | null): boolean {
  const configPath = getProfilePath(profileName);
  return existsSync(configPath);
}

/**
 * Delete a profile
 */
export function deleteProfile(profileName: string): boolean {
  if (!profileName || profileName === 'default') {
    throw new Error('Cannot delete default profile');
  }

  const configPath = getProfilePath(profileName);
  if (!existsSync(configPath)) {
    return false;
  }

  unlinkSync(configPath);
  return true;
}

/**
 * Load configuration from ~/.247/config.json or a profile
 * @param profileName - Profile name to load, or undefined for default
 */
export function loadConfig(profileName?: string | null): AgentConfig | null {
  const configPath = getProfilePath(profileName);

  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as AgentConfig;

    // Apply environment overrides
    if (process.env.AGENT_247_PORT) {
      config.agent.port = parseInt(process.env.AGENT_247_PORT, 10);
    }
    if (process.env.AGENT_247_PROJECTS) {
      config.projects.basePath = process.env.AGENT_247_PROJECTS;
    }

    return config;
  } catch (err) {
    console.error(`Failed to load config: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Save configuration to ~/.247/config.json or a profile
 * @param config - Configuration to save
 * @param profileName - Profile name to save to, or undefined for default
 */
export function saveConfig(config: AgentConfig, profileName?: string | null): void {
  const configPath = getProfilePath(profileName);
  ensureDirectories();

  // Ensure profiles directory exists for named profiles
  if (profileName && profileName !== 'default') {
    const profilesDir = getProfilesDir();
    if (!existsSync(profilesDir)) {
      mkdirSync(profilesDir, { recursive: true });
    }
  }

  const content = JSON.stringify(config, null, 2);
  writeFileSync(configPath, content, 'utf-8');
}

/**
 * Create a new configuration with defaults.
 *
 * Secrets (machine.id, dashboard.apiKey) follow generate-once discipline:
 * if `existing` is provided, those values are preserved; only missing
 * secrets are minted. User-curated non-secret state (projects.whitelist,
 * editor settings) is also carried forward so a re-init / `247 init -f`
 * never silently discards it. Only the user-facing settings that `init`
 * itself accepts as options (machine.name, agent.port, projects.basePath)
 * are taken from the provided options.
 *
 * `existing` is treated as untrusted (a hand-edited or older-format
 * config can be missing nested keys), so every read is optional-chained.
 */
export function createConfig(options: {
  machineName: string;
  port?: number;
  projectsPath?: string;
  existing?: AgentConfig | null;
}): AgentConfig {
  const preservedMachineId = options.existing?.machine?.id || randomUUID();
  const preservedApiKey = options.existing?.dashboard?.apiKey || generateAgentAuthToken();
  const preservedApiUrl = options.existing?.dashboard?.apiUrl;
  const preservedWhitelist = options.existing?.projects?.whitelist ?? [];
  const preservedEditor = options.existing?.editor ?? DEFAULT_CONFIG.editor;

  return {
    ...DEFAULT_CONFIG,
    machine: {
      id: preservedMachineId,
      name: options.machineName,
    },
    agent: {
      port: options.port ?? DEFAULT_CONFIG.agent.port,
    },
    projects: {
      basePath: options.projectsPath ?? DEFAULT_CONFIG.projects.basePath,
      whitelist: preservedWhitelist,
    },
    editor: preservedEditor,
    dashboard: preservedApiUrl
      ? { apiUrl: preservedApiUrl, apiKey: preservedApiKey }
      : { apiKey: preservedApiKey },
  };
}

/**
 * Check if configuration exists
 * @param profileName - Profile name to check, or undefined for default
 */
export function configExists(profileName?: string | null): boolean {
  const configPath = getProfilePath(profileName);
  return existsSync(configPath);
}
