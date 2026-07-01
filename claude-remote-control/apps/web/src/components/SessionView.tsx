'use client';

import { useState, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { type SessionInfo } from '@/lib/types';
import type { GitCwdContext } from '247-shared';

const Terminal = dynamic(() => import('./Terminal').then((mod) => mod.Terminal), {
  ssr: false,
  loading: () => (
    <div className="flex flex-1 items-center justify-center bg-[#0d0d14]">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-orange-500/30 border-t-orange-500" />
    </div>
  ),
});

interface SessionViewProps {
  sessionName: string;
  project: string;
  agentUrl: string;
  agentToken?: string;
  sessionInfo?: SessionInfo;
  environmentId?: string;
  planningProjectId?: string;
  onSessionCreated?: (sessionName: string) => void;
  /** Callback when menu button is clicked (goes back on desktop) */
  onMenuClick: () => void;
  /** Mobile mode for responsive styling */
  isMobile?: boolean;
  /** Web user id of the current viewer — tags newly-created sessions for per-user isolation. */
  owner?: string;
  /** Bound sub-path (worktree or subfolder) — session's cwd (Story 6.5) */
  workingDir?: string;
  /** Classified git context for bound path — kind, branch, boundPath (Story 6.5) */
  gitCwdContext?: GitCwdContext;
  /** Human-readable label supplied at create time (v21), sent to the agent on the create WS. */
  description?: string;
}

/**
 * SessionView - Minimalist session container.
 * Renders a Terminal with tmux session.
 */
export function SessionView({
  sessionName,
  project,
  agentUrl,
  agentToken,
  sessionInfo,
  environmentId,
  planningProjectId,
  onSessionCreated,
  onMenuClick,
  isMobile = false,
  owner,
  workingDir,
  gitCwdContext,
  description,
}: SessionViewProps) {
  // Connection state tracked but not displayed (shown in MinimalSessionHeader via Terminal)
  const [_isConnected, setIsConnected] = useState(false);

  const isNewSession = sessionName.endsWith('--new');

  // Use a ref to store the initial key and keep it stable throughout the component's lifecycle.
  // This prevents Terminal remount when sessionName changes from 'project--new' to actual name.
  // Without this, the history clear would happen before Ralph Loop command is written.
  const terminalKeyRef = useRef<string | null>(null);
  if (terminalKeyRef.current === null) {
    terminalKeyRef.current = isNewSession ? `${project}-new-session` : `${project}-${sessionName}`;
  }
  const terminalKey = terminalKeyRef.current;

  const handleSessionCreated = useCallback(
    (actualSessionName: string) => {
      // Notify parent of session creation
      onSessionCreated?.(actualSessionName);
    },
    [onSessionCreated]
  );

  return (
    <Terminal
      key={terminalKey}
      agentUrl={agentUrl}
      agentToken={agentToken}
      project={project}
      sessionName={isNewSession ? undefined : sessionName}
      environmentId={environmentId}
      planningProjectId={planningProjectId}
      onConnectionChange={setIsConnected}
      onSessionCreated={handleSessionCreated}
      onMenuClick={onMenuClick}
      isMobile={isMobile}
      owner={owner}
      workingDir={workingDir}
      gitCwdContext={gitCwdContext}
      description={description}
      // StatusLine metrics
      model={sessionInfo?.model}
      costUsd={sessionInfo?.costUsd}
    />
  );
}
