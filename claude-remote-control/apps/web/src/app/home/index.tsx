'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Zap, Loader2, ArrowDown } from 'lucide-react';
import { SessionView } from '@/components/SessionView';
import { NewSessionModal } from '@/components/NewSessionModal';
import { AgentConnectionSettings } from '@/components/AgentConnectionSettings';
import { UnifiedAgentManager } from '@/components/UnifiedAgentManager';
import { EditAgentModal } from '@/components/EditAgentModal';
import { MobileStatusStrip } from '@/components/mobile';
import { InstallBanner } from '@/components/InstallBanner';
import { SlideOverPanel } from '@/components/ui/SlideOverPanel';
import { ConnectionGuide } from '@/components/ConnectionGuide';
import { LoadingView } from './LoadingView';
import { NoConnectionView } from './NoConnectionView';
import { useHomeState } from './useHomeState';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { useViewportHeight } from '@/hooks/useViewportHeight';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { useNotificationDeeplink } from '@/hooks/useNotificationDeeplink';
import { useInAppNotifications } from '@/hooks/useInAppNotifications';
import { useNotificationPreferences } from '@/hooks/useNotificationPreferences';
import { useSoundNotifications } from '@/hooks/useSoundNotifications';
import { useSessionActions } from '@/hooks/useSessionActions';
import { useTaskActions } from '@/hooks/useTaskActions';
import { useGitActions } from '@/hooks/useGitActions';
import { GitPanel } from '@/components/GitPanel';
import type { GitCommit } from '247-shared';
import { TaskPanel, type AllocatableSession } from '@/components/TaskPanel';
import { useAuth } from '@/lib/auth/client';
import { NotificationSettingsPanel } from '@/components/NotificationSettingsPanel';
import { TokenCoveragePanel } from '@/components/TokenCoveragePanel';
import { useSessionPolling, type SessionWithMachine } from '@/contexts/SessionPollingContext';
// New layout components
import { AppShell } from '@/components/layout';
import type { SidebarMachine, SidebarProject } from '@/components/layout/Sidebar';
import type { SessionListItem } from '@/components/layout/SessionListPanel';
import type { SessionStatus } from '@/components/ui/status-indicator';

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function mapMachineType(method: string): SidebarMachine['type'] {
  if (method === 'localhost' || method === 'local') return 'localhost';
  if (method === 'tailscale') return 'tailscale';
  if (method === 'fly') return 'fly';
  return 'custom';
}

function mapSessionStatus(session: SessionWithMachine): SessionStatus {
  if (session.status === 'working') return 'working';
  if (session.status === 'needs_attention') return 'needs_attention';
  if (session.status === 'init') return 'init';
  return 'idle';
}

export function HomeContent() {
  const isMobile = useIsMobile();

  // Current web user id — tags newly-created sessions so the agent can isolate
  // each user's sessions (per-user view isolation).
  const { getSession } = useAuth();
  const [currentUserId, setCurrentUserId] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    getSession().then((session) => {
      if (!cancelled) setCurrentUserId(session.data.user?.id ?? undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [getSession]);

  // Set CSS variable for viewport height (handles mobile keyboard)
  useViewportHeight();

  // Handle notification deep links (iOS PWA fallback)
  useNotificationDeeplink();

  // Notification preferences and sound
  const { soundEnabled, getSelectedSoundPath } = useNotificationPreferences();
  const { playSound } = useSoundNotifications({ soundPath: getSelectedSoundPath() });

  // Handle in-app notifications when app is in foreground (from push notifications)
  useInAppNotifications({
    onNotification: soundEnabled ? playSound : undefined,
  });

  const {
    loading,
    agentConnection,
    agentConnections,
    connectionModalOpen,
    setConnectionModalOpen,
    newSessionOpen,
    setNewSessionOpen,
    selectedSession,
    setSelectedSession,
    isFullscreen,
    setIsFullscreen,
    allSessions,
    currentMachine,
    machines,
    getArchivedSessions: _getArchivedSessions,
    getAgentUrl,
    getAgentToken,
    getSelectedSessionInfo,
    handleSelectSession,
    handleStartSession,
    handleSessionCreated,
    handleSessionKilled,
    handleSessionArchived,
    handleConnectionSaved,
    handleConnectionRemoved,
    handleConnectionEdited,
    handleConnectionCleared,
    clearSessionFromUrl,
  } = useHomeState();

  // Shared session actions hook (used by both desktop SessionListPanel and mobile MobileStatusStrip)
  const { killSession, archiveSession, acknowledgeSession } = useSessionActions(agentConnections);

  // Get session count per agent for the header
  const {
    sessionsByMachine,
    isWsConnected,
    refreshMachine,
    setOnNeedsAttention,
    getTasksForProject,
    getGitStatusForProject,
    refreshTasks,
  } = useSessionPolling();

  // Task actions (create/update/delete) — owner identity threaded for isolation.
  const taskViewer = useMemo(
    () => ({ ownerId: currentUserId ?? null, isOwner: false }),
    [currentUserId]
  );
  const { createTask, updateTask, deleteTask } = useTaskActions(agentConnections, taskViewer);

  // Git actions hook for history operations
  const { fetchStatus, fetchLog, fetchCommit, fetchDiff, fetchGraph } = useGitActions(agentConnections, taskViewer);

  // Register sound notification callback for needs_attention status changes
  useEffect(() => {
    if (soundEnabled) {
      setOnNeedsAttention(() => {
        playSound();
      });
    } else {
      setOnNeedsAttention(undefined);
    }
    return () => setOnNeedsAttention(undefined);
  }, [soundEnabled, playSound, setOnNeedsAttention]);

  // Git history state
  const [gitOpen, setGitOpen] = useState(false);
  const [selectedGitRepo, setSelectedGitRepo] = useState<string | null>(null);
  const [gitCommits, setGitCommits] = useState<GitCommit[]>([]);
  const [gitGraphCommits, setGitGraphCommits] = useState<GitCommit[] | null>(null);
  const [gitGraphCapped, setGitGraphCapped] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitGraphLoading, setGitGraphLoading] = useState(false);
  const [gitPage, setGitPage] = useState(0);
  const [gitHasMore, setGitHasMore] = useState(false);
  const GIT_PAGE_SIZE = 50;

  // Slide-over panel states
  const [guideOpen, setGuideOpen] = useState(false);
  const [unifiedManagerOpen, setUnifiedManagerOpen] = useState(false);
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState(false);
  const [tokenCoverageOpen, setTokenCoverageOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);

  // Edit machine modal state (for sidebar context menu)
  const [editingMachine, setEditingMachine] = useState<SidebarMachine | null>(null);

  // Filter states for sidebar
  const [machineFilter, setMachineFilter] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  // ═══════════════════════════════════════════════════════════════════════════
  // Data transformations for new layout
  // ═══════════════════════════════════════════════════════════════════════════

  // Transform agentConnections → SidebarMachine[]
  const sidebarMachines: SidebarMachine[] = useMemo(
    () =>
      agentConnections.map((conn) => {
        const machineData = sessionsByMachine.get(conn.id);
        const wsConnected = isWsConnected(conn.id);
        return {
          id: conn.id,
          name: conn.name,
          type: mapMachineType(conn.method),
          status: machineData?.error ? 'offline' : wsConnected ? 'online' : 'connecting',
          sessionCount: machineData?.sessions?.length ?? 0,
          color: conn.color,
        };
      }),
    [agentConnections, sessionsByMachine, isWsConnected]
  );

  // Transform allSessions → SessionListItem[]
  const sessionListItems: SessionListItem[] = useMemo(
    () =>
      allSessions.map((session) => ({
        id: `${session.machineId}-${session.name}`,
        name: session.name,
        project: session.project,
        status: mapSessionStatus(session),
        updatedAt: new Date(session.lastActivity || session.createdAt),
        createdAt: new Date(session.createdAt),
        model: session.model,
        cost: session.costUsd,
        machineId: session.machineId,
      })),
    [allSessions]
  );

  // Extract unique projects from sessions
  const sidebarProjects: SidebarProject[] = useMemo(() => {
    const projectMap = new Map<string, number>();
    allSessions.forEach((s) => {
      projectMap.set(s.project, (projectMap.get(s.project) || 0) + 1);
    });
    return Array.from(projectMap.entries()).map(([name, count]) => ({
      name,
      path: name,
      activeSessionCount: count,
    }));
  }, [allSessions]);

  // Compute selectedSessionId for the new layout
  const selectedSessionId = selectedSession
    ? `${selectedSession.machineId}-${selectedSession.sessionName}`
    : null;

  // Filter sessions by machine and project
  const filteredSessionListItems = useMemo(() => {
    let filtered = sessionListItems;
    if (machineFilter) {
      filtered = filtered.filter((s) => s.machineId === machineFilter);
    }
    if (projectFilter) {
      filtered = filtered.filter((s) => s.project === projectFilter);
    }
    return filtered;
  }, [sessionListItems, machineFilter, projectFilter]);

  // Scope for the Tasks panel: the project + machine whose tasks we show.
  // Precedence: the open session's project → the project filter → first project.
  const taskScope = useMemo(() => {
    let project: string | null = null;
    let machineId: string | null = null;

    if (selectedSession) {
      project = selectedSession.project;
      machineId = selectedSession.machineId;
    } else if (projectFilter) {
      project = projectFilter;
      machineId =
        allSessions.find((s) => s.project === projectFilter)?.machineId ??
        agentConnections[0]?.id ??
        null;
    } else {
      const first = allSessions[0];
      project = first?.project ?? null;
      machineId = first?.machineId ?? agentConnections[0]?.id ?? null;
    }

    return { project, machineId };
  }, [selectedSession, projectFilter, allSessions, agentConnections]);

  // Open sessions for the scoped project — the allocation dropdown options.
  const taskScopeSessions: AllocatableSession[] = useMemo(() => {
    if (!taskScope.project) return [];
    return allSessions
      .filter((s) => s.project === taskScope.project)
      .map((s) => ({ name: s.name, label: s.name }));
  }, [allSessions, taskScope.project]);

  const scopedTasks = useMemo(
    () =>
      taskScope.machineId && taskScope.project
        ? getTasksForProject(taskScope.machineId, taskScope.project)
        : [],
    [getTasksForProject, taskScope.machineId, taskScope.project]
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Git history handlers
  // ═══════════════════════════════════════════════════════════════════════════

  const handleFetchGitLog = useCallback(
    async (machineId: string, repoPath: string) => {
      setGitLoading(true);
      try {
        const commits = await fetchLog(machineId, repoPath, GIT_PAGE_SIZE, 0);
        if (commits) {
          setGitCommits(commits);
          setGitPage(0);
          setGitHasMore(commits.length >= GIT_PAGE_SIZE);
        }
      } finally {
        setGitLoading(false);
      }
    },
    [fetchLog]
  );

  const handleLoadMore = useCallback(
    async (machineId: string, repoPath: string) => {
      setGitLoading(true);
      try {
        const nextPage = gitPage + 1;
        const commits = await fetchLog(machineId, repoPath, GIT_PAGE_SIZE, nextPage * GIT_PAGE_SIZE);
        if (commits) {
          if (commits.length > 0) {
            setGitCommits((prev) => [...prev, ...commits]);
            setGitPage(nextPage);
          }
          setGitHasMore(commits.length >= GIT_PAGE_SIZE);
        }
      } finally {
        setGitLoading(false);
      }
    },
    [fetchLog, gitPage]
  );

  // Use refs to avoid stale closures in commit/diff fetch callbacks
  const selectedGitRepoRef = useRef(selectedGitRepo);
  useEffect(() => {
    selectedGitRepoRef.current = selectedGitRepo;
  }, [selectedGitRepo]);

  const taskScopeMachineIdRef = useRef(taskScope.machineId);
  useEffect(() => {
    taskScopeMachineIdRef.current = taskScope.machineId;
  }, [taskScope.machineId]);

  const handleFetchCommit = useCallback(
    async (hash: string) => {
      const machineId = taskScopeMachineIdRef.current;
      const repo = selectedGitRepoRef.current;
      if (!machineId || !repo) return null;
      return fetchCommit(machineId, repo, hash);
    },
    [fetchCommit]
  );

  const handleFetchDiff = useCallback(
    async (hash: string, filePath: string, signal?: AbortSignal) => {
      const machineId = taskScopeMachineIdRef.current;
      const repo = selectedGitRepoRef.current;
      if (!machineId || !repo) return null;
      return fetchDiff(machineId, repo, hash, filePath, signal);
    },
    [fetchDiff]
  );

  const handleFetchGraph = useCallback(
    async (machineId: string, repoPath: string) => {
      setGitGraphLoading(true);
      try {
        const result = await fetchGraph(machineId, repoPath, 500);
        if (result) {
          setGitGraphCommits(result.commits);
          setGitGraphCapped(result.capped);
        }
      } finally {
        setGitGraphLoading(false);
      }
    },
    [fetchGraph]
  );

  const handleToggleGraph = useCallback(async () => {
    if (gitGraphCommits === null && taskScope.machineId && selectedGitRepo) {
      await handleFetchGraph(taskScope.machineId, selectedGitRepo);
    }
  }, [gitGraphCommits, taskScope.machineId, selectedGitRepo, handleFetchGraph]);

  // Refetch the log and reset all history state whenever the selected repo
  // changes (or the panel opens). Without this, switching repos left the
  // previous repo's commit list visible and clicking a commit fetched it
  // against the wrong repo. This effect owns log fetching; handleOpenGit only
  // opens the panel and auto-selects the first repo.
  useEffect(() => {
    setGitGraphCommits(null);
    setGitGraphCapped(false);
    setGitCommits([]);
    setGitPage(0);
    setGitHasMore(false);
    if (!gitOpen) return;
    const machineId = taskScope.machineId;
    if (machineId && selectedGitRepo) {
      void handleFetchGitLog(machineId, selectedGitRepo);
    }
  }, [selectedGitRepo, gitOpen, taskScope.machineId, handleFetchGitLog]);

  const handleOpenGit = useCallback(() => {
    setGitOpen(true);
    if (taskScope.machineId && taskScope.project) {
      fetchStatus(taskScope.machineId, taskScope.project);
      const gitRepos = getGitStatusForProject(taskScope.machineId, taskScope.project);
      const firstRepoPath = gitRepos.size > 0 ? Array.from(gitRepos.keys())[0] : null;
      if (firstRepoPath && !selectedGitRepo) {
        setSelectedGitRepo(firstRepoPath);
      }
    }
  }, [taskScope.machineId, taskScope.project, selectedGitRepo, getGitStatusForProject, fetchStatus]);

  // ═══════════════════════════════════════════════════════════════════════════
  // Callback handlers for new layout
  // ═══════════════════════════════════════════════════════════════════════════

  // Handler for machine selection (toggle filter)
  const handleSelectMachine = useCallback((machineId: string) => {
    setMachineFilter((prev) => (prev === machineId ? null : machineId));
  }, []);

  // Handler for project selection (toggle filter)
  const handleSelectProject = useCallback((projectName: string) => {
    setProjectFilter((prev) => (prev === projectName ? null : projectName));
  }, []);

  // Handler for editing machine from sidebar
  const handleEditMachineFromSidebar = useCallback((machine: SidebarMachine) => {
    setEditingMachine(machine);
  }, []);

  // Handler for removing machine from sidebar
  const handleRemoveMachineFromSidebar = useCallback(
    async (machine: SidebarMachine) => {
      await handleConnectionRemoved(machine.id);
    },
    [handleConnectionRemoved]
  );

  // Check if machine can be removed (not the last one)
  const canRemoveMachine = useCallback(() => {
    return agentConnections.length > 1;
  }, [agentConnections.length]);

  // Handler pour sélection depuis SessionListPanel
  const handleSelectSessionFromList = useCallback(
    (item: SessionListItem) => {
      // Auto-acknowledge if needs_attention (replicate HomeSidebar behavior)
      if (item.status === 'needs_attention' && item.machineId) {
        acknowledgeSession(item.machineId, item.name);
      }
      handleSelectSession(item.machineId!, item.name, item.project);
    },
    [handleSelectSession, acknowledgeSession]
  );

  // Handler pour kill depuis SessionListPanel (uses shared hook)
  const handleKillSessionFromList = useCallback(
    async (item: SessionListItem) => {
      const success = await killSession(item.machineId!, item.name);
      if (success) {
        handleSessionKilled(item.machineId!, item.name);
      }
    },
    [killSession, handleSessionKilled]
  );

  // Handler pour archive depuis SessionListPanel (uses shared hook)
  const handleArchiveSessionFromList = useCallback(
    async (item: SessionListItem) => {
      const success = await archiveSession(item.machineId!, item.name);
      if (success) {
        handleSessionArchived(item.machineId!, item.name);
      }
    },
    [archiveSession, handleSessionArchived]
  );

  // Create agent status and session count maps for UnifiedAgentManager
  const agentStatuses = new Map<string, 'online' | 'offline' | 'connecting'>();
  const sessionCountsMap = new Map<string, number>();
  agentConnections.forEach((conn) => {
    const machineData = sessionsByMachine.get(conn.id);
    const wsConnected = isWsConnected(conn.id);
    agentStatuses.set(
      conn.id,
      machineData?.error ? 'offline' : wsConnected ? 'online' : 'connecting'
    );
    sessionCountsMap.set(conn.id, machineData?.sessions?.length ?? 0);
  });

  // Pull-to-refresh for mobile PWA
  const { pullDistance, isRefreshing, isPulling, isThresholdReached, handlers } = usePullToRefresh({
    onRefresh: async () => {
      if (currentMachine) {
        await refreshMachine(currentMachine.id);
      }
    },
    disabled: !isMobile,
  });

  if (loading) {
    return <LoadingView />;
  }

  // Show NoConnectionView if no agent connected
  if (!agentConnection) {
    return (
      <NoConnectionView
        modalOpen={connectionModalOpen}
        onModalOpenChange={setConnectionModalOpen}
        onConnectionSaved={handleConnectionSaved}
      />
    );
  }

  // Handler for menu button in session view (desktop only - goes back to session list)
  const handleMenuClick = () => {
    setSelectedSession(null);
    clearSessionFromUrl();
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Shared Modals (rendered outside main layout)
  // ═══════════════════════════════════════════════════════════════════════════

  const modals = (
    <>
      {/* Connection Settings Modal (legacy fallback) */}
      <AgentConnectionSettings
        open={connectionModalOpen}
        onOpenChange={setConnectionModalOpen}
        onSave={handleConnectionSaved}
        onDisconnect={handleConnectionCleared}
        hasConnection={!!agentConnection}
      />

      {/* Unified Agent Manager */}
      <UnifiedAgentManager
        open={unifiedManagerOpen}
        onClose={() => setUnifiedManagerOpen(false)}
        connectedAgents={agentConnections}
        agentStatuses={agentStatuses}
        sessionCounts={sessionCountsMap}
        onDisconnectAgent={handleConnectionRemoved}
        onConnectNewAgent={handleConnectionSaved}
        onEditAgent={handleConnectionEdited}
      />

      {/* New Session Modal */}
      <NewSessionModal
        open={newSessionOpen}
        onOpenChange={setNewSessionOpen}
        machines={machines}
        onStartSession={handleStartSession}
      />

      {/* Guide Slide-Over Panel */}
      <SlideOverPanel open={guideOpen} onClose={() => setGuideOpen(false)} title="Connection Guide">
        <ConnectionGuide />
      </SlideOverPanel>

      {/* Notification Settings Slide-Over Panel */}
      <SlideOverPanel
        open={notificationSettingsOpen}
        onClose={() => setNotificationSettingsOpen(false)}
        title="Notification Settings"
      >
        <NotificationSettingsPanel />
      </SlideOverPanel>

      {/* Token Coverage Slide-Over Panel */}
      <SlideOverPanel
        open={tokenCoverageOpen}
        onClose={() => setTokenCoverageOpen(false)}
        title="Token Coverage"
      >
        <TokenCoveragePanel />
      </SlideOverPanel>

      {/* Tasks Slide-Over Panel (per-project todo list) */}
      <SlideOverPanel open={tasksOpen} onClose={() => setTasksOpen(false)} title="Tasks">
        {taskScope.project && taskScope.machineId ? (
          (() => {
            // Narrow once so the action callbacks don't need non-null assertions.
            const scopeMachineId = taskScope.machineId;
            return (
              <TaskPanel
                project={taskScope.project}
                tasks={scopedTasks}
                sessions={taskScopeSessions}
                onCreate={(input) => createTask(scopeMachineId, input)}
                onUpdate={(taskId, input) => updateTask(scopeMachineId, taskId, input)}
                onDelete={(taskId) => deleteTask(scopeMachineId, taskId)}
              />
            );
          })()
        ) : (
          <p className="text-sm text-white/40">
            Open or select a project to manage its tasks.
          </p>
        )}
      </SlideOverPanel>

      {/* Git History Slide-Over Panel */}
      <SlideOverPanel open={gitOpen} onClose={() => setGitOpen(false)} title="Git">
        {taskScope.project && taskScope.machineId ? (
          (() => {
            const scopeMachineId = taskScope.machineId!;
            const gitRepos = getGitStatusForProject(scopeMachineId, taskScope.project!);
            const repos = Array.from(gitRepos.entries()).map(([repoPath, status]) => ({
              repoPath,
              isWorktree: false,
              status,
            }));

            return (
              <GitPanel
                project={taskScope.project!}
                repos={repos}
                selectedRepo={selectedGitRepo}
                commits={gitCommits}
                graphCommits={gitGraphCommits}
                graphCapped={gitGraphCapped}
                loadingHistory={gitLoading}
                graphLoading={gitGraphLoading}
                wsConnected={isWsConnected(scopeMachineId)}
                onSelectRepo={setSelectedGitRepo}
                onLoadMore={gitHasMore && selectedGitRepo
                  ? () => handleLoadMore(scopeMachineId, selectedGitRepo)
                  : undefined}
                onToggleGraph={handleToggleGraph}
                onFetchCommit={handleFetchCommit}
                onFetchDiff={handleFetchDiff}
              />
            );
          })()
        ) : (
          <p className="text-sm text-white/40">
            Open or select a project to view git status.
          </p>
        )}
      </SlideOverPanel>

      {/* Edit Machine Modal - triggered from Sidebar */}
      {editingMachine && (
        <EditAgentModal
          open={!!editingMachine}
          onClose={() => setEditingMachine(null)}
          agentId={editingMachine.id}
          agentName={editingMachine.name}
          agentColor={editingMachine.color}
          onSave={async (id, data) => {
            await handleConnectionEdited(id, data);
            setEditingMachine(null);
          }}
        />
      )}
    </>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Desktop Layout - New 3-Panel AppShell
  // ═══════════════════════════════════════════════════════════════════════════

  if (!isMobile) {
    return (
      <>
        <AppShell
          // Sidebar props
          machines={sidebarMachines}
          projects={sidebarProjects}
          selectedMachineId={machineFilter}
          onSelectMachine={handleSelectMachine}
          onAddMachine={() => setUnifiedManagerOpen(true)}
          selectedProjectName={projectFilter}
          onSelectProject={handleSelectProject}
          onEditMachine={handleEditMachineFromSidebar}
          onRemoveMachine={handleRemoveMachineFromSidebar}
          canRemoveMachine={canRemoveMachine}
          // Session list props
          sessions={filteredSessionListItems}
          selectedSessionId={selectedSessionId}
          onSelectSession={handleSelectSessionFromList}
          onNewSession={() => setNewSessionOpen(true)}
          onKillSession={handleKillSessionFromList}
          onArchiveSession={handleArchiveSessionFromList}
          // Header props
          currentMachineName={currentMachine?.name}
          currentProjectName={selectedSession?.project}
          isFullscreen={isFullscreen}
          onToggleFullscreen={() => setIsFullscreen((prev) => !prev)}
          onOpenNotificationSettings={() => setNotificationSettingsOpen(true)}
          onOpenTokenCoverage={() => setTokenCoverageOpen(true)}
          onOpenTasks={() => {
            if (taskScope.machineId) refreshTasks(taskScope.machineId);
            setTasksOpen(true);
          }}
          onOpenGit={handleOpenGit}
        >
          {/* Main content */}
          {selectedSession ? (
            <SessionView
              key={`${selectedSession.machineId}-${selectedSession.project}-${selectedSession.sessionName.endsWith('--new') ? 'new' : selectedSession.sessionName}`}
              sessionName={selectedSession.sessionName}
              project={selectedSession.project}
              agentUrl={getAgentUrl()}
              agentToken={getAgentToken()}
              sessionInfo={getSelectedSessionInfo()}
              environmentId={selectedSession.environmentId}
              planningProjectId={selectedSession.planningProjectId}
              onMenuClick={handleMenuClick}
              onSessionCreated={handleSessionCreated}
              isMobile={false}
              owner={currentUserId}
              workingDir={selectedSession.workingDir}
              gitCwdContext={selectedSession.gitCwdContext}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-orange-500/10 bg-orange-500/5">
                  <Zap className="h-8 w-8 text-orange-500/30" />
                </div>
                <p className="text-sm text-white/40">Select a session or create a new one</p>
              </div>
            </div>
          )}
        </AppShell>
        {modals}
      </>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mobile Layout - Existing layout with MobileStatusStrip
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <main
      className="h-screen-safe flex flex-col overflow-hidden bg-[#0a0a10]"
      onTouchStart={handlers.onTouchStart}
      onTouchMove={handlers.onTouchMove}
      onTouchEnd={handlers.onTouchEnd}
    >
      {/* Pull-to-refresh indicator */}
      {(isPulling || isRefreshing) && (
        <div
          className="pointer-events-none fixed left-0 right-0 z-50 flex justify-center"
          style={{
            top: 0,
            transform: `translateY(${Math.min(pullDistance - 30, 50)}px)`,
            opacity: Math.min(pullDistance / 40, 1),
            transition: isRefreshing ? 'none' : 'opacity 0.1s ease-out',
          }}
        >
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-full ${
              isThresholdReached || isRefreshing
                ? 'bg-orange-500/20 text-orange-400'
                : 'bg-white/10 text-white/60'
            }`}
            style={{
              transition: 'background-color 0.15s, color 0.15s',
            }}
          >
            {isRefreshing ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <ArrowDown
                className="h-5 w-5 transition-transform duration-150"
                style={{
                  transform: isThresholdReached ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              />
            )}
          </div>
        </div>
      )}

      {/* Mobile Status Strip */}
      <MobileStatusStrip
        sessions={allSessions}
        currentSession={selectedSession}
        onSelectSession={handleSelectSession}
        onNewSession={() => setNewSessionOpen(true)}
        onConnectionSettingsClick={() => setUnifiedManagerOpen(true)}
        onSessionKilled={handleSessionKilled}
        // Session actions from shared hook
        onKillSession={killSession}
        onArchiveSession={archiveSession}
        // Filtering
        machines={sidebarMachines.map((m) => ({ id: m.id, name: m.name, color: m.color }))}
        machineFilter={machineFilter}
        onSelectMachine={(id) => setMachineFilter(id)}
        projects={sidebarProjects.map((p) => p.name)}
        projectFilter={projectFilter}
        onSelectProject={(name) => setProjectFilter(name)}
      />

      {/* Main Content Area */}
      <div className="relative flex flex-1 flex-col overflow-hidden">
        {selectedSession ? (
          <SessionView
            key={`${selectedSession.machineId}-${selectedSession.project}-${selectedSession.sessionName.endsWith('--new') ? 'new' : selectedSession.sessionName}`}
            sessionName={selectedSession.sessionName}
            project={selectedSession.project}
            agentUrl={getAgentUrl()}
            agentToken={getAgentToken()}
            sessionInfo={getSelectedSessionInfo()}
            environmentId={selectedSession.environmentId}
            planningProjectId={selectedSession.planningProjectId}
            onMenuClick={handleMenuClick}
            onSessionCreated={handleSessionCreated}
            isMobile={true}
            owner={currentUserId}
            workingDir={selectedSession.workingDir}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-orange-500/10 bg-orange-500/5">
                <Zap className="h-8 w-8 text-orange-500/30" />
              </div>
              <p className="text-sm text-white/40">Select a session or create a new one</p>
            </div>
          </div>
        )}
      </div>

      {modals}

      {/* PWA Install Banner - only on mobile */}
      <InstallBanner />
    </main>
  );
}
