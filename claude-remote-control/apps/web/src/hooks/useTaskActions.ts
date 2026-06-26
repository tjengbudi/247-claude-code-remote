'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { buildApiUrl } from '@/lib/utils';
import { viewerParams } from '@/contexts/SessionPollingContext';
import type { CreateTaskRequest, UpdateTaskRequest, WSTaskInfo } from '247-shared';
import type { AgentConnection } from './useAgentConnections';

export interface Viewer {
  ownerId: string | null;
  isOwner: boolean;
}

export interface UseTaskActionsReturn {
  createTask: (
    machineId: string,
    input: CreateTaskRequest
  ) => Promise<WSTaskInfo | null>;
  updateTask: (
    machineId: string,
    taskId: string,
    input: UpdateTaskRequest
  ) => Promise<WSTaskInfo | null>;
  deleteTask: (machineId: string, taskId: string) => Promise<boolean>;
}

/**
 * REST actions for per-project tasks. The agent broadcasts every mutation back
 * over the /sessions WebSocket, so callers do NOT need to update local state —
 * SessionPollingContext patches it from the broadcast. These return the server
 * row only for convenience / error handling.
 *
 * `viewer` (ownerId/isOwner) is threaded as query params so the agent applies
 * per-user view isolation and tags newly-created tasks with the right owner.
 */
export function useTaskActions(
  agentConnections: AgentConnection[],
  viewer: Viewer
): UseTaskActionsReturn {
  const findMachine = useCallback(
    (machineId: string) => agentConnections.find((c) => c.id === machineId),
    [agentConnections]
  );

  const withViewer = useCallback(
    (path: string) => {
      const qs = viewerParams(viewer);
      return `${path}${qs ? `?${qs}` : ''}`;
    },
    [viewer]
  );

  const createTask = useCallback(
    async (machineId: string, input: CreateTaskRequest): Promise<WSTaskInfo | null> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return null;
      }
      try {
        const response = await fetch(buildApiUrl(machine.url, withViewer('/api/tasks')), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          toast.error('Failed to create task');
          return null;
        }
        const body = (await response.json()) as { task: WSTaskInfo };
        return body.task;
      } catch (err) {
        console.error('Failed to create task:', err);
        toast.error('Could not connect to agent');
        return null;
      }
    },
    [findMachine, withViewer]
  );

  const updateTask = useCallback(
    async (
      machineId: string,
      taskId: string,
      input: UpdateTaskRequest
    ): Promise<WSTaskInfo | null> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return null;
      }
      try {
        const response = await fetch(
          buildApiUrl(machine.url, withViewer(`/api/tasks/${encodeURIComponent(taskId)}`)),
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          }
        );
        if (!response.ok) {
          toast.error('Failed to update task');
          return null;
        }
        const body = (await response.json()) as { task: WSTaskInfo };
        return body.task;
      } catch (err) {
        console.error('Failed to update task:', err);
        toast.error('Could not connect to agent');
        return null;
      }
    },
    [findMachine, withViewer]
  );

  const deleteTask = useCallback(
    async (machineId: string, taskId: string): Promise<boolean> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return false;
      }
      try {
        const response = await fetch(
          buildApiUrl(machine.url, withViewer(`/api/tasks/${encodeURIComponent(taskId)}`)),
          { method: 'DELETE' }
        );
        if (!response.ok) {
          toast.error('Failed to delete task');
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to delete task:', err);
        toast.error('Could not connect to agent');
        return false;
      }
    },
    [findMachine, withViewer]
  );

  return { createTask, updateTask, deleteTask };
}
