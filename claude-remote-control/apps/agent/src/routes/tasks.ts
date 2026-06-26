/**
 * Task API routes: per-project todo items that can be allocated to a session.
 * Mirrors the session routes' viewer-isolation pattern (owner/isOwner query
 * params) and broadcasts every mutation over the /sessions WebSocket channel.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import type { CreateTaskRequest, UpdateTaskRequest, TaskStatus } from '247-shared';
import * as tasksDb from '../db/tasks.js';
import type { ViewerContext } from '../db/sessions.js';
import { broadcastTaskUpserted, broadcastTaskRemoved } from '../websocket-handlers.js';

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

const VALID_STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];

function isValidStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && VALID_STATUSES.includes(value as TaskStatus);
}

export function createTaskRoutes(): Router {
  const router = Router();

  // List tasks (optionally filtered by ?project=), scoped to the viewer.
  router.get('/', (req, res) => {
    const viewer = parseViewer(req);
    const projectRaw = req.query.project;
    const project = typeof projectRaw === 'string' && projectRaw ? projectRaw : undefined;

    const tasks = tasksDb.listTasks(viewer, project).map(tasksDb.taskToWire);
    res.json({ tasks });
  });

  // Create a task for a project.
  router.post('/', (req, res) => {
    const viewer = parseViewer(req);
    const body = req.body as CreateTaskRequest;

    if (!body || typeof body.project !== 'string' || !body.project.trim()) {
      return res.status(400).json({ error: 'project is required' });
    }
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (body.status !== undefined && !isValidStatus(body.status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const ownerId = viewer.ownerId;
    const task = tasksDb.createTask({
      id: randomUUID(),
      project: body.project.trim(),
      title: body.title.trim(),
      status: body.status,
      sessionName: body.sessionName ?? null,
      ownerId,
    });

    const wire = tasksDb.taskToWire(task);
    broadcastTaskUpserted(wire, task.owner_id, 'created');
    res.status(201).json({ task: wire });
  });

  // Update a task (title / status / allocation / order).
  router.patch('/:id', (req, res) => {
    const viewer = parseViewer(req);
    const { id } = req.params;
    const body = (req.body ?? {}) as UpdateTaskRequest;

    const existing = tasksDb.getTask(id);
    if (!existing || !tasksDb.isTaskVisible(existing, viewer)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return res.status(400).json({ error: 'title must be a non-empty string' });
    }
    if (body.status !== undefined && !isValidStatus(body.status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const updated = tasksDb.updateTask(id, {
      title: body.title?.trim(),
      status: body.status,
      sessionName: body.sessionName,
      sortOrder: body.sortOrder,
    });
    if (!updated) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const wire = tasksDb.taskToWire(updated);
    broadcastTaskUpserted(wire, updated.owner_id, 'updated');
    res.json({ task: wire });
  });

  // Delete a task.
  router.delete('/:id', (req, res) => {
    const viewer = parseViewer(req);
    const { id } = req.params;

    const existing = tasksDb.getTask(id);
    if (!existing || !tasksDb.isTaskVisible(existing, viewer)) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Capture owner before deletion so the broadcast can still target viewers.
    const ownerId = existing.owner_id;
    tasksDb.deleteTask(id);
    broadcastTaskRemoved(id, ownerId);
    res.json({ success: true });
  });

  return router;
}
