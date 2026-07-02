import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

export interface AgentConfig {
  machine: {
    id: string;
    name: string;
  };
  agent?: {
    port?: number;
    url?: string;
  };
  projects: {
    basePath: string;
    whitelist: string[];
  };
  dashboard?: {
    apiUrl?: string;
    apiKey?: string;
  };
}

let cachedConfig: AgentConfig | null = null;

// Fall back to homedir() (not literal '~') so the path still resolves under the
// home directory when HOME is unset, instead of landing in cwd/~/.247.
const CONFIG_DIR = resolve(process.env.HOME || homedir(), '.247');

/**
 * Get config file path based on profile name
 */
function getConfigPath(profileName?: string): string {
  if (profileName) {
    return resolve(CONFIG_DIR, 'profiles', `${profileName}.json`);
  }
  return resolve(CONFIG_DIR, 'config.json');
}

/**
 * Load agent configuration from ~/.247/
 * Uses AGENT_247_PROFILE env var if set, otherwise default config
 */
export function loadConfig(): AgentConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const profileName = process.env.AGENT_247_PROFILE || undefined;
  const configPath = getConfigPath(profileName);

  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      cachedConfig = JSON.parse(content) as AgentConfig;
      const label = profileName ? `profile '${profileName}'` : 'default';
      console.log(`Loaded ${label} config from: ${configPath}`);
    } catch (err) {
      console.error(`Failed to load config from ${configPath}:`, err);
    }
  }

  // If profile specified but not found, try default config
  if (!cachedConfig && profileName) {
    const defaultPath = getConfigPath();
    if (existsSync(defaultPath)) {
      try {
        const content = readFileSync(defaultPath, 'utf-8');
        cachedConfig = JSON.parse(content) as AgentConfig;
        console.log(`Profile '${profileName}' not found, using default: ${defaultPath}`);
      } catch (err) {
        console.error(`Failed to load config from ${defaultPath}:`, err);
      }
    }
  }

  if (!cachedConfig) {
    throw new Error(
      `No configuration found at ${configPath}\n` + `Run '247 init' to create configuration.`
    );
  }

  // Env var overrides — useful for Docker where config file is mounted from host
  // but network addresses differ inside the container.
  if (process.env.AGENT_DASHBOARD_URL) {
    cachedConfig = {
      ...cachedConfig,
      dashboard: { ...cachedConfig.dashboard, apiUrl: process.env.AGENT_DASHBOARD_URL },
    };
    console.log(`dashboard.apiUrl overridden by AGENT_DASHBOARD_URL: ${process.env.AGENT_DASHBOARD_URL}`);
  }
  if (process.env.AGENT_URL) {
    // getAgentUrl() treats config.agent.url as a bare host[:port] (no protocol).
    // Strip any http(s):// prefix so it matches the expected format.
    const agentUrl = process.env.AGENT_URL.replace(/^https?:\/\//, '');
    cachedConfig = {
      ...cachedConfig,
      agent: { ...cachedConfig.agent, url: agentUrl },
    };
    console.log(`agent.url overridden by AGENT_URL: ${agentUrl}`);
  }

  return cachedConfig;
}

export const config = loadConfig();
