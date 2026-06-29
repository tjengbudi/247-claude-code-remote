'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { SessionInfo, SessionWithMachine } from '@/lib/types';
import { buildWebSocketUrl, buildApiUrl } from '@/lib/utils';
import { openAgentWebSocket } from '@/lib/ws-token';
import { requestNotificationPermission } from '@/lib/notifications';
import { wsLogger, pollingLogger, archivedLogger } from '@/lib/logger';
import { useAuth } from '@/lib/auth/client';
import type { WSSessionsMessageFromAgent, WSTaskInfo, GitRepoStatus } from '247-shared';

/**
 * Build the per-user view-isolation query string (`owner`/`isOwner`) the agent
 * uses to filter sessions to the current dashboard user. Empty when identity is
 * unknown (logged out / pre-resolve) — the agent then shows nothing private.
 *
 * Exported for unit testing the wire contract.
 */
export function viewerParams(viewer: { ownerId: string | null; isOwner: boolean }): string {
  const params = new URLSearchParams();
  if (viewer.ownerId) params.set('owner', viewer.ownerId);
  if (viewer.isOwner) params.set('isOwner', '1');
  return params.toString();
}

export interface Machine {
  id: string;
  name: string;
  status: string;
  config?: {
    projects: string[];
    agentUrl?: string;
    token?: string;
  };
}

interface MachineSessionData {
  machineId: string;
  machineName: string;
  agentUrl: string;
  sessions: SessionInfo[];
  lastFetch: number;
  error: string | null;
  wsConnected: boolean;
}

interface SessionPollingContextValue {
  sessionsByMachine: Map<string, MachineSessionData>;
  machines: Machine[];
  getSessionsForMachine: (machineId: string) => SessionInfo[];
  getAllSessions: () => SessionWithMachine[];
  getArchivedSessions: () => SessionWithMachine[];
  getSession: (machineId: string, sessionName: string) => SessionInfo | null;
  refreshMachine: (machineId: string) => Promise<void>;
  setMachines: (machines: Machine[]) => void;
  isLoading: (machineId: string) => boolean;
  getError: (machineId: string) => string | null;
  isWsConnected: (machineId: string) => boolean;
  /**
   * Register a callback for when a session changes to needs_attention.
   * Used for sound notifications.
   */
  setOnNeedsAttention: (callback: ((sessionName: string) => void) | undefined) => void;
  /** All tasks for a machine (every project). */
  getTasksForMachine: (machineId: string) => WSTaskInfo[];
  /** Tasks for a single project on a machine. */
  getTasksForProject: (machineId: string, project: string) => WSTaskInfo[];
  /** Re-fetch tasks for a machine over REST (fallback / on-demand refresh). */
  refreshTasks: (machineId: string) => Promise<void>;
  /** Git status map for a machine+project: repoPath → GitRepoStatus. */
  getGitStatusForProject: (machineId: string, project: string) => Map<string, GitRepoStatus>;
}

const SessionPollingContext = createContext<SessionPollingContextValue | null>(null);

const FALLBACK_POLLING_INTERVAL = 30000; // Fallback HTTP poll every 30s (when WS connected)
const FETCH_TIMEOUT = 5000;
const WS_RECONNECT_BASE_DELAY = 1000;
const WS_RECONNECT_MAX_DELAY = 30000;
const MAX_SESSIONS_PER_MACHINE = 50; // Limit sessions per machine (FIFO rotation)
const MAX_ARCHIVED_PER_MACHINE = 100; // Limit archived sessions per machine
const MAX_CONCURRENT_RECONNECTIONS = 3; // Limit concurrent WebSocket reconnections

interface ArchivedSessionData {
  machineId: string;
  machineName: string;
  agentUrl: string;
  sessions: SessionInfo[];
}

/**
 * Limits sessions array to maxCount using FIFO rotation.
 * Keeps the most recent sessions based on lastStatusChange or creation order.
 */
function limitSessions(sessions: SessionInfo[], maxCount: number): SessionInfo[] {
  if (sessions.length <= maxCount) return sessions;
  // Sort by lastStatusChange descending (most recent first), keep newest
  const sorted = [...sessions].sort((a, b) => {
    const aTime = a.lastStatusChange ? new Date(a.lastStatusChange).getTime() : 0;
    const bTime = b.lastStatusChange ? new Date(b.lastStatusChange).getTime() : 0;
    return bTime - aTime;
  });
  return sorted.slice(0, maxCount);
}

export function SessionPollingProvider({ children }: { children: ReactNode }) {
  const [machines, setMachinesState] = useState<Machine[]>([]);
  const [sessionsByMachine, setSessionsByMachine] = useState<Map<string, MachineSessionData>>(
    new Map()
  );
  const [archivedByMachine, setArchivedByMachine] = useState<Map<string, ArchivedSessionData>>(
    new Map()
  );
  const [loadingMachines, setLoadingMachines] = useState<Set<string>>(new Set());
  // Per-machine task lists (per-project todo items), kept in sync via the
  // /sessions WS channel (tasks-list / task-created / task-updated / task-removed).
  const [tasksByMachine, setTasksByMachine] = useState<Map<string, WSTaskInfo[]>>(new Map());
  // Per-machine git status (project → repoPath → GitRepoStatus), pushed via git-status WS messages.
  const [gitStatusByMachine, setGitStatusByMachine] = useState<
    Map<string, Map<string, Map<string, GitRepoStatus>>>
  >(new Map());

  const wsConnectionsRef = useRef<Map<string, WebSocket>>(new Map());
  const wsConnectedRef = useRef<Set<string>>(new Set()); // Track connected machines via ref for polling
  const wsReconnectDelaysRef = useRef<Map<string, number>>(new Map());
  const wsReconnectTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const activeReconnectionsRef = useRef<Set<string>>(new Set()); // Track machines currently reconnecting
  const wsHasOpenedRef = useRef<Set<string>>(new Set()); // Track machines where WS successfully opened
  const onNeedsAttentionRef = useRef<((sessionName: string) => void) | undefined>(undefined);

  // Current dashboard user identity for per-user session view isolation,
  // threaded to the agent on every /sessions WS + /api/sessions request.
  // Read once from the auth session; kept in a ref so the stable fetch/connect
  // callbacks always see the latest value without re-subscribing.
  const { getSession: getAuthSession } = useAuth();
  const viewerRef = useRef<{ ownerId: string | null; isOwner: boolean }>({
    ownerId: null,
    isOwner: false,
  });

  useEffect(() => {
    let cancelled = false;
    getAuthSession().then((session) => {
      if (cancelled) return;
      viewerRef.current = {
        ownerId: session.data.user?.id ?? null,
        isOwner: session.isOwner,
      };
    });
    return () => {
      cancelled = true;
    };
  }, [getAuthSession]);

  const setOnNeedsAttention = useCallback(
    (callback: ((sessionName: string) => void) | undefined) => {
      onNeedsAttentionRef.current = callback;
    },
    []
  );

  // Request notification permission on mount
  useEffect(() => {
    requestNotificationPermission();
  }, []);

  // Cleanup all timeouts on unmount
  useEffect(() => {
    return () => {
      // Clear any pending reconnect timeouts
      for (const timeout of wsReconnectTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      wsReconnectTimeoutsRef.current.clear();
    };
  }, []);

  // NOTE: Machines are now managed by the parent component (from localStorage)
  // We no longer fetch from /api/machines - the dashboard is stateless!

  const fetchSessionsForMachine = useCallback(
    async (machine: Machine): Promise<MachineSessionData> => {
      const agentUrl = machine.config?.agentUrl || 'localhost:4678';

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      // Check WS connected via ref (always current)
      const isWsConnected = wsConnectedRef.current.has(machine.id);

      try {
        const qs = viewerParams(viewerRef.current);
        const response = await fetch(
          buildApiUrl(agentUrl, `/api/sessions${qs ? `?${qs}` : ''}`),
          {
            signal: controller.signal,
          }
        );

        if (!response.ok) throw new Error('Failed to fetch sessions');

        const sessions: SessionInfo[] = await response.json();

        return {
          machineId: machine.id,
          machineName: machine.name,
          agentUrl,
          sessions: limitSessions(sessions, MAX_SESSIONS_PER_MACHINE),
          lastFetch: Date.now(),
          error: null,
          wsConnected: isWsConnected,
        };
      } catch (err) {
        const errorMsg =
          (err as Error).name === 'AbortError'
            ? 'Agent not responding'
            : 'Could not connect to agent';

        return {
          machineId: machine.id,
          machineName: machine.name,
          agentUrl,
          sessions: [],
          lastFetch: Date.now(),
          error: errorMsg,
          wsConnected: isWsConnected,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    []
  );

  // Remove a session from WebSocket
  const removeSession = useCallback((machineId: string, sessionName: string) => {
    setSessionsByMachine((prev) => {
      const next = new Map(prev);
      const existingData = next.get(machineId);

      if (existingData) {
        next.set(machineId, {
          ...existingData,
          sessions: existingData.sessions.filter((s) => s.name !== sessionName),
          lastFetch: Date.now(),
        });
      }

      return next;
    });
  }, []);

  // ── Task state helpers ──────────────────────────────────────────────────
  // Replace the whole task list for a machine (from tasks-list / REST refresh).
  const setTasksList = useCallback((machineId: string, tasks: WSTaskInfo[]) => {
    setTasksByMachine((prev) => {
      const next = new Map(prev);
      next.set(machineId, tasks);
      return next;
    });
  }, []);

  // Insert or replace a single task (from task-created / task-updated).
  const upsertTask = useCallback((machineId: string, task: WSTaskInfo) => {
    setTasksByMachine((prev) => {
      const next = new Map(prev);
      const existing = next.get(machineId) ?? [];
      const idx = existing.findIndex((t) => t.id === task.id);
      const updated =
        idx === -1 ? [...existing, task] : existing.map((t) => (t.id === task.id ? task : t));
      next.set(machineId, updated);
      return next;
    });
  }, []);

  // Drop a single task (from task-removed).
  const removeTask = useCallback((machineId: string, taskId: string) => {
    setTasksByMachine((prev) => {
      const next = new Map(prev);
      const existing = next.get(machineId);
      if (existing) {
        next.set(
          machineId,
          existing.filter((t) => t.id !== taskId)
        );
      }
      return next;
    });
  }, []);

  // Upsert git status for a repo (from git-status WS message).
  const upsertGitStatus = useCallback(
    (machineId: string, project: string, repoPath: string, status: GitRepoStatus) => {
      setGitStatusByMachine((prev) => {
        const next = new Map(prev);
        const machineMap = new Map(next.get(machineId) ?? new Map());
        const projectMap = new Map(machineMap.get(project) ?? new Map());
        projectMap.set(repoPath, status);
        machineMap.set(project, projectMap);
        next.set(machineId, machineMap);
        return next;
      });
    },
    []
  );

  // Archive a session (move from active to archived)
  const archiveSession = useCallback(
    (machineId: string, machineName: string, agentUrl: string, session: SessionInfo) => {
      // Remove from active sessions
      setSessionsByMachine((prev) => {
        const next = new Map(prev);
        const existingData = next.get(machineId);

        if (existingData) {
          next.set(machineId, {
            ...existingData,
            sessions: existingData.sessions.filter((s) => s.name !== session.name),
            lastFetch: Date.now(),
          });
        }

        return next;
      });

      // Add to archived sessions
      setArchivedByMachine((prev) => {
        const next = new Map(prev);
        const existingData = next.get(machineId);

        if (existingData) {
          // Add to existing archived list (avoid duplicates)
          const alreadyExists = existingData.sessions.some((s) => s.name === session.name);
          if (!alreadyExists) {
            const newSessions = [session, ...existingData.sessions];
            next.set(machineId, {
              ...existingData,
              sessions: limitSessions(newSessions, MAX_ARCHIVED_PER_MACHINE),
            });
          }
        } else {
          next.set(machineId, {
            machineId,
            machineName,
            agentUrl,
            sessions: [session],
          });
        }

        return next;
      });
    },
    []
  );

  // Fetch archived sessions for a machine
  const fetchArchivedSessions = useCallback(async (machine: Machine): Promise<void> => {
    const agentUrl = machine.config?.agentUrl || 'localhost:4678';

    try {
      const qs = viewerParams(viewerRef.current);
      const response = await fetch(
        buildApiUrl(agentUrl, `/api/sessions/archived${qs ? `?${qs}` : ''}`)
      );
      if (!response.ok) return;

      const sessions: SessionInfo[] = await response.json();

      setArchivedByMachine((prev) => {
        const next = new Map(prev);
        next.set(machine.id, {
          machineId: machine.id,
          machineName: machine.name,
          agentUrl,
          sessions: limitSessions(sessions, MAX_ARCHIVED_PER_MACHINE),
        });
        return next;
      });
    } catch (err) {
      archivedLogger.error('Failed to fetch archived sessions', err);
    }
  }, []);

  // Connect WebSocket for a machine
  const connectWebSocket = useCallback(
    (machine: Machine) => {
      const agentUrl = machine.config?.agentUrl || 'localhost:4678';
      // Include app version in WebSocket URL for auto-update detection
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0';
      // Append per-user view-isolation identity so the agent filters the
      // session list (and live broadcasts) to the current dashboard user.
      const vqs = viewerParams(viewerRef.current);
      const wsUrl = buildWebSocketUrl(
        agentUrl,
        `/sessions?v=${encodeURIComponent(appVersion)}${vqs ? `&${vqs}` : ''}`
      );

      // Close existing connection if any
      const existingWs = wsConnectionsRef.current.get(machine.id);
      if (existingWs) {
        existingWs.close();
        wsConnectionsRef.current.delete(machine.id);
      }

      wsLogger.info(`Connecting to ${wsUrl} for machine ${machine.name}`);

      try {
        // Reset hasOpened flag for this connection attempt (critical for handshake-reject detection)
        wsHasOpenedRef.current.delete(machine.id);

        const ws = openAgentWebSocket(wsUrl, machine.config?.token);
        wsConnectionsRef.current.set(machine.id, ws);

        ws.onopen = () => {
          wsLogger.info(`Connected to ${machine.name}`);
          wsHasOpenedRef.current.add(machine.id); // Mark that this connection successfully opened
          wsReconnectDelaysRef.current.set(machine.id, WS_RECONNECT_BASE_DELAY);
          wsConnectedRef.current.add(machine.id); // Track via ref for polling

          setSessionsByMachine((prev) => {
            const next = new Map(prev);
            const existingData = next.get(machine.id);
            if (existingData) {
              next.set(machine.id, { ...existingData, wsConnected: true, error: null });
            } else {
              next.set(machine.id, {
                machineId: machine.id,
                machineName: machine.name,
                agentUrl,
                sessions: [],
                lastFetch: Date.now(),
                error: null,
                wsConnected: true,
              });
            }
            return next;
          });
        };

        ws.onmessage = (event) => {
          try {
            const msg: WSSessionsMessageFromAgent = JSON.parse(event.data);

            switch (msg.type) {
              case 'sessions-list':
                wsLogger.info(`Received sessions-list: ${msg.sessions.length} sessions`);
                setSessionsByMachine((prev) => {
                  const next = new Map(prev);
                  next.set(machine.id, {
                    machineId: machine.id,
                    machineName: machine.name,
                    agentUrl,
                    sessions: limitSessions(msg.sessions, MAX_SESSIONS_PER_MACHINE),
                    lastFetch: Date.now(),
                    error: null,
                    wsConnected: true,
                  });
                  return next;
                });
                break;

              case 'session-removed':
                wsLogger.info(`Session removed: ${msg.sessionName}`);
                removeSession(machine.id, msg.sessionName);
                break;

              case 'session-archived':
                wsLogger.info(`Session archived: ${msg.sessionName}`);
                archiveSession(machine.id, machine.name, agentUrl, msg.session);
                break;

              case 'version-info':
                wsLogger.info(`Agent version: ${msg.agentVersion}`);
                break;

              case 'update-pending':
                wsLogger.info(`Agent updating to ${msg.targetVersion}: ${msg.message}`);
                // Agent will restart, WebSocket will reconnect automatically
                break;

              case 'tasks-list':
                wsLogger.info(`Received tasks-list: ${msg.tasks.length} tasks`);
                setTasksList(machine.id, msg.tasks);
                break;

              case 'task-created':
              case 'task-updated':
                upsertTask(machine.id, msg.task);
                break;

              case 'task-removed':
                removeTask(machine.id, msg.taskId);
                break;

              case 'status-update':
                wsLogger.info(`Status update: ${msg.session.name} -> ${msg.session.status}`);
                setSessionsByMachine((prev) => {
                  const next = new Map(prev);
                  const existingData = next.get(machine.id);
                  if (existingData) {
                    const sessionIndex = existingData.sessions.findIndex(
                      (s) => s.name === msg.session.name
                    );
                    if (sessionIndex !== -1) {
                      const previousStatus = existingData.sessions[sessionIndex].status;
                      const updatedSessions = [...existingData.sessions];
                      updatedSessions[sessionIndex] = {
                        ...updatedSessions[sessionIndex],
                        status: msg.session.status,
                        attentionReason: msg.session.attentionReason,
                        statusSource: msg.session.statusSource,
                        lastStatusChange: msg.session.lastStatusChange,
                      };
                      next.set(machine.id, { ...existingData, sessions: updatedSessions });

                      // Trigger callback when status changes TO needs_attention
                      if (
                        msg.session.status === 'needs_attention' &&
                        previousStatus !== 'needs_attention'
                      ) {
                        onNeedsAttentionRef.current?.(msg.session.name);
                      }
                    }
                  }
                  return next;
                });
                break;

              case 'git-status':
                wsLogger.debug(`Git status: ${msg.project}/${msg.repoPath}`);
                upsertGitStatus(machine.id, msg.project, msg.repoPath, msg.status);
                break;
            }
          } catch (err) {
            wsLogger.error('Failed to parse message', err);
          }
        };

        ws.onclose = (event) => {
          wsLogger.info(`Disconnected from ${machine.name}`, {
            code: event.code,
            reason: event.reason,
          });
          wsConnectionsRef.current.delete(machine.id);
          wsConnectedRef.current.delete(machine.id); // Remove from ref

          setSessionsByMachine((prev) => {
            const next = new Map(prev);
            const existingData = next.get(machine.id);
            if (existingData) {
              next.set(machine.id, { ...existingData, wsConnected: false });
            }
            return next;
          });

          // If connection never opened, this is a handshake rejection (e.g., 401)
          // Don't retry - the agent rejected the connection
          if (!wsHasOpenedRef.current.has(machine.id)) {
            wsLogger.warn(`Connection rejected by ${machine.name} (never opened), skipping reconnection`);
            setSessionsByMachine((prev) => {
              const next = new Map(prev);
              const existingData = next.get(machine.id);
              if (existingData) {
                next.set(machine.id, {
                  ...existingData,
                  wsConnected: false,
                  error: 'Connection rejected by agent (authentication or configuration error)'
                });
              }
              return next;
            });
            return;
          }

          // Schedule reconnection with exponential backoff
          // Limit concurrent reconnections to prevent resource exhaustion
          const currentDelay =
            wsReconnectDelaysRef.current.get(machine.id) || WS_RECONNECT_BASE_DELAY;
          const nextDelay = Math.min(currentDelay * 2, WS_RECONNECT_MAX_DELAY);
          wsReconnectDelaysRef.current.set(machine.id, nextDelay);

          // Add extra delay if too many concurrent reconnections
          const concurrentCount = activeReconnectionsRef.current.size;
          const effectiveDelay =
            concurrentCount >= MAX_CONCURRENT_RECONNECTIONS
              ? currentDelay + concurrentCount * 1000 // Stagger reconnections
              : currentDelay;

          wsLogger.info(`Reconnecting to ${machine.name} in ${effectiveDelay}ms`, {
            concurrentCount,
          });

          activeReconnectionsRef.current.add(machine.id);

          const timeout = setTimeout(() => {
            activeReconnectionsRef.current.delete(machine.id);
            // Only reconnect if machine is still online
            const currentMachine = machines.find((m) => m.id === machine.id);
            if (currentMachine?.status === 'online') {
              connectWebSocket(currentMachine);
            }
          }, effectiveDelay);

          wsReconnectTimeoutsRef.current.set(machine.id, timeout);
        };

        ws.onerror = () => {
          wsLogger.error(`Error for ${machine.name}`);
        };
      } catch (err) {
        wsLogger.error(`Failed to create WebSocket for ${machine.name}`, err);
      }
    },
    [machines, removeSession, archiveSession, setTasksList, upsertTask, removeTask]
  );

  // Manage WebSocket connections based on online machines
  useEffect(() => {
    const onlineMachines = machines.filter((m) => m.status === 'online');

    // Connect to new online machines
    for (const machine of onlineMachines) {
      if (!wsConnectionsRef.current.has(machine.id)) {
        connectWebSocket(machine);
      }
    }

    // Close connections for offline machines
    for (const [machineId, ws] of wsConnectionsRef.current) {
      const machine = machines.find((m) => m.id === machineId);
      if (!machine || machine.status !== 'online') {
        ws.close();
        wsConnectionsRef.current.delete(machineId);

        // Clear reconnect timeout and remove from active reconnections
        const timeout = wsReconnectTimeoutsRef.current.get(machineId);
        if (timeout) {
          clearTimeout(timeout);
          wsReconnectTimeoutsRef.current.delete(machineId);
          activeReconnectionsRef.current.delete(machineId);
        }
      }
    }

    // Cleanup on unmount
    return () => {
      for (const ws of wsConnectionsRef.current.values()) {
        ws.close();
      }
      wsConnectionsRef.current.clear();

      for (const timeout of wsReconnectTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      wsReconnectTimeoutsRef.current.clear();
      activeReconnectionsRef.current.clear();
    };
  }, [machines, connectWebSocket]);

  // Fetch archived sessions when machines change
  useEffect(() => {
    const onlineMachines = machines.filter((m) => m.status === 'online');
    for (const machine of onlineMachines) {
      // Fetch archived sessions if not already loaded
      if (!archivedByMachine.has(machine.id)) {
        fetchArchivedSessions(machine);
      }
    }
  }, [machines, archivedByMachine, fetchArchivedSessions]);

  // Fallback HTTP polling (less frequent when WS is working)
  const pollAllMachines = useCallback(async () => {
    const onlineMachines = machines.filter((m) => m.status === 'online');

    if (onlineMachines.length === 0) return;

    pollingLogger.info(`HTTP polling ${onlineMachines.length} machines`);

    const results = await Promise.all(
      onlineMachines.map((machine) => fetchSessionsForMachine(machine))
    );

    setSessionsByMachine((prev) => {
      const next = new Map(prev);
      for (const result of results) {
        next.set(result.machineId, result);
      }
      return next;
    });
  }, [machines, fetchSessionsForMachine]);

  const refreshMachine = useCallback(
    async (machineId: string) => {
      const machine = machines.find((m) => m.id === machineId);
      if (!machine || machine.status !== 'online') return;

      setLoadingMachines((prev) => new Set(prev).add(machineId));

      const result = await fetchSessionsForMachine(machine);

      setSessionsByMachine((prev) => {
        const next = new Map(prev);
        next.set(result.machineId, result);
        return next;
      });

      setLoadingMachines((prev) => {
        const next = new Set(prev);
        next.delete(machineId);
        return next;
      });
    },
    [machines, fetchSessionsForMachine]
  );

  // Fallback polling interval
  useEffect(() => {
    if (machines.length === 0) return;

    pollAllMachines();
    const interval = setInterval(pollAllMachines, FALLBACK_POLLING_INTERVAL);
    return () => clearInterval(interval);
  }, [pollAllMachines, machines.length]);

  // Get all sessions across all machines, flattened with machine context
  const getAllSessions = useCallback((): SessionWithMachine[] => {
    const allSessions: SessionWithMachine[] = [];
    for (const [, data] of sessionsByMachine) {
      for (const session of data.sessions) {
        allSessions.push({
          ...session,
          machineId: data.machineId,
          machineName: data.machineName,
          agentUrl: data.agentUrl,
        });
      }
    }
    return allSessions;
  }, [sessionsByMachine]);

  // Get all archived sessions across all machines
  const getArchivedSessions = useCallback((): SessionWithMachine[] => {
    const allArchived: SessionWithMachine[] = [];
    for (const [, data] of archivedByMachine) {
      for (const session of data.sessions) {
        allArchived.push({
          ...session,
          machineId: data.machineId,
          machineName: data.machineName,
          agentUrl: data.agentUrl,
        });
      }
    }
    return allArchived;
  }, [archivedByMachine]);

  // Get a specific session by machine and name
  const getSession = useCallback(
    (machineId: string, sessionName: string): SessionInfo | null => {
      const data = sessionsByMachine.get(machineId);
      if (!data) return null;
      return data.sessions.find((s) => s.name === sessionName) || null;
    },
    [sessionsByMachine]
  );

  // Re-fetch a machine's tasks over REST. The WS push keeps tasks live, so this
  // is only a fallback (e.g. machine without an open WS, or an explicit refresh).
  const refreshTasks = useCallback(
    async (machineId: string): Promise<void> => {
      const machine = machines.find((m) => m.id === machineId);
      const agentUrl = machine?.config?.agentUrl || 'localhost:4678';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      try {
        const qs = viewerParams(viewerRef.current);
        const response = await fetch(buildApiUrl(agentUrl, `/api/tasks${qs ? `?${qs}` : ''}`), {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Failed to fetch tasks');
        const body = (await response.json()) as { tasks: WSTaskInfo[] };
        setTasksList(machineId, body.tasks ?? []);
      } catch (err) {
        pollingLogger.error('Failed to fetch tasks', err);
      } finally {
        clearTimeout(timeout);
      }
    },
    [machines, setTasksList]
  );

  // Get all tasks for a machine.
  const getTasksForMachine = useCallback(
    (machineId: string): WSTaskInfo[] => tasksByMachine.get(machineId) ?? [],
    [tasksByMachine]
  );

  // Get tasks for a single project on a machine.
  const getTasksForProject = useCallback(
    (machineId: string, project: string): WSTaskInfo[] =>
      (tasksByMachine.get(machineId) ?? []).filter((t) => t.project === project),
    [tasksByMachine]
  );

  // Get git status for a single project on a machine.
  const getGitStatusForProject = useCallback(
    (machineId: string, project: string) =>
      gitStatusByMachine.get(machineId)?.get(project) ?? new Map(),
    [gitStatusByMachine]
  );

  const value: SessionPollingContextValue = {
    sessionsByMachine,
    machines,
    getSessionsForMachine: (machineId: string) => sessionsByMachine.get(machineId)?.sessions || [],
    getAllSessions,
    getArchivedSessions,
    getSession,
    refreshMachine,
    setMachines: setMachinesState,
    isLoading: (machineId: string) => loadingMachines.has(machineId),
    getError: (machineId: string) => sessionsByMachine.get(machineId)?.error || null,
    isWsConnected: (machineId: string) => sessionsByMachine.get(machineId)?.wsConnected ?? false,
    setOnNeedsAttention,
    getTasksForMachine,
    getTasksForProject,
    refreshTasks,
    getGitStatusForProject,
  };

  return <SessionPollingContext.Provider value={value}>{children}</SessionPollingContext.Provider>;
}

export function useSessionPolling() {
  const context = useContext(SessionPollingContext);
  if (!context) {
    throw new Error('useSessionPolling must be used within SessionPollingProvider');
  }
  return context;
}

// Re-export types for convenience
export type { SessionInfo, SessionWithMachine };
