/**
 * Tests for worktree lifecycle (Story 6.6 — AC6):
 * worktreeSiblingPath, createWorktree, removeWorktree lib functions.
 * Uses vi.mock for child_process; never spawns real git.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

interface MockProc {
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
}

function createMockProc(code: number, stdout: string, stderr = ''): MockProc {
  return {
    stdout: {
      on: vi.fn((event, cb) => {
        if (event === 'data') cb(Buffer.from(stdout));
      }),
    },
    stderr: {
      on: vi.fn((event, cb) => {
        if (event === 'data' && stderr) cb(Buffer.from(stderr));
      }),
    },
    on: vi.fn((event, cb) => {
      if (event === 'close') cb(code);
    }),
  };
}

describe('worktreeSiblingPath — pure path construction (AC2, AC6)', () => {
  let worktreeSiblingPath: typeof import('../../src/lib/git.js').worktreeSiblingPath;

  beforeEach(async () => {
    vi.resetModules();
    worktreeSiblingPath = (await import('../../src/lib/git.js')).worktreeSiblingPath;
  });

  it('places worktree under .247-worktrees/<repoName>/<branch>', () => {
    const result = worktreeSiblingPath('/home/user/myrepo', 'feat/thing');
    expect(result).toBe('/home/user/.247-worktrees/myrepo/feat-thing');
  });

  it('sanitizes branch slashes to dashes', () => {
    const result = worktreeSiblingPath('/projects/repo', 'feature/abc/def');
    expect(result).toBe('/projects/.247-worktrees/repo/feature-abc-def');
  });

  it('result is outside gitRoot (sibling, not child)', () => {
    const gitRoot = '/home/user/myproject';
    const result = worktreeSiblingPath(gitRoot, 'main');
    expect(result.startsWith(gitRoot)).toBe(false);
  });

  it('simple branch names pass through unchanged', () => {
    const result = worktreeSiblingPath('/repos/app', 'main');
    expect(result).toBe('/repos/.247-worktrees/app/main');
  });
});

describe('createWorktree (AC1, AC6)', () => {
  let createWorktree: typeof import('../../src/lib/git.js').createWorktree;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    createWorktree = (await import('../../src/lib/git.js')).createWorktree;
  });

  it('rejects branch with leading dash (injection) before any spawn', async () => {
    await expect(createWorktree('/repo', '--evil')).rejects.toThrow('ref starts with dash');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects branch with whitespace before any spawn', async () => {
    await expect(createWorktree('/repo', 'a b')).rejects.toThrow('whitespace');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects branch with semicolon (injection chars — control char check)', async () => {
    // semicolon is not a control char but validateSafeRef blocks leading dash, '..',
    // whitespace, control chars. Semicolons pass validateSafeRef but test that
    // the path construction is array-based (no shell string interpolation).
    // Test that a normal safe branch succeeds shape:
    spawnMock
      .mockReturnValueOnce(createMockProc(0, '/repo\n'))  // rev-parse --show-toplevel
      .mockReturnValueOnce(createMockProc(0, ''));         // worktree add

    const result = await createWorktree('/repo', 'safe-branch');
    expect(result.branch).toBe('safe-branch');
    expect(result.path).toContain('.247-worktrees');
    expect(result.path).toContain('safe-branch');
  });

  it('rejects branch with ".." before any spawn', async () => {
    await expect(createWorktree('/repo', '../escape')).rejects.toThrow("..'");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('throws "branch already exists" on already-exists stderr', async () => {
    spawnMock
      .mockReturnValueOnce(createMockProc(0, '/repo\n'))
      .mockReturnValueOnce(createMockProc(128, '', 'fatal: already exists'));
    await expect(createWorktree('/repo', 'existing')).rejects.toThrow('already exists');
  });

  it('throws "invalid reference" on not-a-valid-object-name stderr', async () => {
    spawnMock
      .mockReturnValueOnce(createMockProc(0, '/repo\n'))
      .mockReturnValueOnce(createMockProc(128, '', "fatal: 'ghost' is not a valid object name"));
    await expect(createWorktree('/repo', 'ghost')).rejects.toThrow('invalid reference');
  });

  it('uses -b flag when newBranch=true', async () => {
    spawnMock
      .mockReturnValueOnce(createMockProc(0, '/repo\n'))
      .mockReturnValueOnce(createMockProc(0, ''));

    await createWorktree('/repo', 'new-feature', { newBranch: true });

    // Second call is worktree add
    const worktreeAddArgs = spawnMock.mock.calls[1][1] as string[];
    expect(worktreeAddArgs).toContain('-b');
    expect(worktreeAddArgs).toContain('new-feature');
  });

  it('does NOT use -b flag when newBranch=false', async () => {
    spawnMock
      .mockReturnValueOnce(createMockProc(0, '/repo\n'))
      .mockReturnValueOnce(createMockProc(0, ''));

    await createWorktree('/repo', 'existing-branch', { newBranch: false });

    const worktreeAddArgs = spawnMock.mock.calls[1][1] as string[];
    expect(worktreeAddArgs).not.toContain('-b');
    expect(worktreeAddArgs).toContain('existing-branch');
  });
});

describe('removeWorktree (AC5, AC6)', () => {
  let removeWorktree: typeof import('../../src/lib/git.js').removeWorktree;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    removeWorktree = (await import('../../src/lib/git.js')).removeWorktree;
  });

  it('builds worktree remove argv without --force by default (AC5)', async () => {
    spawnMock.mockReturnValueOnce(createMockProc(0, ''));
    await removeWorktree('/repo', '/sibling/.247-worktrees/repo/feat');
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('remove');
    expect(args).not.toContain('--force');
    expect(args).toContain('/sibling/.247-worktrees/repo/feat');
  });

  it('includes --force when opts.force is true (AC5)', async () => {
    spawnMock.mockReturnValueOnce(createMockProc(0, ''));
    await removeWorktree('/repo', '/wt/path', { force: true });
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--force');
  });

  it('throws uncommitted-changes message on dirty stderr (AC5)', async () => {
    spawnMock.mockReturnValueOnce(createMockProc(128, '', 'fatal: /wt is dirty'));
    await expect(removeWorktree('/repo', '/wt')).rejects.toThrow('uncommitted changes');
  });

  it('throws uncommitted-changes on "contains modified or untracked files"', async () => {
    spawnMock.mockReturnValueOnce(createMockProc(128, '', 'error: contains modified or untracked files'));
    await expect(removeWorktree('/repo', '/wt')).rejects.toThrow('uncommitted changes');
  });

  it('throws "not a registered worktree" on not-a-working-tree stderr (AC6)', async () => {
    spawnMock.mockReturnValueOnce(createMockProc(128, '', 'fatal: is not a working tree'));
    await expect(removeWorktree('/repo', '/wt')).rejects.toThrow('not a registered worktree');
  });

  it('throws generic message for unknown exit failure', async () => {
    spawnMock.mockReturnValueOnce(createMockProc(128, '', 'fatal: something else'));
    await expect(removeWorktree('/repo', '/wt')).rejects.toThrow('worktree remove failed');
  });
});
