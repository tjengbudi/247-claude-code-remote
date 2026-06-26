/**
 * WebSocket handlers for terminal connections and sessions subscriptions.
 * Simplified version without status tracking, worktree or execution manager features.
 */

import { WebSocket } from 'ws';
import { execSync } from 'child_process';
import { createTerminal } from './terminal.js';
import { config } from './config.js';
import * as sessionsDb from './db/sessions.js';
import * as tasksDb from './db/tasks.js';
import type { ViewerContext } from './db/sessions.js';
import type {
  WSMessageToAgent,
  WSSessionInfo,
  WSSessionsMessageFromAgent,
  WSTaskInfo,
} from '247-shared';
import { getAgentVersion, needsUpdate } from './version.js';
import { triggerUpdate, isUpdateInProgress } from './updater.js';

// Connection tracking
const activeConnections = new Map<string, Set<WebSocket>>();
// Sessions subscribers, each tagged with the viewer identity parsed from the
// /sessions URL so broadcasts can be filtered per web user (view isolation).
const sessionsSubscribers = new Map<WebSocket, ViewerContext>();

/**
 * Parse the viewer identity (owner / isOwner) a web client appends to agent
 * URLs. Absent params → null owner + non-owner (a legacy client sees nothing
 * but untagged-as-owner, i.e. nothing unless it also claims owner).
 */
function parseViewerContext(url?: URL): ViewerContext {
  const ownerId = url?.searchParams.get('owner') || null;
  const isOwner = url?.searchParams.get('isOwner') === '1';
  return { ownerId, isOwner };
}

/**
 * Send a sessions-channel message only to subscribers allowed to see a session
 * with the given owner_id, based on each viewer's identity.
 *
 * `ownerId` may be passed explicitly (e.g. captured before a row is deleted);
 * otherwise it is looked up from the DB by session name.
 */
function broadcastToViewersOf(
  sessionName: string,
  payload: string,
  ownerId?: string | null
): void {
  const resolvedOwner =
    ownerId !== undefined ? ownerId : (sessionsDb.getSession(sessionName)?.owner_id ?? null);
  const ownerScope = { owner_id: resolvedOwner };

  for (const [ws, viewer] of sessionsSubscribers) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (sessionsDb.isSessionVisible(ownerScope, viewer)) {
      ws.send(payload);
    }
  }
}

// Generate unique session name
let sessionCounter = 0;
function generateSessionName(project: string): string {
  const timestamp = Date.now().toString(36);
  const counter = (sessionCounter++).toString(36);
  return `${project}--${timestamp}${counter}`;
}

/**
 * Check if a tmux session exists
 */
function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Broadcast session removed event to all subscribers
 */
export function broadcastSessionRemoved(sessionName: string, ownerId?: string | null): void {
  const message: WSSessionsMessageFromAgent = {
    type: 'session-removed',
    sessionName,
  };
  // ownerId is captured before the DB row is deleted; without it the lookup
  // would miss (row gone) and only the owner account would see the removal.
  broadcastToViewersOf(sessionName, JSON.stringify(message), ownerId);
}

/**
 * Broadcast session archived event to all subscribers
 */
export function broadcastSessionArchived(sessionName: string, session: WSSessionInfo): void {
  const message: WSSessionsMessageFromAgent = {
    type: 'session-archived',
    sessionName,
    session,
  };
  // Archived rows are kept in the DB, so owner_id is resolvable by name.
  broadcastToViewersOf(sessionName, JSON.stringify(message));
}

/**
 * Broadcast session status update to all subscribers
 * Called when a hook notifies the agent of a status change
 */
export function broadcastStatusUpdate(session: WSSessionInfo): void {
  const message: WSSessionsMessageFromAgent = {
    type: 'status-update',
    session,
  };
  console.log(
    `[Sessions WS] Broadcasting status update: session=${session.name} status=${session.status} reason=${session.attentionReason}`
  );

  broadcastToViewersOf(session.name, JSON.stringify(message));
}

/**
 * Broadcast a task create/update to the subscribers allowed to see it.
 * Reuses the session owner-scope filter (`broadcastToViewersOf`) by passing the
 * task's owner explicitly — visibility rules for tasks and sessions are identical.
 */
export function broadcastTaskUpserted(
  task: WSTaskInfo,
  ownerId: string | null,
  kind: 'created' | 'updated'
): void {
  const message: WSSessionsMessageFromAgent = {
    type: kind === 'created' ? 'task-created' : 'task-updated',
    task,
  };
  // The session name is irrelevant here; ownerId drives the filter.
  broadcastToViewersOf('', JSON.stringify(message), ownerId);
}

/**
 * Broadcast a task removal. ownerId is captured before the row is deleted so the
 * lookup doesn't miss (row gone) — same pattern as broadcastSessionRemoved.
 */
export function broadcastTaskRemoved(taskId: string, ownerId: string | null): void {
  const message: WSSessionsMessageFromAgent = {
    type: 'task-removed',
    taskId,
  };
  broadcastToViewersOf('', JSON.stringify(message), ownerId);
}

/**
 * Handle terminal WebSocket connections
 */
export function handleTerminalConnection(ws: WebSocket, url: URL): void {
  const project = url.searchParams.get('project');
  const urlSessionName = url.searchParams.get('session');
  const createFlag = url.searchParams.get('create') === 'true';
  // Web user id of whoever opened the terminal — tags new sessions for
  // per-user view isolation. Null for legacy clients / direct connections.
  const ownerId = url.searchParams.get('owner') || null;
  const sessionName = urlSessionName || generateSessionName(project || 'root');

  // Validate project (empty string is allowed for "terminal at root")
  const whitelist = config.projects.whitelist as string[];
  const hasWhitelist = whitelist && whitelist.length > 0;
  // Allow empty string for root, but reject null/undefined
  const isRootTerminal = project === '';
  const isAllowed = isRootTerminal || (hasWhitelist ? whitelist.includes(project!) : true);
  if (project === null || project === undefined || !isAllowed) {
    ws.close(1008, 'Project not allowed');
    return;
  }

  // For root terminal, use basePath directly; otherwise append project name
  const basePath = config.projects.basePath.replace('~', process.env.HOME!);
  const projectPath = isRootTerminal ? basePath : `${basePath}/${project}`;

  console.log(`New terminal connection for project: ${project}`);
  console.log(`Project path: ${projectPath}`);

  // Buffer for messages received before async setup completes
  const messageBuffer: Buffer[] = [];
  let setupComplete = false;
  let terminalRef: ReturnType<typeof createTerminal> | null = null;

  // Register message handler IMMEDIATELY (before any async code)
  ws.on('message', (data) => {
    const msgStr = data.toString();
    console.log(`[Terminal] Received message for '${sessionName}': ${msgStr.substring(0, 100)}...`);
    if (!setupComplete || !terminalRef) {
      console.log(`[Terminal] Buffering message (setup not complete)`);
      messageBuffer.push(data as Buffer);
      return;
    }
    try {
      const msg: WSMessageToAgent = JSON.parse(msgStr);
      handleTerminalMessage(msg, terminalRef, ws, sessionName, project!, projectPath);
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  });

  // Async initialization
  (async () => {
    const fs = await import('fs');
    if (!fs.existsSync(projectPath)) {
      console.error(`Path does not exist: ${projectPath}`);
      ws.close(1008, 'Project path not found');
      return;
    }

    // Check if session exists before attempting to create/connect
    const sessionExists = tmuxSessionExists(sessionName);

    // If session doesn't exist and no create flag, reject the connection
    if (!sessionExists && !createFlag) {
      console.log(
        `[Terminal] Session '${sessionName}' not found and create flag not set, rejecting connection`
      );
      ws.close(4001, 'Session not found');
      return;
    }

    // Create terminal
    let terminal;
    try {
      terminal = createTerminal(projectPath, sessionName, {});
      terminalRef = terminal;
    } catch (err) {
      console.error('Failed to create terminal:', err);
      ws.close(1011, 'Failed to create terminal');
      return;
    }

    // Track connection
    if (!activeConnections.has(sessionName)) {
      activeConnections.set(sessionName, new Set());
    }
    activeConnections.get(sessionName)!.add(ws);

    // Handle existing session reconnect
    if (terminal.isExistingSession()) {
      console.log(`Reconnecting to existing session '${sessionName}'`);
      terminal
        .captureHistory(10000)
        .then((history) => {
          if (history && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({ type: 'history', data: history, lines: history.split('\n').length })
            );
          }
        })
        .catch((err) => {
          console.error(`Failed to capture history for '${sessionName}':`, err);
        });
    } else {
      // New session - register in DB, tagged with the creating web user.
      const now = Date.now();
      try {
        sessionsDb.upsertSession(sessionName, {
          project: project!,
          lastEvent: 'SessionCreated',
          lastActivity: now,
          ownerId,
        });
      } catch (err) {
        console.error(`Failed to persist session '${sessionName}':`, err);
      }
    }

    // Forward terminal output
    terminal.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
        if (data.length > 10 && !data.startsWith('\x1b')) {
          console.log(
            `[Terminal] Sending ${data.length} bytes to client: ${data.substring(0, 100).replace(/\n/g, '\\n')}...`
          );
        }
      }
    });

    terminal.onExit(({ exitCode }: { exitCode: number }) => {
      console.log(`Terminal exited with code ${exitCode}`);
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Terminal closed');
    });

    // Process any messages that were buffered during async setup
    setupComplete = true;
    console.log(
      `[Terminal] Setup complete for '${sessionName}', processing ${messageBuffer.length} buffered messages`
    );
    if (messageBuffer.length > 0) {
      for (const bufferedData of messageBuffer) {
        try {
          const msg: WSMessageToAgent = JSON.parse(bufferedData.toString());
          console.log(`[Terminal] Processing buffered message type: ${msg.type}`);
          handleTerminalMessage(msg, terminal, ws, sessionName, project!, projectPath);
        } catch (err) {
          console.error('Failed to parse buffered message:', err);
        }
      }
      messageBuffer.length = 0;
    }

    ws.on('close', () => {
      console.log(`Client disconnected, tmux session '${sessionName}' preserved`);
      try {
        (terminal as any).removeAllListeners?.('data');
        (terminal as any).removeAllListeners?.('exit');
      } catch {
        /* ignore */
      }
      terminal.detach();

      const connections = activeConnections.get(sessionName);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) activeConnections.delete(sessionName);
      }
    });

    ws.on('error', (err) => console.error('WebSocket error:', err));
  })();
}

/**
 * Broadcast update-pending message to all sessions subscribers
 */
export function broadcastUpdatePending(targetVersion: string, message: string): void {
  const msg: WSSessionsMessageFromAgent = {
    type: 'update-pending',
    targetVersion,
    message,
  };
  const payload = JSON.stringify(msg);

  // Update-pending is agent-wide (not session data) → every subscriber.
  for (const ws of sessionsSubscribers.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Handle individual terminal messages
 */
function handleTerminalMessage(
  msg: WSMessageToAgent,
  terminal: ReturnType<typeof createTerminal>,
  ws: WebSocket,
  _sessionName: string,
  _project: string,
  _projectPath: string
): void {
  switch (msg.type) {
    case 'input':
      terminal.write(msg.data);
      break;
    case 'resize':
      terminal.resize(msg.cols, msg.rows);
      break;
    case 'start-claude':
      terminal.write('claude\r');
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
    case 'request-history':
      terminal
        .captureHistory(msg.lines || 10000)
        .then((history) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({ type: 'history', data: history, lines: history.split('\n').length })
            );
          }
        })
        .catch((err) => console.error(`Failed to capture history:`, err));
      break;
  }
}

/**
 * Handle sessions WebSocket connections (real-time session list updates)
 */
export function handleSessionsConnection(ws: WebSocket, url?: URL): void {
  const viewer = parseViewerContext(url);
  console.log(
    `[Sessions WS] New subscriber connected (owner=${viewer.ownerId ?? 'none'} isOwner=${viewer.isOwner})`
  );
  sessionsSubscribers.set(ws, viewer);

  // Extract web version from query params and check for updates
  const webVersion = url?.searchParams.get('v');
  const agentVersion = getAgentVersion();

  // Send agent version info to client
  if (ws.readyState === WebSocket.OPEN) {
    const versionMessage: WSSessionsMessageFromAgent = {
      type: 'version-info',
      agentVersion,
    };
    ws.send(JSON.stringify(versionMessage));
  }

  // Send the initial task list for this viewer (per-owner isolation applied).
  if (ws.readyState === WebSocket.OPEN) {
    try {
      const tasks = tasksDb.listTasks(viewer).map(tasksDb.taskToWire);
      const tasksMessage: WSSessionsMessageFromAgent = { type: 'tasks-list', tasks };
      ws.send(JSON.stringify(tasksMessage));
    } catch (err) {
      console.error('[Sessions WS] Failed to get initial tasks:', err);
    }
  }

  // Check if update needed (only upgrade, never downgrade)
  // Skip auto-update in cloud/Docker environments
  const isCloudAgent = process.env.CLOUD_AGENT === 'true';
  if (
    webVersion &&
    !isUpdateInProgress() &&
    !isCloudAgent &&
    needsUpdate(agentVersion, webVersion)
  ) {
    console.log(`[Update] Version mismatch detected: agent=${agentVersion} web=${webVersion}`);

    // Delay update to allow client connection to stabilize
    setTimeout(() => {
      triggerUpdate(webVersion);
    }, 2000);
  }

  // Send initial session list
  (async () => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const { stdout } = await execAsync(
        'tmux list-sessions -F "#{session_name}|#{session_created}" 2>/dev/null'
      );

      const sessions: WSSessionInfo[] = [];

      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const [name, created] = line.split('|');
        const [project] = name.split('--');

        // Get DB data if available
        const dbSession = sessionsDb.getSession(name);

        // View isolation: skip sessions this viewer may not see. A tmux session
        // with no DB row is untagged (owner_id null) → owner-only.
        if (!sessionsDb.isSessionVisible({ owner_id: dbSession?.owner_id ?? null }, viewer)) {
          continue;
        }

        sessions.push({
          name,
          project,
          createdAt: parseInt(created) * 1000,
          lastActivity: dbSession?.last_activity,
          lastEvent: dbSession?.last_event ?? undefined,
          status: dbSession?.status ?? undefined,
          statusSource: dbSession?.status_source ?? undefined,
          attentionReason: dbSession?.attention_reason ?? undefined,
          lastStatusChange: dbSession?.last_status_change ?? undefined,
        });
      }

      const message: WSSessionsMessageFromAgent = { type: 'sessions-list', sessions };
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    } catch (err) {
      console.error('[Sessions WS] Failed to get initial sessions:', err);
      if (ws.readyState === WebSocket.OPEN) {
        const message: WSSessionsMessageFromAgent = { type: 'sessions-list', sessions: [] };
        ws.send(JSON.stringify(message));
      }
    }
  })();

  ws.on('close', () => {
    sessionsSubscribers.delete(ws);
    console.log(`[Sessions WS] Subscriber disconnected (remaining: ${sessionsSubscribers.size})`);
  });

  ws.on('error', (err) => {
    console.error('[Sessions WS] Error:', err);
    sessionsSubscribers.delete(ws);
  });
}
