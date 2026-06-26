'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2, Circle, CircleDot, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TaskStatus, WSTaskInfo } from '247-shared';
import type { CreateTaskRequest, UpdateTaskRequest } from '247-shared';

// A session the user can allocate a task to (within this project).
export interface AllocatableSession {
  name: string;
  label: string;
}

interface TaskPanelProps {
  project: string;
  tasks: WSTaskInfo[];
  sessions: AllocatableSession[];
  onCreate: (input: CreateTaskRequest) => Promise<WSTaskInfo | null>;
  onUpdate: (taskId: string, input: UpdateTaskRequest) => Promise<WSTaskInfo | null>;
  onDelete: (taskId: string) => Promise<boolean>;
}

// Status cycles todo → doing → done → todo on click.
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'done',
  done: 'todo',
};

function StatusIcon({ status }: { status: TaskStatus }) {
  if (status === 'done') return <CheckCircle2 className="h-5 w-5 text-emerald-400" />;
  if (status === 'doing') return <CircleDot className="h-5 w-5 text-amber-400" />;
  return <Circle className="h-5 w-5 text-white/30" />;
}

function TaskRow({
  task,
  sessions,
  onUpdate,
  onDelete,
}: {
  task: WSTaskInfo;
  sessions: AllocatableSession[];
  onUpdate: (taskId: string, input: UpdateTaskRequest) => Promise<WSTaskInfo | null>;
  onDelete: (taskId: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);

  const cycleStatus = async () => {
    setBusy(true);
    await onUpdate(task.id, { status: NEXT_STATUS[task.status] });
    setBusy(false);
  };

  const allocate = async (value: string) => {
    setBusy(true);
    await onUpdate(task.id, { sessionName: value === '' ? null : value });
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    const ok = await onDelete(task.id);
    if (!ok) setBusy(false);
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
      <button
        onClick={cycleStatus}
        disabled={busy}
        className="flex-shrink-0 transition-transform active:scale-90 disabled:opacity-50"
        title={`Status: ${task.status} (click to advance)`}
      >
        <StatusIcon status={task.status} />
      </button>

      <span
        className={cn(
          'flex-1 break-words text-sm',
          task.status === 'done' ? 'text-white/40 line-through' : 'text-white/90'
        )}
      >
        {task.title}
      </span>

      <select
        value={task.sessionName ?? ''}
        onChange={(e) => allocate(e.target.value)}
        disabled={busy}
        className={cn(
          'max-w-[8rem] flex-shrink-0 rounded-md border border-white/10 bg-white/5',
          'px-2 py-1 text-xs text-white/70 outline-none',
          'focus:border-primary/50 disabled:opacity-50'
        )}
        title="Allocate to session"
      >
        <option value="">Unassigned</option>
        {/* Keep the current allocation visible even if the session has closed. */}
        {task.sessionName && !sessions.some((s) => s.name === task.sessionName) && (
          <option value={task.sessionName}>{task.sessionName} (closed)</option>
        )}
        {sessions.map((s) => (
          <option key={s.name} value={s.name}>
            {s.label}
          </option>
        ))}
      </select>

      <button
        onClick={remove}
        disabled={busy}
        className="flex-shrink-0 rounded-md p-1.5 text-white/30 hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
        title="Delete task"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </button>
    </div>
  );
}

/**
 * Per-project task list. Tasks belong to the project (not a session); each may
 * be allocated to one of the project's open sessions. Mutations go through the
 * agent REST API; live updates arrive via the /sessions WS and re-render `tasks`.
 */
export function TaskPanel({
  project,
  tasks,
  sessions,
  onCreate,
  onUpdate,
  onDelete,
}: TaskPanelProps) {
  const [newTitle, setNewTitle] = useState('');
  const [creating, setCreating] = useState(false);

  // Show open tasks first, completed ones sink to the bottom.
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aDone = a.status === 'done' ? 1 : 0;
      const bDone = b.status === 'done' ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      return a.sortOrder - b.sortOrder;
    });
  }, [tasks]);

  const remaining = tasks.filter((t) => t.status !== 'done').length;

  const submit = async () => {
    const title = newTitle.trim();
    if (!title || creating) return;
    setCreating(true);
    const created = await onCreate({ project, title });
    if (created) setNewTitle('');
    setCreating(false);
  };

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Header summary */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-white/90">{project}</p>
          <p className="text-xs text-white/40">
            {remaining} open · {tasks.length} total
          </p>
        </div>
      </div>

      {/* New task input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="Add a task…"
          className={cn(
            'flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2',
            'text-sm text-white/90 placeholder:text-white/30',
            'outline-none focus:border-primary/50'
          )}
        />
        <button
          onClick={submit}
          disabled={!newTitle.trim() || creating}
          className={cn(
            'flex items-center justify-center rounded-lg px-3',
            'bg-primary text-white hover:bg-primary/90 active:scale-[0.98]',
            'transition-all duration-150 disabled:opacity-40'
          )}
          title="Add task"
        >
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        </button>
      </div>

      {/* Task list */}
      <div className="flex flex-1 flex-col gap-2 overflow-auto">
        {sortedTasks.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-white/30">No tasks yet. Add one above.</p>
          </div>
        ) : (
          sortedTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              sessions={sessions}
              onUpdate={onUpdate}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}
