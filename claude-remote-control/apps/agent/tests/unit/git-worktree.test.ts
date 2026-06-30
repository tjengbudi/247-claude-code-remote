/**
 * Tests for classifyCwd and validateWorkingDir (Epic 6, Story 6.5)
 * Isolated from git.test.ts because vi.mock('node:fs/promises') must be file-level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(),
    access: vi.fn().mockResolvedValue(undefined),
  };
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

describe('classifyCwd — worktree vs subfolder vs root', () => {
  let classifyCwd: typeof import('../../src/lib/git.js').classifyCwd;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    classifyCwd = (await import('../../src/lib/git.js')).classifyCwd;
  });

  it('classifies path as worktree when .git is a file', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.stat).mockResolvedValue({ isFile: () => true } as import('node:fs').Stats);

    let callCount = 0;
    spawnMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return createMockProc(0, 'true');
      if (callCount === 2) return createMockProc(0, '/home/user/project');
      return createMockProc(0, 'feature-x');
    });

    const result = await classifyCwd('/home/user/project-wt');
    expect(result.kind).toBe('worktree');
    expect(result.branch).toBe('feature-x');
    expect(result.boundPath).toBeNull();
  });

  it('classifies path as root when .git is a directory and path equals toplevel', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.stat).mockResolvedValue({ isFile: () => false } as import('node:fs').Stats);

    let callCount = 0;
    spawnMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return createMockProc(0, 'true');
      return createMockProc(0, '/home/user/project');
    });

    const result = await classifyCwd('/home/user/project');
    expect(result.kind).toBe('root');
    expect(result.boundPath).toBeNull();
  });

  it('classifies path as subfolder when .git is a directory and path differs from toplevel', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.stat).mockResolvedValue({ isFile: () => false } as import('node:fs').Stats);

    let callCount = 0;
    spawnMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return createMockProc(0, 'true');
      return createMockProc(0, '/home/user/project');
    });

    const result = await classifyCwd('/home/user/project/packages/api');
    expect(result.kind).toBe('subfolder');
    expect(result.boundPath).toBeNull();
  });

  it('returns kind=root when not inside a git work tree', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.stat).mockRejectedValue(new Error('ENOENT'));

    spawnMock.mockReturnValue(createMockProc(1, '', 'not a git repo'));

    const result = await classifyCwd('/tmp/not-a-repo');
    expect(result.kind).toBe('root');
  });
});

describe('validateWorkingDir — containment + worktree branch', () => {
  let validateWorkingDir: typeof import('../../src/lib/git.js').validateWorkingDir;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    validateWorkingDir = (await import('../../src/lib/git.js')).validateWorkingDir;
  });

  it('accepts path equal to project root', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.access).mockResolvedValue(undefined);

    const result = await validateWorkingDir('/home/user/project', '/home/user/project');
    expect(result.valid).toBe(true);
  });

  it('accepts contained subfolder', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.access).mockResolvedValue(undefined);

    const result = await validateWorkingDir('/home/user/project/packages/api', '/home/user/project');
    expect(result.valid).toBe(true);
  });

  it('rejects path with .. escape outside project root', async () => {
    const result = await validateWorkingDir('/home/user/project/../../../etc', '/home/user/project');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('outside the project root');
  });

  it('accepts sibling path registered as worktree', async () => {
    const porcelain = 'worktree /home/user/project\nHEAD abc\nbranch refs/heads/main\n\nworktree /home/user/project-wt\nHEAD def\nbranch refs/heads/feature-x';
    spawnMock.mockReturnValue(createMockProc(0, porcelain));

    const result = await validateWorkingDir('/home/user/project-wt', '/home/user/project');
    expect(result.valid).toBe(true);
  });

  it('rejects path outside project root that is not a registered worktree', async () => {
    const porcelain = 'worktree /home/user/project\nHEAD abc\nbranch refs/heads/main';
    spawnMock.mockReturnValue(createMockProc(0, porcelain));

    const result = await validateWorkingDir('/home/user/other-project', '/home/user/project');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('outside the project root');
  });

  it('rejects contained path that does not exist', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.access).mockRejectedValue(new Error('ENOENT'));

    const result = await validateWorkingDir('/home/user/project/nonexistent', '/home/user/project');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('does not exist');
  });

  it('fails closed when listWorktrees throws (git unavailable)', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'git: command not found'));

    const result = await validateWorkingDir('/home/user/other', '/home/user/project');
    expect(result.valid).toBe(false);
  });
});

describe('classifyCwd — worktree vs subfolder disambiguation from same root', () => {
  let classifyCwd: typeof import('../../src/lib/git.js').classifyCwd;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    classifyCwd = (await import('../../src/lib/git.js')).classifyCwd;
  });

  // Verify that from the same parent directory, a registered linked worktree and a
  // plain subfolder are correctly distinguished (AC5 disambiguation requirement).

  it('classifies sibling linked worktree (has .git file) as kind=worktree', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.stat).mockResolvedValue({ isFile: () => true } as import('node:fs').Stats);

    let callCount = 0;
    spawnMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return createMockProc(0, 'true'); // rev-parse --is-inside-work-tree
      if (callCount === 2) return createMockProc(0, '/home/user/project-wt'); // rev-parse --show-toplevel
      return createMockProc(0, 'feat/linked'); // rev-parse --abbrev-ref HEAD
    });

    const worktreeResult = await classifyCwd('/home/user/project-wt');
    expect(worktreeResult.kind).toBe('worktree');
    expect(worktreeResult.branch).toBe('feat/linked');
  });

  it('classifies subfolder inside main working tree (has .git dir) as kind=subfolder', async () => {
    const fsMod = await import('node:fs/promises');
    vi.mocked(fsMod.stat).mockResolvedValue({ isFile: () => false } as import('node:fs').Stats);

    let callCount = 0;
    spawnMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return createMockProc(0, 'true'); // rev-parse --is-inside-work-tree
      return createMockProc(0, '/home/user/project'); // rev-parse --show-toplevel
    });

    const subfolderResult = await classifyCwd('/home/user/project/packages/api');
    expect(subfolderResult.kind).toBe('subfolder');
  });
});
