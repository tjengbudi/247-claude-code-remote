/**
 * Session API routes: list, preview, kill, archive tmux sessions.
 * Simplified version without spawn, worktree, push, or PR features.
 */

import { Router } from 'express';
import type { Request } from 'express';
import type { WSSessionInfo } from '247-shared';
import * as sessionsDb from '../db/sessions.js';
import type { ViewerContext } from '../db/sessions.js';
import {
  broadcastSessionRemoved,
  broadcastSessionArchived,
  broadcastStatusUpdate,
} from '../websocket-handlers.js';

/** Max stored length for a session description (chars). Longer input is truncated. */
const MAX_DESCRIPTION_LENGTH = 200;

/**
 * Parse the viewer identity (owner / isOwner) the web client appends to agent
 * HTTP requests as query params, for per-user view isolation.
 */
function parseViewer(req: Request): ViewerContext {
  const ownerRaw = req.query.owner;
  const ownerId = typeof ownerRaw === 'string' && ownerRaw ? ownerRaw : null;
  const isOwner = req.query.isOwner === '1';
  return { ownerId, isOwner };
}

export function createSessionRoutes(): Router {
  const router = Router();

  // Get session output (terminal scrollback)
  router.get('/:sessionName/output', async (req, res) => {
    const { sessionName } = req.params;
    const lines = parseInt(req.query.lines as string) || 1000;
    const format = (req.query.format as string) || 'plain';
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    // Limit lines to prevent memory issues
    const maxLines = Math.min(lines, 50000);

    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t "${sessionName}" -p -S -${maxLines} -J 2>/dev/null`
      );

      let output = stdout;

      // Strip ANSI codes if plain format requested
      if (format === 'plain') {
        // eslint-disable-next-line no-control-regex
        output = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      }

      const outputLines = output.split('\n');

      // Check if session is still running
      let isRunning = true;
      try {
        await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
      } catch {
        isRunning = false;
      }

      res.json({
        sessionName,
        output,
        totalLines: outputLines.length,
        returnedLines: outputLines.length,
        isRunning,
        capturedAt: Date.now(),
        source: 'live' as const,
      });
    } catch {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // Send input to a session
  router.post('/:sessionName/input', async (req, res) => {
    const { sessionName } = req.params;
    const { text, sendEnter = true } = req.body as {
      text: string;
      sendEnter?: boolean;
    };
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ success: false, error: 'Invalid session name' });
    }

    if (!text || typeof text !== 'string') {
      return res.status(400).json({ success: false, error: 'Text is required' });
    }

    try {
      // Check if session exists
      await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);

      // Escape special characters for tmux send-keys
      const escapedText = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/;/g, '\\;');

      // Send the text
      if (sendEnter) {
        await execAsync(`tmux send-keys -t "${sessionName}" "${escapedText}" Enter`);
      } else {
        await execAsync(`tmux send-keys -t "${sessionName}" "${escapedText}"`);
      }

      // Update last activity
      sessionsDb.upsertSession(sessionName, {
        lastEvent: 'Input sent',
      });

      res.json({
        success: true,
        sessionName,
        bytesSent: text.length,
      });
    } catch {
      res.status(404).json({ success: false, error: 'Session not found' });
    }
  });

  // Enhanced sessions endpoint with detailed info
  router.get('/', async (req, res) => {
    const viewer = parseViewer(req);
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const { stdout } = await execAsync(
        'tmux list-sessions -F "#{session_name}|#{session_created}" 2>/dev/null'
      );

      const sessions: WSSessionInfo[] = [];

      for (const line of stdout.trim().split('\n').filter(Boolean)) {
        const [name, created] = line.split('|');
        const [project] = name.split('--');

        // Get DB data if available
        const dbSession = sessionsDb.getSession(name);

        // View isolation: skip sessions this viewer may not see (untagged
        // tmux-only sessions are owner-only).
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
          description: dbSession?.description ?? undefined,
        });
      }

      res.json(sessions);
    } catch {
      res.json([]);
    }
  });

  // Get archived sessions
  router.get('/archived', (req, res) => {
    const viewer = parseViewer(req);
    const archivedSessions = sessionsDb
      .getArchivedSessions()
      .filter((session) => sessionsDb.isSessionVisible(session, viewer));

    const sessions: WSSessionInfo[] = archivedSessions.map((session) => ({
      name: session.name,
      project: session.project,
      createdAt: session.created_at,
      lastEvent: session.last_event ?? undefined,
      archivedAt: session.archived_at ?? undefined,
      description: session.description ?? undefined,
    }));

    res.json(sessions);
  });

  // Get single session info by name
  router.get('/:sessionName/status', (req, res) => {
    const { sessionName } = req.params;

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    const dbSession = sessionsDb.getSession(sessionName);

    if (!dbSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const sessionInfo: WSSessionInfo = {
      name: sessionName,
      project: dbSession.project,
      createdAt: dbSession.created_at,
      lastEvent: dbSession.last_event ?? undefined,
      lastActivity: dbSession.last_activity,
      archivedAt: dbSession.archived_at ?? undefined,
      status: dbSession.status ?? undefined,
      statusSource: dbSession.status_source ?? undefined,
      attentionReason: dbSession.attention_reason ?? undefined,
      lastStatusChange: dbSession.last_status_change ?? undefined,
      description: dbSession.description ?? undefined,
    };

    res.json(sessionInfo);
  });

  // Set or clear a session's human-readable description
  router.patch('/:sessionName', async (req, res) => {
    const { sessionName } = req.params;

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    // View isolation: don't let a user edit a session they can't see.
    const viewer = parseViewer(req);
    let existing = sessionsDb.getSession(sessionName);

    // Session visible in the UI (from tmux) but not yet in DB — auto-register
    // it now so description can be saved. Tag with the requesting viewer's
    // identity so ownership is consistent with how web-created sessions work.
    if (!existing) {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      try {
        await execAsync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
        const [project] = sessionName.split('--');
        existing = sessionsDb.upsertSession(sessionName, {
          project,
          ownerId: viewer.ownerId,
        });
      } catch {
        return res.status(404).json({ error: 'Session not found' });
      }
    }

    if (!sessionsDb.isSessionVisible(existing, viewer)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const rawDescription = (req.body as { description?: unknown }).description;
    if (rawDescription !== null && typeof rawDescription !== 'string') {
      return res.status(400).json({ error: 'description must be a string or null' });
    }

    // Normalize: trim, cap length, empty string → null (clears the label).
    let description: string | null = null;
    if (typeof rawDescription === 'string') {
      const trimmed = rawDescription.trim().slice(0, MAX_DESCRIPTION_LENGTH);
      description = trimmed.length > 0 ? trimmed : null;
    }

    const updated = sessionsDb.setSessionDescription(sessionName, description);
    if (!updated) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Broadcast so connected dashboards live-refresh the list.
    broadcastStatusUpdate({
      name: updated.name,
      project: updated.project,
      createdAt: updated.created_at,
      lastActivity: updated.last_activity,
      lastEvent: updated.last_event ?? undefined,
      status: updated.status ?? undefined,
      statusSource: updated.status_source ?? undefined,
      attentionReason: updated.attention_reason ?? undefined,
      lastStatusChange: updated.last_status_change ?? undefined,
      description: updated.description ?? undefined,
    });

    res.json({ success: true, description: updated.description });
  });

  // Acknowledge session - reset needs_attention status
  router.post('/:sessionName/acknowledge', (req, res) => {
    const { sessionName } = req.params;

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    const session = sessionsDb.getSession(sessionName);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Only reset if currently needs_attention
    if (session.status === 'needs_attention') {
      const updatedSession = sessionsDb.upsertSession(sessionName, {
        status: 'working',
        attentionReason: null,
      });

      // Broadcast status change to all WebSocket clients
      broadcastStatusUpdate({
        name: sessionName,
        project: updatedSession.project,
        status: 'working',
        attentionReason: undefined,
        statusSource: 'hook',
        createdAt: updatedSession.created_at,
        lastActivity: updatedSession.last_activity,
      });
    }

    res.json({ success: true });
  });

  // Get terminal preview (last N lines from tmux pane)
  router.get('/:sessionName/preview', async (req, res) => {
    const { sessionName } = req.params;
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t "${sessionName}" -p -S -20 2>/dev/null`
      );

      const allLines = stdout.split('\n');
      const lines = allLines
        .slice(-16, -1)
        .filter((line) => line.trim() !== '' || allLines.indexOf(line) > allLines.length - 5);

      res.json({
        lines: lines.length > 0 ? lines : ['(empty terminal)'],
        timestamp: Date.now(),
      });
    } catch {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  // Kill a tmux session
  router.delete('/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    // View isolation: don't let a user kill a session they can't see.
    const viewer = parseViewer(req);
    const target = sessionsDb.getSession(sessionName);
    if (target && !sessionsDb.isSessionVisible(target, viewer)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    // Capture owner before deleting so the removal broadcast can reach the
    // owning viewer (the DB row is gone after deleteSession).
    const ownerId = target?.owner_id ?? null;

    try {
      await execAsync(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
      console.log(`Killed tmux session: ${sessionName}`);

      sessionsDb.deleteSession(sessionName);
      broadcastSessionRemoved(sessionName, ownerId);

      res.json({ success: true, message: `Session ${sessionName} killed` });
    } catch {
      res.status(404).json({ error: 'Session not found or already killed' });
    }
  });

  // Archive a session (mark as done and keep in history)
  router.post('/:sessionName/archive', async (req, res) => {
    const { sessionName } = req.params;
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    if (!/^[\w\s-]+$/.test(sessionName)) {
      return res.status(400).json({ error: 'Invalid session name' });
    }

    // View isolation: don't let a user archive a session they can't see.
    const viewer = parseViewer(req);
    const existing = sessionsDb.getSession(sessionName);
    if (existing && !sessionsDb.isSessionVisible(existing, viewer)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const archivedSession = sessionsDb.archiveSession(sessionName);
    if (!archivedSession) {
      return res.status(404).json({ error: 'Session not found' });
    }

    try {
      await execAsync(`tmux kill-session -t "${sessionName}" 2>/dev/null`);
      console.log(`[Archive] Killed tmux session: ${sessionName}`);
    } catch {
      console.log(`[Archive] Tmux session ${sessionName} was already gone`);
    }

    const archivedInfo: WSSessionInfo = {
      name: sessionName,
      project: archivedSession.project,
      createdAt: archivedSession.created_at,
      lastEvent: archivedSession.last_event ?? undefined,
      archivedAt: archivedSession.archived_at ?? undefined,
    };

    broadcastSessionArchived(sessionName, archivedInfo);

    res.json({
      success: true,
      message: `Session ${sessionName} archived`,
      session: archivedInfo,
    });
  });

  return router;
}
