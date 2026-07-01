import type { GitCwdContext } from '247-shared';

export interface LocalMachine {
  id: string;
  name: string;
  status: 'online' | 'offline';
  color?: string;
  config?: {
    projects: string[];
    agentUrl: string;
    token?: string;
  };
}

export interface SelectedSession {
  machineId: string;
  sessionName: string;
  project: string;
  environmentId?: string;
  planningProjectId?: string;
  /** Bound sub-path (worktree or subfolder) — session's cwd (Story 6.5) */
  workingDir?: string;
  /** Classified git context for the bound path — kind, branch, boundPath (Story 6.5) */
  gitCwdContext?: GitCwdContext;
  /** Human-readable label supplied at create time (v21), sent to the agent on the create WS. */
  description?: string;
}

// Re-export StoredAgentConnection from AgentConnectionSettings for convenience
export type { StoredAgentConnection } from '@/components/AgentConnectionSettings';

// Legacy constant - deprecated, use connection IDs instead
// @deprecated Use the connection's unique ID from StoredAgentConnection instead
export const DEFAULT_MACHINE_ID = 'local-agent';
