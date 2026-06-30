/**
 * Tests for git contract — safe executor + parsers (Epic 6, Story 6.1)
 *
 * Coverage:
 * - argv-safety (injection prevention)
 * - network env guards (GIT_TERMINAL_PROMPT, SSH BatchMode)
 * - parseStatusPorcelain (porcelain v2 -z fixtures)
 * - parseLog (NUL-delimited log fixtures)
 * - parseShowNumstat (binary, ordinary, rename)
 * - validateSafeRef (reject leading '-', '..', control chars, spaces)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateSafeRef } from '../../src/lib/git.js';

// ============================================================================
// Mock child_process.spawn for executor tests
// ============================================================================

vi.mock('node:child_process', () => {
  const mockSpawn = vi.fn();
  return { spawn: mockSpawn };
});

// ============================================================================
// Helper to create a mock spawn process
// ============================================================================

interface MockProc {
  stdout: { on: ReturnType<typeof vi.fn> };
  stderr: { on: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
}

function createMockProc(code: number, stdout: string, stderr = ''): MockProc {
  const proc: MockProc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  };

  proc.stdout.on.mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
    if (stdout) cb(Buffer.from(stdout, 'utf8'));
    return proc.stdout;
  });

  proc.stderr.on.mockImplementation((_event: string, cb: (chunk: Buffer) => void) => {
    if (stderr) cb(Buffer.from(stderr, 'utf8'));
    return proc.stderr;
  });

  proc.on.mockImplementation((event: string, cb: (code: number) => void) => {
    if (event === 'close') cb(code);
    return proc;
  });

  return proc;
}

// NUL separator constant — the parser splits on \x00
const NUL = '\x00';

// Helper: create commit record with NUL-delimited fields + trailing NUL
function makeCommit(fields: string[]): string {
  return fields.join(NUL) + NUL;
}

// ============================================================================
// 1. validateSafeRef tests
// ============================================================================

describe('validateSafeRef', () => {
  it('accepts normal branch names', () => {
    expect(validateSafeRef('main')).toEqual({ valid: true, normalized: 'main' });
    expect(validateSafeRef('feature/x')).toEqual({ valid: true, normalized: 'feature/x' });
    expect(validateSafeRef('v1.0.0')).toEqual({ valid: true, normalized: 'v1.0.0' });
    expect(validateSafeRef('release-2026')).toEqual({ valid: true, normalized: 'release-2026' });
  });

  it('rejects empty or non-string input', () => {
    expect(validateSafeRef('')).toEqual({ valid: false, reason: 'empty ref' });
    // @ts-expect-error testing invalid input
    expect(validateSafeRef(undefined)).toEqual({ valid: false, reason: 'empty ref' });
    // @ts-expect-error testing invalid input
    expect(validateSafeRef(null)).toEqual({ valid: false, reason: 'empty ref' });
  });

  it('rejects ref starting with dash (injection risk)', () => {
    const result = validateSafeRef('-foo');
    expect(result).toEqual({ valid: false, reason: 'ref starts with dash (injection risk)' });
  });

  it('rejects ref containing double-dot (range syntax)', () => {
    const result = validateSafeRef('main..other');
    expect(result).toEqual({ valid: false, reason: "ref contains '..' (range syntax)" });
  });

  it('rejects ref containing whitespace', () => {
    const result = validateSafeRef('feature branch');
    expect(result).toEqual({ valid: false, reason: 'ref contains whitespace' });
  });

  it('rejects ref containing control characters (leading)', () => {
    const result = validateSafeRef('\x00malicious');
    expect(result).toEqual({ valid: false, reason: 'ref contains control characters' });
  });

  it('rejects ref containing control characters (mid-string)', () => {
    expect(validateSafeRef('main\x01name')).toEqual({ valid: false, reason: 'ref contains control characters' });
    expect(validateSafeRef('branch\x00injected')).toEqual({ valid: false, reason: 'ref contains control characters' });
  });

  it('rejects refs with injection payloads', () => {
    expect(validateSafeRef('a b').valid).toBe(false);
    expect(validateSafeRef('a\tb').valid).toBe(false);
    expect(validateSafeRef('--upload-pack=evil').valid).toBe(false);
  });
});

// ============================================================================
// 2. runGit — argv-safety (headline test)
// ============================================================================

describe('runGit — argv-safety', () => {
  let runGit: typeof import('../../src/lib/git.js').runGit;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const childProcess = await import('node:child_process');
    spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReset();

    const gitModule = await import('../../src/lib/git.js');
    runGit = gitModule.runGit;
  });

  it('passes repo path with spaces as ONE argv element, not split', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    await runGit(['status'], { cwd: '/path/to/my repo' });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [cmd, args, opts] = spawnMock.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual(['status']);
    expect(opts.cwd).toBe('/path/to/my repo');
    expect(opts.shell).toBeFalsy();
  });

  it('branch name with special chars stays inert as argv element', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    const maliciousBranch = 'feature/$(whoami)';
    await runGit(['checkout', maliciousBranch]);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(['checkout', 'feature/$(whoami)']);
  });

  it('commit message with semicolons and backticks is inert', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    const msg = 'fix; rm -rf /';
    await runGit(['commit', '-m', msg]);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(['commit', '-m', 'fix; rm -rf /']);
  });

  it('leading-dash pathspec is passed as-is (caller uses --)', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    await runGit(['add', '--', '-weird-file']);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(['add', '--', '-weird-file']);
  });

  it('never uses shell mode', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    await runGit(['log']);

    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.shell).toBeFalsy();
  });

  it('resolves with exit code, stdout, stderr', async () => {
    spawnMock.mockReturnValue(createMockProc(0, 'output data', 'warning'));
    const result = await runGit(['status']);
    expect(result).toEqual({ code: 0, stdout: 'output data', stderr: 'warning' });
  });

  it('resolves with code -1 on spawn error', async () => {
    const proc = createMockProc(-1, '');
    proc.on.mockImplementation((event: string, cb: (arg: number | Error) => void) => {
      if (event === 'error') cb(new Error('spawn ENOENT'));
      if (event === 'close') cb(-1);
      return proc;
    });
    spawnMock.mockReturnValue(proc);

    const result = await runGit(['status']);
    expect(result.code).toBe(-1);
  });
});

// ============================================================================
// 3. runGit — network env guards
// ============================================================================

describe('runGit — network env', () => {
  let runGit: typeof import('../../src/lib/git.js').runGit;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const childProcess = await import('node:child_process');
    spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReset();

    const gitModule = await import('../../src/lib/git.js');
    runGit = gitModule.runGit;
  });

  it('sets GIT_TERMINAL_PROMPT=0 and GIT_SSH_COMMAND with BatchMode when network=true', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    await runGit(['push'], { network: true });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(opts.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(opts.env.SSH_OPTIONS).toBeUndefined();
  });

  it('does NOT set network env guards when network=false (default)', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    await runGit(['status']);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.GIT_TERMINAL_PROMPT).not.toBe('0');
  });

  it('merges caller env with defaults', async () => {
    spawnMock.mockReturnValue(createMockProc(0, '', ''));
    await runGit(['log'], { env: { ...process.env, MY_CUSTOM_VAR: 'hello' } });

    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.MY_CUSTOM_VAR).toBe('hello');
    expect(opts.env.PATH).toBeDefined();
  });
});

// ============================================================================
// 4. parseStatusPorcelain — porcelain v2 -z fixtures
//
// Parser behavior: splits stdout on NUL → each record is one field.
// Record format: '1 XY SUB mH mI mW tH tI path'
//   positions 0-1: prefix + space ('1 ')
//   positions 2-3: XY status code (e.g. 'M.', '.M', 'MM')
//   position  4: space
//   rest: SUB + numeric fields + path (path is last space-delimited field)
//
// Actually the parser does: prefix = record[0] (the '1'/'2'/'3'), then xy = record.substring(0,2).
// For '1 M ...': xy = '1 '. xy[0]='1', xy[1]=' '. getStatusCode('1') = 'unknown'.
// This means the parser expects 'XY' at positions 0-1, NOT after the prefix digit.
//
// REAL porcelain v2 format: '1 <XY> SUB MH MI MW TI path'
// Where <XY> is TWO chars starting at position 2. So record = '1 XY SUB ...'
// Parser: prefix = record[0] = '1', xy = record.substring(0,2) = '1 ' — still wrong!
//
// Looking at parser line 261: xy = record.substring(0, 2) — this gets positions 0-1.
// But the actual XY code is at positions 2-3 in porcelain v2.
// This means the parser has a bug OR the format is different than I think.
//
// Let me check: in porcelain v2, record = '1 <XY> ...'
// The '1' is at position 0, space at position 1, XY at positions 2-3.
// Parser: xy = record.substring(0,2) = '1 ' — NOT the XY code!
//
// This looks like a parser bug. But the parser WORKS (it's already deployed).
// So either: (a) the format is different, or (b) the parser compensates somehow.
//
// Checking line 272: indexStatus = xy[0] !== ' ' ? getStatusCode(xy[0]) : null
// xy[0] = '1' → getStatusCode('1') = 'unknown'. Not null, but not useful.
// xy[1] = ' ' → worktreeStatus = null (since xy[1] === ' ')
//
// This suggests the parser is designed for a DIFFERENT format where XY is at 0-1.
// Maybe the parser expects: 'XY SUB MH MI MW TI path' without the leading '1'.
// Or maybe: the format is 'XY\0path' after the split.
//
// Given the parser works in production, the REAL format after NUL split must be:
// Data record: 'XY SUB MH MI MW TI path' where XY = 2-char status at 0-1.
// No leading '1' prefix — that's part of the NUL-split format description, not the actual field.
//
// Wait — looking at git porcelain v2 with -z more carefully:
// The record is: '1 <XY> <sub> <mH> <mI> <mW> <tH> <tI> <path>\0'
// After NUL split, the field is: '1 <XY> <sub> <mH> <mI> <mW> <tH> <tI> <path>'
// Parser: prefix = '1', xy = record.substring(0,2) = '1 ' → NOT the XY code.
//
// Unless the parser's substring(0,2) is WRONG and it should be substring(2,4)?
// Let me look at the actual code one more time...
//
// Parser line 261: const xy = record.substring(0, 2);
// This is AT THE START of the record. For '1 M . 0 0 0 0 path', xy = '1 '.
// Then: xy[0] = '1', xy[1] = ' '. getStatusCode('1') = 'unknown'.
// staged = xy[0] !== ' ' → true (since '1' !== ' ').
//
// Hmm, that gives staged=true always for prefix-1 records, regardless of actual XY.
// And indexStatus = 'unknown' always. That's clearly wrong.
//
// BUT — maybe the ACTUAL git output doesn't have the '1' prefix in the NUL-split field?
// With -z, maybe git outputs: 'XY SUB MH MI MW TI path\0' (no '1' prefix in the field)?
// And the '1' is a record TYPE indicator that the parser checks at position 0?
//
// Actually, re-reading the git docs: in porcelain v2, the FIRST character is the entry type:
// '1' = ordinary, '2' = rename/copy, '3' = unmerged, '?' = untracked, '!' = ignored.
// Then a SPACE, then the XY code (2 chars), then more fields, then path.
//
// So: '1 XY SUB MH MI MW TI path' → type='1' at [0], space at [1], XY at [2..3].
// Parser: xy = record.substring(0,2) = '1 ' → WRONG for getting XY.
//
// This IS a parser bug. But the parser exists in production. Let me check if maybe
// the actual git output format is DIFFERENT for porcelain v2 -z...
//
// OK — I think I misread the git docs. Let me look at an ACTUAL example:
// $ git status --porcelain=v2 --branch -z
// # branch.oid <commit>
// # branch.head main
// # branch.upstream origin/main
// # branch.ab +0 -0
// 1 M. N... 100644 100644 100644 abc123 def456 path/to/file
//
// After NUL split: '1 M. N... 100644 100644 100644 abc123 def456 path/to/file'
// prefix = '1', xy = record.substring(0,2) = '1 ' → still wrong.
//
// BUT WAIT — maybe the NUL terminator replaces the NEWLINE, and the split gives:
// '1 M. N... 100644 100644 100644 abc123 def456 path/to/file'
// where '1' is at [0], ' ' at [1], 'M' at [2], '.' at [3].
// xy = record.substring(0,2) = '1 '. xy[0]='1', xy[1]=' '.
//
// This CANNOT be right for getting the XY code. The parser must be buggy.
// But it works in production... so maybe the ACTUAL output format is different.
//
// Let me look at the REAL git porcelain v2 -z output more carefully.
// Actually, in porcelain v2 WITHOUT -z, the format is:
// 1 <XY> <sub> <mH> <mI> <mW> <tH> <tI> <path>
// With -z, the record is NUL-terminated instead of LF-terminated.
// The fields are the SAME, just the terminator changes.
//
// So the record after NUL split IS: '1 <XY> <sub> ... <path>'
// And xy = record.substring(0,2) = '1 ' — which is NOT the XY code.
//
// Unless... the parser is actually correct and I'm misunderstanding the intent.
// Let me look at what the parser DOES with xy:
// - indexStatus = xy[0] !== ' ' ? getStatusCode(xy[0]) : null
//   xy[0] = '1' → getStatusCode('1') = 'unknown'
// - worktreeStatus = xy[1] !== ' ' ? getStatusCode(xy[1]) : null
//   xy[1] = ' ' → null
// - staged = xy[0] !== ' ' → true (always, for prefix-1 records)
//
// This gives: indexStatus='unknown', worktreeStatus=null, staged=true for ALL prefix-1 records.
// That's clearly wrong. The parser has a bug.
//
// BUT — the parser exists in the codebase and was written intentionally.
// Maybe the format expectations are different. Let me just write tests that match
// the ACTUAL parser behavior, even if it's buggy. The tests document the behavior.
// ============================================================================

describe('parseStatusPorcelain', () => {
  let parseStatusPorcelain!: typeof import('../../src/lib/git.js').parseStatusPorcelain;

  beforeEach(async () => {
    const gitModule = await import('../../src/lib/git.js');
    parseStatusPorcelain = gitModule.parseStatusPorcelain;
  });

  it('parses branch headers (head, upstream, ahead/behind)', () => {
    // Each header is one NUL-terminated field: '# branch.head main\0'
    const stdout = '# branch.head main' + NUL + '# branch.upstream origin/main' + NUL + '# branch.ab +3 -1' + NUL;

    const result = parseStatusPorcelain(stdout);
    expect(result.branch.head).toBe('main');
    expect(result.branch.upstream).toBe('origin/main');
    expect(result.branch.ahead).toBe(3);
    expect(result.branch.behind).toBe(1);
    expect(result.files).toEqual([]);
  });

  it('parses detached HEAD (branch.head value empty → null)', () => {
    const stdout = '# branch.head ' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.branch.head).toBeNull();
  });

  it('parses ordinary staged file (prefix 1) with flags', () => {
    // '1 M  . 0 0 0 0 src/index.ts' — XY at positions 2-3 = 'M ' (M=staged, space=worktree clean)
    // Real porcelain v2: space in XY means "unmodified"; dot is NOT a valid XY char
    const stdout = '1 M  . 0 0 0 0 src/index.ts' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/index.ts');
    expect(result.files[0].flags).toEqual({ index: 'M', worktree: ' ' });
    expect(result.files[0].staged).toBe(true);
    expect(result.files[0].indexStatus).toBe('modified');
    expect(result.files[0].worktreeStatus).toBeNull();
  });

  it('parses ordinary unstaged file with flags', () => {
    // '1  M . 0 0 0 0 README.md' — XY = ' M' (space=index clean, M=worktree modified)
    const stdout = '1  M . 0 0 0 0 README.md' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('README.md');
    expect(result.files[0].flags).toEqual({ index: ' ', worktree: 'M' });
    expect(result.files[0].staged).toBe(false);
    expect(result.files[0].indexStatus).toBeNull();
    expect(result.files[0].worktreeStatus).toBe('modified');
  });

  it('parses rename record (prefix 2) with origPath and flags', () => {
    // '2 R  . 0 0 0 0 R100 new.ts\0old.ts\0' — XY='R ', origPath from next NUL field
    const stdout = '2 R  . 0 0 0 0 R100 new.ts' + NUL + 'old.ts' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('new.ts');
    expect(result.files[0].origPath).toBe('old.ts');
    expect(result.files[0].flags).toEqual({ index: 'R', worktree: ' ' });
    expect(result.files[0].staged).toBe(true);
    expect(result.files[0].indexStatus).toBe('renamed');
  });

  it('includes untracked files (? prefix) in files array with flags', () => {
    const stdout = '? temp.log' + NUL + '? another.tmp' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe('temp.log');
    expect(result.files[0].flags).toEqual({ index: '?', worktree: '?' });
    expect(result.files[0].indexStatus).toBe('untracked');
    expect(result.files[0].worktreeStatus).toBe('untracked');
    expect(result.files[0].staged).toBe(false);
    expect(result.files[1].path).toBe('another.tmp');
    expect(result.untrackedCount).toBe(2);
  });

  it('includes ignored files (! prefix) in files array with flags', () => {
    const stdout = '! node_modules/' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('node_modules/');
    expect(result.files[0].flags).toEqual({ index: '!', worktree: '!' });
    expect(result.files[0].indexStatus).toBe('ignored');
    expect(result.files[0].worktreeStatus).toBe('ignored');
    expect(result.files[0].staged).toBe(false);
    expect(result.ignoredCount).toBe(1);
  });

  it('parses conflicted/unmerged file (prefix u)', () => {
    // Porcelain v2 unmerged prefix is 'u', not '3'
    const stdout = 'u UU . 0 0 0 0 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 conflict.ts' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('conflict.ts');
    // u-prefix records: always unmerged regardless of XY combo; staged=false (conflicts aren't staged)
    expect(result.files[0].staged).toBe(false);
    expect(result.files[0].indexStatus).toBe('unmerged');
    expect(result.files[0].worktreeStatus).toBe('unmerged');
  });

  it('handles path without spaces', () => {
    // XY='M ' (M staged, space=clean worktree)
    const stdout = '1 M  . 0 0 0 0 src/my-file.ts' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.files[0].path).toBe('src/my-file.ts');
    expect(result.files[0].indexStatus).toBe('modified');
  });

  it('handles multiple files with mixed staged/unstaged', () => {
    const stdout =
      '# branch.head main' + NUL +
      '1 M  . 0 0 0 0 src/a.ts' + NUL +
      '1  M . 0 0 0 0 src/b.ts' + NUL +
      '1  A . 0 0 0 0 src/c.ts' + NUL;
    const result = parseStatusPorcelain(stdout);
    expect(result.branch.branchName).toBeNull();
    expect(result.branch.head).toBe('main');
    expect(result.files).toHaveLength(3);
    expect(result.files[0].path).toBe('src/a.ts');
    expect(result.files[0].staged).toBe(true);
    expect(result.files[1].path).toBe('src/b.ts');
    expect(result.files[1].staged).toBe(false);
    expect(result.files[2].path).toBe('src/c.ts');
    expect(result.files[2].staged).toBe(false);
  });
});

// ============================================================================
// 5. parseLog — NUL-delimited log fixtures
//
// Format: '%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x00' with -z
// With -z, each commit produces: f0\0f1\0f2\0f3\0f4\0f5\0f6\0 (NUL-terminated)
// Parser: split on \0 (no filter) → flat array → chunk by 7 fields
// Root commit: parentsStr='' at position 5 → parents=[]
// ============================================================================

describe('parseLog', () => {
  let parseLog!: typeof import('../../src/lib/git.js').parseLog;

  beforeEach(async () => {
    const gitModule = await import('../../src/lib/git.js');
    parseLog = gitModule.parseLog;
  });

  it('parses a single commit record (7 NUL-delimited fields)', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const stdout = makeCommit([hash, 'abc123', 'Author Name', 'author@example.com', '1700000000', parent, 'Fix bug']);

    const result = parseLog(stdout);
    expect(result).toHaveLength(1);
    expect(result[0].hash).toBe(hash);
    expect(result[0].shortHash).toBe('abc123');
    expect(result[0].author).toBe('Author Name');
    expect(result[0].email).toBe('author@example.com');
    expect(result[0].timestamp).toBe(1700000000);
    expect(result[0].parents).toEqual([parent]);
    expect(result[0].subject).toBe('Fix bug');
  });

  it('parses subject with commas and quotes', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const stdout = makeCommit([hash, 'abc123', 'Author', 'a@b.com', '1700000000', parent, 'Fix bug with commas, "quotes", and more']);

    const result = parseLog(stdout);
    expect(result[0].subject).toBe('Fix bug with commas, "quotes", and more');
  });

  it('parses merge commit with 2 parents', () => {
    const hash = 'a'.repeat(40);
    const parent1 = 'b'.repeat(40);
    const parent2 = 'c'.repeat(40);
    const stdout = makeCommit([hash, 'abc123', 'Author', 'a@b.com', '1700000000', parent1 + ' ' + parent2, "Merge branch 'feature'"]);

    const result = parseLog(stdout);
    expect(result[0].parents).toEqual([parent1, parent2]);
  });

  it('parses root commit (empty parents field → parents=[])', () => {
    const hash = 'a'.repeat(40);
    // Root commit: parentsStr is an empty string at field index 5
    const stdout = makeCommit([hash, 'abc123', 'Author', 'a@b.com', '1700000000', '', 'Initial commit']);

    const result = parseLog(stdout);
    expect(result).toHaveLength(1);
    expect(result[0].parents).toEqual([]);
    expect(result[0].subject).toBe('Initial commit');
  });

  it('parses multiple commits (NUL-abutted)', () => {
    const hash1 = 'a'.repeat(40);
    const hash2 = 'd'.repeat(40);
    const parent = 'b'.repeat(40);
    const stdout = makeCommit([hash1, 'aaa', 'Author', 'a@b.com', '1700000001', parent, 'First commit'])
      + makeCommit([hash2, 'ddd', 'Author', 'a@b.com', '1700000002', hash1, 'Second commit']);

    const result = parseLog(stdout);
    expect(result).toHaveLength(2);
    expect(result[0].subject).toBe('First commit');
    expect(result[0].timestamp).toBe(1700000001);
    expect(result[1].subject).toBe('Second commit');
    expect(result[1].timestamp).toBe(1700000002);
    expect(result[1].parents).toEqual([hash1]);
  });

  it('skips malformed records with fewer than 7 fields', () => {
    // Only 3 fields — i+6 would exceed array length, so loop body never runs
    const stdout = ['abc', 'def', 'only-3-fields'].join(NUL) + NUL;
    const result = parseLog(stdout);
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// 6. parseShowNumstat — binary, ordinary, rename
//
// Parser: splits stdout on '\x00\x00' (double NUL) to get [header, body].
// Header: 7 NUL-separated fields (same as parseLog).
// Body: numstat lines, each NUL-terminated.
// Boundary: header trailing NUL + body leading content = single NUL (NOT double).
// So the split point is: header's LAST field has trailing \0, body's FIRST numstat
// line has NO leading \0. The double NUL only appears if body starts with \0.
//
// Correct fixture format:
//   header = hash\0short\0author\0email\0time\0parents\0subject  (NO trailing \0)
//   body = numstat1\0numstat2\0                                  (NUL-terminated lines)
//   stdout = header + NUL + NUL + body                           (double NUL separator)
// ============================================================================

describe('parseShowNumstat', () => {
  let parseShowNumstat!: typeof import('../../src/lib/git.js').parseShowNumstat;

  beforeEach(async () => {
    const gitModule = await import('../../src/lib/git.js');
    parseShowNumstat = gitModule.parseShowNumstat;
  });

  it('parses header fields identically to parseLog', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    // Parser: split('\x00\x00') → [headerSection, bodySection]
    // headerSection.split('\0').filter(Boolean) → 7 fields
    // bodySection.split('\0').filter(Boolean) → numstat lines
    //
    // Fixture: header with trailing NUL + body with leading NUL = double NUL at boundary.
    // [7 fields, ''].join(NUL) = 'f0\0f1\0...\0f6\0' (trailing NUL from empty string)
    // + NUL + body = 'f0\0...\0f6\0\0body' → split('\x00\x00') → ['f0\0...\0f6', 'body']
    // But we need headerSection to end with NUL for 7 fields after split.
    // So: header = [7 fields].join(NUL) = 'f0\0...\0f6' (NO trailing NUL)
    // + NUL + NUL + body = 'f0\0...\0f6\0\0body' → split → ['f0\0...\0f6\0', 'body']
    // Wait: 'f0\0...\0f6\0\0body'.split('\x00\x00') →
    //   The \0\0 is at position after f6's NUL. Split gives ['f0\0...\0f6', 'body'].
    //   Header section = 'f0\0...\0f6' → split('\0') → 7 fields ✓
    //   No trailing NUL in headerSection.
    //
    // For empty body: header + NUL + NUL = 'f0\0...\0f6\0\0'
    //   split('\x00\x00') → ['f0\0...\0f6', '']
    //   bodySection = '' → split('\0').filter(Boolean) → [] ✓
    const header = [hash, 'abc123', 'Author', 'a@b.com', '1700000000', parent, 'Commit message'].join(NUL);
    const stdout = header + NUL + NUL;

    const result = parseShowNumstat(stdout);
    expect(result.commit.hash).toBe(hash);
    expect(result.commit.shortHash).toBe('abc123');
    expect(result.commit.author).toBe('Author');
    expect(result.commit.email).toBe('a@b.com');
    expect(result.commit.timestamp).toBe(1700000000);
    expect(result.commit.parents).toEqual([parent]);
    expect(result.commit.subject).toBe('Commit message');
    expect(result.files).toEqual([]);
  });

  it('parses ordinary file numstat (additions/deletions/path)', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const header = [hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Msg'].join(NUL);
    // Body: numstat line NUL-terminated. Split('\x00\x00') consumes the double NUL.
    // header + NUL + NUL + body → split → [header, body]. Body has leading NUL consumed.
    // So body = '5\t3\tsrc/index.ts\0' after split? No — the \0 before body is consumed.
    // Actually: '...\0' + '\0' + '5\t3\tsrc/index.ts\0' = '...\0\05\t3\tsrc/index.ts\0'
    // split('\x00\x00') → ['...header...', '5\t3\tsrc/index.ts\0']
    // bodySection = '5\t3\tsrc/index.ts\0' → split('\0').filter(Boolean) → ['5\t3\tsrc/index.ts'] ✓
    const body = '5\t3\tsrc/index.ts' + NUL;
    const stdout = header + NUL + NUL + body;

    const result = parseShowNumstat(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: 'src/index.ts',
      additions: 5,
      deletions: 3,
      binary: false,
    });
  });

  it('parses binary file numstat (-\t- → binary:true)', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const header = [hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Msg'].join(NUL);
    // Binary: -\t-\0path\0 (NUL between counts and path)
    // After split('\x00\x00'): body = '-\t-\0image.png\0'
    // split('\0').filter(Boolean) → ['-\\t-', 'image.png']
    // Line '-\t-': firstTabIdx=1, firstField='-', rest='-', rest.startsWith('-\t')? NO
    // Hmm — rest is just '-' (no tab). Binary detection fails.
    //
    // Real binary format: -\t-\0path\0
    // After split: line = '-\t-' → firstField='-', rest='-'
    // rest.startsWith('-\t') → false. Parser falls to ordinary path.
    //
    // Correct fixture for binary: -\t-\t\0path\0 (with trailing tab)
    // After split: line = '-\t-\t' → firstField='-', rest='-\t'
    // rest.startsWith('-\t') → true! binaryPath = rest.substring(2) = '' → empty
    //
    // Hmm. Real git binary numstat: -\t-\tpath (tab-separated, no NUL)
    // With -z: -\t-\tpath\0 (NUL terminated)
    // After split('\x00\x00'): body = '-\t-\tpath\0'
    // split('\0').filter(Boolean) → ['-\t-\tpath']
    // firstTabIdx=1, firstField='-', rest='-\tpath'
    // rest.startsWith('-\t') → true! binaryPath = rest.substring(2) = 'path' ✓
    const body = '-\t-\timage.png' + NUL;
    const stdout = header + NUL + NUL + body;

    const result = parseShowNumstat(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: 'image.png',
      additions: 0,
      deletions: 0,
      binary: true,
    });
  });

  it('parses rename numstat (origPath from extra NUL field)', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const header = [hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Msg'].join(NUL);
    // Rename: adds\tdelets\t\0origPath\0newPath\0
    // After split('\x00\x00'): body = '10\t2\t\0old-name.ts\0new-name.ts\0'
    // BUT: the \0 between header and body is consumed by split.
    // header ends with 'Msg' (no trailing NUL from join).
    // header + NUL + NUL + body = '...Msg\0\0' + body
    // If body starts with '10\t2\t\0...', then:
    // '...Msg\0\010\t2\t\0old-name.ts\0new-name.ts\0'
    // split('\x00\x00') → ['...Msg', '10\t2\t\0old-name.ts\0new-name.ts\0']
    // Wait — '10\t2\t\0' has \0 NOT \0\0. So split doesn't break here.
    // Actually: the \0\0 is at 'Msg\0\010'. Split gives ['...Msg', '10\t2\t\0old-name.ts\0new-name.ts\0'].
    // Hmm no — 'Msg\0\010' → the \0\0 is between Msg and 10. Split gives ['...Msg', '10\t2\t\0old-name.ts\0new-name.ts\0'].
    // Wait: the body starts with '10'. So after \0\0, next char is '1'. The body string is
    // '10\t2\t\0old-name.ts\0new-name.ts\0'. This is the bodySection.
    // split('\0').filter(Boolean) → ['10\t2\t', 'old-name.ts', 'new-name.ts']
    // Line '10\t2\t': firstTabIdx=2, firstField='10', rest='2\t'
    // rest[0]='2' !== '\0' → ordinary path
    // secondTabIdx=1, adds='2', afterAdds=''
    // pathParts = ['']... hmm.
    //
    // Problem: the \0 after '2\t' is consumed by the outer split. The rename marker is lost.
    //
    // Fix: need the \0 after the second tab to SURVIVE the \0\0 split.
    // That means body needs an EXTRA \0: '10\t2\t\0\0old-name.ts\0new-name.ts\0'
    // But then split('\x00\x00') would break AT that point too!
    //
    // Hmm. The real git output for numstat with -z:
    // adds\tdelets\t\0origPath\0newPath\0
    // The \0 after delets is a FIELD separator, not part of \0\0.
    // So in the full output: ...subject\0\n10\t2\t\0old\0new\0
    // With -z: ...subject\0\010\t2\t\0old\0new\0 (newline→NUL)
    // But the subject trailing \0 + record leading content = just one \0 before '10'.
    // So: ...subject\0\n10\t... → with -z: ...subject\0\010\t...
    // split('\x00\x00') at the boundary: ['...subject', '10\t2\t\0old\0new\0']
    // body = '10\t2\t\0old\0new\0' → split('\0') → ['10\t2\t', 'old', 'new']
    // But the rename marker \0 after '2\t' is lost!
    //
    // The ONLY way this works: body = '10\t2\t\0old\0new\0' where \0 after '2\t' is preserved.
    // For that, the \0\0 split must NOT consume the \0 after '2\t'.
    // The \0\0 is between subject's trailing \0 and the record.
    // Record starts with '10\t2\t\0...'. The \0\0 is: subject\0 + \0 + 10\t2\t...
    // After split: subject section = '...subject\0', body = '10\t2\t\0old\0new\0'
    // Wait — '...subject\0\010\t2\t\0old\0new\0'.split('\x00\x00') →
    //   Find \x00\x00 at position after 'subject\0'. Split gives:
    //   ['...subject\0', '10\t2\t\0old\0new\0']? No — 'subject\0\0' → split on \0\0
    //   gives ['subject', '10\t2\t\0old\0new\0']. The trailing \0 of subject is consumed.
    //
    // Hmm wait: 'subject\0\010\t2\t\0old\0new\0'. The \0\0 is at the boundary.
    // split('\x00\x00') → ['subject', '10\t2\t\0old\0new\0']. ✓
    // body = '10\t2\t\0old\0new\0'. This has the \0 after '2\t'. ✓
    // body.split('\0').filter(Boolean) → ['10\t2\t', 'old', 'new'] ✓
    //
    // So the fixture: header(7 fields, join with NUL, NO trailing NUL) + NUL + NUL + body
    // Where body = '10\t2\t\0old\0new\0'
    // Full: '...Msg\0\010\t2\t\0old-name.ts\0new-name.ts\0'
    // split('\x00\x00') → ['...Msg', '10\t2\t\0old-name.ts\0new-name.ts\0']
    // Wait: 'Msg\0\010' → the \0\0 is between Msg and 10. ✓
    // But then body = '10\t2\t\0old-name.ts\0new-name.ts\0' ← has \0 after '2\t' ✓
    //
    // BUT WAIT — earlier I used header + NUL + body where body = '10\t2\t\0old\0new\0'
    // That gives: '...Msg\0' + '10\t2\t\0old\0new\0' = '...Msg\010\t2\t\0old\0new\0'
    // Only ONE \0 between Msg and 10. split('\x00\x00') finds no match → one section.
    //
    // Need: header + NUL + NUL + body = '...Msg\0\010\t2\t\0old\0new\0'
    // So: header = [7 fields].join(NUL), stdout = header + NUL + NUL + body
    const body = '10\t2\t' + NUL + 'old-name.ts' + NUL + 'new-name.ts' + NUL;
    const stdout = header + NUL + NUL + body;

    const result = parseShowNumstat(stdout);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('new-name.ts');
    expect(result.files[0].origPath).toBe('old-name.ts');
    expect(result.files[0].additions).toBe(10);
    expect(result.files[0].deletions).toBe(2);
  });

  it('throws on malformed header (too few fields)', () => {
    const badHeader = ['abc123', 'incomplete'].join(NUL);
    const stdout = badHeader + NUL + NUL;
    expect(() => parseShowNumstat(stdout)).toThrow('Invalid git show output');
  });

  it('parses multiple files in numstat', () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const header = [hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Msg'].join(NUL);
    const body = '5\t3\tsrc/a.ts' + NUL + '0\t10\tsrc/b.ts' + NUL;
    const stdout = header + NUL + NUL + body;

    const result = parseShowNumstat(stdout);
    expect(result.files).toHaveLength(2);
    expect(result.files[0].path).toBe('src/a.ts');
    expect(result.files[1].path).toBe('src/b.ts');
    expect(result.files[1].deletions).toBe(10);
  });
});

// ============================================================================
// 6. getRepoStatus — Story 6.2
//
// Tests that getRepoStatus calls runGit with correct args and maps the
// parseStatusPorcelain output to GitRepoStatus shape with counts.
// ============================================================================

describe('getRepoStatus', () => {
  let getRepoStatus: typeof import('../../src/lib/git.js').getRepoStatus;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const childProcess = await import('node:child_process');
    spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReset();

    const gitModule = await import('../../src/lib/git.js');
    getRepoStatus = gitModule.getRepoStatus;
  });

  it('calls runGit with correct porcelain v2 args and returns mapped status', async () => {
    const stdout =
      '# branch.head main' + NUL +
      '# branch.upstream origin/main' + NUL +
      '# branch.ab +2 -1' + NUL +
      '1 M  . 0 0 0 0 src/a.ts' + NUL +
      '1  M . 0 0 0 0 src/b.ts' + NUL +
      '? untracked.txt' + NUL;

    spawnMock.mockReturnValue(createMockProc(0, stdout, ''));

    const result = await getRepoStatus('/path/to/repo');

    expect(spawnMock).toHaveBeenCalledOnce();
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(['-C', '/path/to/repo', 'status', '--porcelain=v2', '--branch', '-z']);

    expect(result.branch.head).toBe('main');
    expect(result.branch.upstream).toBe('origin/main');
    expect(result.branch.ahead).toBe(2);
    expect(result.branch.behind).toBe(1);
    expect(result.files).toHaveLength(3);
    expect(result.stagedCount).toBe(1);
    expect(result.unstagedCount).toBe(1);
    expect(result.untrackedCount).toBe(1);
    expect(result.conflicted).toBe(0);
  });

  it('throws on non-zero exit code', async () => {
    spawnMock.mockReturnValue(createMockProc(128, '', 'fatal: not a git repository'));
    await expect(getRepoStatus('/not/a/repo')).rejects.toThrow('git status failed');
  });

  it('computes correct counts for mixed status', async () => {
    const stdout =
      '# branch.head feature' + NUL +
      '1 A  . 0 0 0 0 new-file.ts' + NUL +
      '1 M  . 0 0 0 0 modified.ts' + NUL +
      'u UU . 0 0 0 0 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 0000000000000000000000000000000000000000 conflict.ts' + NUL +
      '? untracked.log' + NUL;

    spawnMock.mockReturnValue(createMockProc(0, stdout, ''));
    const result = await getRepoStatus('/repo');

    expect(result.stagedCount).toBe(2); // A and M staged; UU is unmerged (staged=false)
    expect(result.conflicted).toBe(1);
    expect(result.untrackedCount).toBe(1);
  });

  it('returns zero counts for clean working tree', async () => {
    const stdout = '# branch.head main' + NUL;
    spawnMock.mockReturnValue(createMockProc(0, stdout, ''));
    const result = await getRepoStatus('/clean-repo');

    expect(result.files).toHaveLength(0);
    expect(result.stagedCount).toBe(0);
    expect(result.unstagedCount).toBe(0);
    expect(result.untrackedCount).toBe(0);
    expect(result.conflicted).toBe(0);
    expect(result.ignoredCount).toBe(0);
  });
});

// ============================================================================
// 7. discoverRepos — Story 6.2
//
// Tests multi-repo discovery: root repo + nested repo both surfaced,
// dedup (same path not added twice), worktree detection.
// ============================================================================

vi.mock('node:fs/promises', () => {
  const readdirMock = vi.fn();
  const statMock = vi.fn();
  const readFileMock = vi.fn();
  const accessMock = vi.fn();
  return {
    readdir: readdirMock,
    stat: statMock,
    readFile: readFileMock,
    access: accessMock,
    constants: { F_OK: 0 },
  };
});

describe('discoverRepos', () => {
  let discoverRepos: typeof import('../../src/lib/git.js').discoverRepos;
  let readdirMock: ReturnType<typeof vi.fn>;
  let statMock: ReturnType<typeof vi.fn>;
  let accessMock: ReturnType<typeof vi.fn>;
  let readFileMock: ReturnType<typeof vi.fn>;

  function makeDirStat() {
    return { isDirectory: () => true, isFile: () => false };
  }
  // .git directory (not a worktree file)
  function makeGitDirStat() {
    return { isDirectory: () => true, isFile: () => false };
  }

  beforeEach(async () => {
    vi.resetModules();
    const fs = await import('node:fs/promises');
    readdirMock = vi.mocked(fs.readdir as unknown as ReturnType<typeof vi.fn>);
    statMock = vi.mocked(fs.stat as unknown as ReturnType<typeof vi.fn>);
    accessMock = vi.mocked(fs.access as unknown as ReturnType<typeof vi.fn>);
    readFileMock = vi.mocked(fs.readFile as unknown as ReturnType<typeof vi.fn>);
    readdirMock.mockReset();
    statMock.mockReset();
    accessMock.mockReset();
    readFileMock.mockReset();
    const gitModule = await import('../../src/lib/git.js');
    discoverRepos = gitModule.discoverRepos;
  });

  it('finds multiple repos discovered under the scan root', async () => {
    // discoverRepos scans ENTRIES of cwd, not cwd itself.
    // Layout: cwd=/workspace, entries: repo-a (has .git), sub/ (dir), sub/repo-b (has .git)
    readdirMock.mockImplementation((dir: string) => {
      if (dir === '/workspace') return Promise.resolve(['repo-a', 'sub']);
      if (dir === '/workspace/sub') return Promise.resolve(['repo-b']);
      return Promise.resolve([]);
    });
    statMock.mockImplementation((p: string) => {
      if (p.endsWith('/.git')) return Promise.resolve(makeGitDirStat());
      return Promise.resolve(makeDirStat());
    });
    accessMock.mockImplementation((p: string) => {
      if (p === '/workspace/repo-a/.git' || p === '/workspace/sub/repo-b/.git') return Promise.resolve(undefined);
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await discoverRepos({ cwd: '/workspace' });
    const paths = result.repos.map(r => r.path).sort();
    expect(paths).toContain('/workspace/repo-a');
    expect(paths).toContain('/workspace/sub/repo-b');
    expect(paths).toHaveLength(2);
    expect(result.capped).toBe(false);
  });

  it('does not duplicate the same repo path when found multiple times', async () => {
    // Only one repo in scan root
    readdirMock.mockImplementation((dir: string) => {
      if (dir === '/workspace') return Promise.resolve(['my-repo']);
      return Promise.resolve([]);
    });
    statMock.mockResolvedValue(makeGitDirStat());
    accessMock.mockImplementation((p: string) => {
      if (p === '/workspace/my-repo/.git') return Promise.resolve(undefined);
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await discoverRepos({ cwd: '/workspace' });
    expect(result.repos).toHaveLength(1);
    expect(result.repos[0].path).toBe('/workspace/my-repo');
  });

  it('returns empty when no repos found', async () => {
    readdirMock.mockResolvedValue([]);
    accessMock.mockRejectedValue(new Error('ENOENT'));
    const result = await discoverRepos({ cwd: '/empty' });
    expect(result.repos).toHaveLength(0);
    expect(result.capped).toBe(false);
  });

  it('caps results at maxRepos and sets capped=true', async () => {
    // cwd has 3 repo entries; maxRepos=2 should cap
    readdirMock.mockImplementation((dir: string) => {
      if (dir === '/workspace') return Promise.resolve(['repo-a', 'repo-b', 'repo-c']);
      return Promise.resolve([]);
    });
    statMock.mockResolvedValue(makeGitDirStat());
    accessMock.mockImplementation((p: string) => {
      if (p.endsWith('/.git')) return Promise.resolve(undefined);
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await discoverRepos({ cwd: '/workspace', maxRepos: 2 });
    expect(result.repos.length).toBeLessThanOrEqual(2);
    expect(result.capped).toBe(true);
  });
});

// ============================================================================
// 7. getLog — pagination + argv-safety
// ============================================================================

describe('getLog', () => {
  let getLog!: typeof import('../../src/lib/git.js').getLog;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();

    const gitModule = await import('../../src/lib/git.js');
    getLog = gitModule.getLog;
  });

  it('passes limit and skip as discrete argv elements', async () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const stdout = makeCommit([hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Fix']);

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    await getLog('/repo/path', { limit: 25, skip: 10 });

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-C', '/repo/path', 'log', '-n', '25', '--skip', '10']),
      expect.objectContaining({ shell: false })
    );
  });

  it('defaults limit to 50 and skip to 0', async () => {
    spawnMock.mockReset();
    const proc = createMockProc(0, '');
    spawnMock.mockReturnValue(proc);

    await getLog('/repo/path');

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-n', '50', '--skip', '0']),
      expect.anything()
    );
  });

  it('returns GitCommit[] with timestamp in milliseconds', async () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const stdout = makeCommit([hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Fix']);

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    const commits = await getLog('/repo/path');

    expect(commits).toHaveLength(1);
    expect(commits[0].timestamp).toBe(1700000000000);
  });

  it('throws on non-zero exit', async () => {
    const proc = createMockProc(128, '', 'fatal: not a git repository');
    spawnMock.mockReturnValue(proc);

    await expect(getLog('/not-a-repo')).rejects.toThrow('git log failed');
  });

  it('argv-safety: repo path is one argv element (no shell injection)', async () => {
    spawnMock.mockClear();
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const stdout = makeCommit([hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Fix']);

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    await getLog('/path with spaces;rm -rf /', { limit: 10, skip: 0 });

    const call = spawnMock.mock.calls[0];
    expect(call[2].shell).toBe(false);
    // Repo path is passed as -C argv element (not spawn cwd option)
    expect(call[1]).toEqual(
      expect.arrayContaining(['-C', '/path with spaces;rm -rf /'])
    );
  });

  it('caps limit at 500 at the library level (unbounded request is clamped)', async () => {
    spawnMock.mockClear();
    const proc = createMockProc(0, '');
    spawnMock.mockReturnValue(proc);

    await getLog('/repo/path', { limit: 9_999_999 });

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-n', '500']),
      expect.anything()
    );
    // The unbounded value must never reach git
    expect(spawnMock.mock.calls[0][1]).not.toContain('9999999');
  });
});

// ============================================================================
// 8. getCommit — commit detail with file list
// ============================================================================

describe('getCommit', () => {
  let getCommit!: typeof import('../../src/lib/git.js').getCommit;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();

    const gitModule = await import('../../src/lib/git.js');
    getCommit = gitModule.getCommit;
  });

  it('validates hash format (rejects non-hex)', async () => {
    await expect(getCommit('/repo', 'not-a-hex-string')).rejects.toThrow(/invalid.*hash/i);
  });

  it('validates hash length (7-40 hex chars)', async () => {
    await expect(getCommit('/repo', 'abc')).rejects.toThrow(/invalid.*hash/i);
    await expect(getCommit('/repo', 'a'.repeat(41))).rejects.toThrow(/invalid.*hash/i);
  });

  it('accepts 7-char short hash (minimum safe length)', async () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const header = [hash, 'abc1234', 'Author', 'a@b.com', '1700000000', parent, 'Msg'].join(NUL);
    const stdout = header + NUL + NUL;

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    await getCommit('/repo', 'abc1234');
    expect(spawnMock).toHaveBeenCalled();
  });

  it('rejects 4-6 char hash (too short, ambiguous)', async () => {
    await expect(getCommit('/repo', 'abcd')).rejects.toThrow(/invalid.*hash/i);
    await expect(getCommit('/repo', 'abc12')).rejects.toThrow(/invalid.*hash/i);
    await expect(getCommit('/repo', 'abcdef')).rejects.toThrow(/invalid.*hash/i);
  });

  it('returns GitCommitWithDiff with timestamp in milliseconds', async () => {
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const header = [hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Msg'].join(NUL);
    const body = '5\t3\tsrc/index.ts' + NUL;
    const stdout = header + NUL + NUL + body;

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    const result = await getCommit('/repo', hash);

    expect(result.timestamp).toBe(1700000000000);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('src/index.ts');
  });

  it('argv-safety: hash is one argv element (no injection)', async () => {
    spawnMock.mockClear();
    const hash = 'a'.repeat(40);
    const parent = 'b'.repeat(40);
    const header = [hash, 'abc', 'Author', 'a@b.com', '1700000000', parent, 'Msg'].join(NUL);
    const body = '5\t3\tsrc/index.ts' + NUL;
    const stdout = header + NUL + NUL + body;

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    await getCommit('/repo', hash);

    const call = spawnMock.mock.calls[0];
    expect(call[2].shell).toBe(false);
    expect(call[1]).toContain(hash);
  });

  it('throws on non-zero exit', async () => {
    const hash = 'a'.repeat(40);
    const proc = createMockProc(128, '', 'fatal: bad object');
    spawnMock.mockReturnValue(proc);

    await expect(getCommit('/repo', hash)).rejects.toThrow('git show failed');
  });
});

// ============================================================================
// 9. getFileDiff — single file unified diff
// ============================================================================

describe('getFileDiff', () => {
  let getFileDiff!: typeof import('../../src/lib/git.js').getFileDiff;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();

    const gitModule = await import('../../src/lib/git.js');
    getFileDiff = gitModule.getFileDiff;
  });

  it('validates hash format', async () => {
    await expect(getFileDiff('/repo', 'invalid', 'file.ts')).rejects.toThrow(/invalid.*hash/i);
  });

  it('argv-safety: path after -- separator (no injection)', async () => {
    spawnMock.mockReset();
    const hash = 'a'.repeat(40);
    const proc = createMockProc(0, 'diff --git a/file.ts b/file.ts\n+line');
    spawnMock.mockReturnValue(proc);

    await getFileDiff('/repo', hash, 'path with spaces;evil');

    const call = spawnMock.mock.calls[0];
    expect(call[2].shell).toBe(false);
    const argv = call[1] as string[];
    const separatorIdx = argv.indexOf('--');
    expect(separatorIdx).toBeGreaterThan(-1);
    expect(argv[separatorIdx + 1]).toBe('path with spaces;evil');
  });

  it('returns raw unified diff text', async () => {
    const hash = 'a'.repeat(40);
    const diffText = 'diff --git a/file.ts b/file.ts\n+added line\n-removed line';
    const proc = createMockProc(0, diffText);
    spawnMock.mockReturnValue(proc);

    const result = await getFileDiff('/repo', hash, 'file.ts');

    expect(result).toBe(diffText);
  });

  it('throws on non-zero exit', async () => {
    const hash = 'a'.repeat(40);
    const proc = createMockProc(128, '', 'fatal: bad object');
    spawnMock.mockReturnValue(proc);

    await expect(getFileDiff('/repo', hash, 'file.ts')).rejects.toThrow('git diff failed');
  });
});

// ============================================================================
// 10. getGraph — DAG with --all + cap
// ============================================================================

describe('getGraph', () => {
  let getGraph!: typeof import('../../src/lib/git.js').getGraph;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();

    const gitModule = await import('../../src/lib/git.js');
    getGraph = gitModule.getGraph;
  });

  it('uses --all --topo-order for multi-branch DAG', async () => {
    const proc = createMockProc(0, '');
    spawnMock.mockReturnValue(proc);

    await getGraph('/repo', { maxCommits: 100 });

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['--all', '--topo-order']),
      expect.anything()
    );
  });

  it('fetches maxCommits+1 to detect cap without false-positive', async () => {
    const proc = createMockProc(0, '');
    spawnMock.mockReturnValue(proc);

    await getGraph('/repo', { maxCommits: 500 });

    // Must request 501 to distinguish "exactly 500" from "capped at 500"
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['-n', '501']),
      expect.anything()
    );
  });

  it('returns capped:true when git returns more than maxCommits', async () => {
    const hash1 = 'a'.repeat(40);
    const hash2 = 'b'.repeat(40);
    const stdout =
      makeCommit([hash1, 'aaa', 'Author', 'a@b.com', '1700000001', '', 'First']) +
      makeCommit([hash2, 'bbb', 'Author', 'a@b.com', '1700000000', hash1, 'Second']);

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    // maxCommits=1 → fetch 2 → get 2 → capped=true, return only 1
    const result = await getGraph('/repo', { maxCommits: 1 });

    expect(result.capped).toBe(true);
    expect(result.commits).toHaveLength(1);
  });

  it('returns capped:false when repo has exactly maxCommits commits', async () => {
    const hash = 'a'.repeat(40);
    const stdout = makeCommit([hash, 'abc', 'Author', 'a@b.com', '1700000000', '', 'Only commit']);

    const proc = createMockProc(0, stdout);
    spawnMock.mockReturnValue(proc);

    // maxCommits=1 → fetch 2 → get 1 (repo only has 1) → capped=false
    const result = await getGraph('/repo', { maxCommits: 1 });

    expect(result.capped).toBe(false);
    expect(result.commits).toHaveLength(1);
  });

  it('returns capped:false when result < maxCommits', async () => {
    const proc = createMockProc(0, '');
    spawnMock.mockReturnValue(proc);

    const result = await getGraph('/repo', { maxCommits: 100 });

    expect(result.capped).toBe(false);
    expect(result.commits).toHaveLength(0);
  });
});

// ============================================================================
// 11. Write actions — argv safety + stderr classification (Story 6.4)
// ============================================================================

describe('stagePaths — argv construction', () => {
  let stagePaths: typeof import('../../src/lib/git.js').stagePaths;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    stagePaths = (await import('../../src/lib/git.js')).stagePaths;
  });

  it('passes pathspec with spaces as single inert argv element', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await stagePaths('/repo', ['path with spaces/file.ts']);
    const [, argv] = spawnMock.mock.calls[0];
    expect(argv).toContain('path with spaces/file.ts');
    expect(argv).toContain('--');
    expect(argv.indexOf('--')).toBeLessThan(argv.indexOf('path with spaces/file.ts'));
  });

  it('passes pathspec with shell metacharacters as single inert argv element', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await stagePaths('/repo', ['src/;rm -rf /.ts']);
    const [, argv] = spawnMock.mock.calls[0];
    const specIdx = argv.findIndex((a: string) => a.includes(';rm'));
    expect(specIdx).toBeGreaterThan(-1);
    expect(argv[specIdx]).toBe('src/;rm -rf /.ts');
  });

  it('throws on non-zero exit', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'error: some git error'));
    await expect(stagePaths('/repo', ['file.ts'])).rejects.toThrow('stage failed');
  });
});

describe('commit — argv + stderr classification', () => {
  let commitFn: typeof import('../../src/lib/git.js').commit;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    commitFn = (await import('../../src/lib/git.js')).commit;
  });

  it('passes message with semicolons as single argv element', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await commitFn('/repo', 'fix; drop table users');
    const [, argv] = spawnMock.mock.calls[0];
    expect(argv).toContain('-m');
    const mIdx = argv.indexOf('-m');
    expect(argv[mIdx + 1]).toBe('fix; drop table users');
  });

  it('classifies "nothing to commit" stderr as actionable', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'nothing to commit, working tree clean'));
    await expect(commitFn('/repo', 'msg')).rejects.toThrow('no staged changes to commit');
  });

  it('classifies missing author identity stderr as actionable', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'Please tell me who you are.'));
    await expect(commitFn('/repo', 'msg')).rejects.toThrow('set git user.name/user.email on the host');
  });

  it('falls through to generic error on unknown stderr', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'unknown error'));
    await expect(commitFn('/repo', 'msg')).rejects.toThrow('commit failed');
  });
});

describe('push — network mode + stderr classification', () => {
  let pushFn: typeof import('../../src/lib/git.js').push;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    pushFn = (await import('../../src/lib/git.js')).push;
  });

  it('sets GIT_TERMINAL_PROMPT=0 (network mode)', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await pushFn('/repo');
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(opts.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
  });

  it('does NOT emit --force or --force-with-lease', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await pushFn('/repo');
    const [, argv] = spawnMock.mock.calls[0];
    const joined = argv.join(' ');
    expect(joined).not.toContain('--force');
    expect(joined).not.toContain('--force-with-lease');
    expect(joined).not.toMatch(/\+[^/]/);
  });

  it('classifies no-upstream stderr', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'has no upstream branch'));
    await expect(pushFn('/repo')).rejects.toThrow('no upstream configured for this branch');
  });

  it('classifies auth failure stderr', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'Authentication failed for'));
    await expect(pushFn('/repo')).rejects.toThrow('authentication required');
  });

  it('classifies non-fast-forward stderr', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'Updates were rejected because the remote contains work that you do\nnon-fast-forward'));
    await expect(pushFn('/repo')).rejects.toThrow('push rejected (non-fast-forward)');
  });
});

describe('switchBranch — validateSafeRef + dirty-tree classification', () => {
  let branchFn: typeof import('../../src/lib/git.js').branch;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    branchFn = (await import('../../src/lib/git.js')).branch;
  });

  it('passes branch name as single inert argv element', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await branchFn('/repo', 'feat/my-feature', false);
    const [, argv] = spawnMock.mock.calls[0];
    expect(argv).toContain('feat/my-feature');
    expect(argv[argv.length - 1]).toBe('feat/my-feature');
  });

  it('rejects branch name with leading dash (injection risk)', async () => {
    await expect(branchFn('/repo', '-bad', false)).rejects.toThrow(/dash/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects branch name with ".." (range syntax)', async () => {
    await expect(branchFn('/repo', 'main..evil', false)).rejects.toThrow(/\.\./);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('classifies dirty-tree stderr as actionable', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'Your local changes to the following files would be overwritten by checkout'));
    await expect(branchFn('/repo', 'other', false)).rejects.toThrow('uncommitted changes would be overwritten');
  });

  it('uses switch -c for create=true', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await branchFn('/repo', 'new-branch', true);
    const [, argv] = spawnMock.mock.calls[0];
    expect(argv).toContain('-c');
    expect(argv).toContain('new-branch');
  });
});

describe('pull — network mode + stdout/stderr classification', () => {
  let pullFn: typeof import('../../src/lib/git.js').pull;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    pullFn = (await import('../../src/lib/git.js')).pull;
  });

  it('sets GIT_TERMINAL_PROMPT=0 (network mode)', async () => {
    spawnMock.mockReturnValue(createMockProc(0, ''));
    await pullFn('/repo');
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(opts.env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
  });

  it('classifies no-upstream stderr', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'has no upstream branch'));
    await expect(pullFn('/repo')).rejects.toThrow('no upstream configured for this branch');
  });

  it('classifies auth failure stderr', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'Authentication failed for'));
    await expect(pullFn('/repo')).rejects.toThrow('authentication required');
  });

  it('classifies conflict from stderr (merge path)', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'CONFLICT (content): Merge conflict in src/foo.ts'));
    await expect(pullFn('/repo')).rejects.toThrow('pull produced conflicts — resolve on the host');
  });

  it('classifies conflict from stdout (git pull standard output)', async () => {
    spawnMock.mockReturnValue(createMockProc(1, 'CONFLICT (content): Merge conflict in src/foo.ts\n', ''));
    await expect(pullFn('/repo')).rejects.toThrow('pull produced conflicts — resolve on the host');
  });

  it('falls through to generic error on unknown failure', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'some unknown error'));
    await expect(pullFn('/repo')).rejects.toThrow('pull failed');
  });
});

// ============================================================================
// 12. Worktree — listWorktrees, classifyCwd, validateWorkingDir (Story 6.5)
// ============================================================================

describe('listWorktrees — porcelain parsing', () => {
  let listWorktrees: typeof import('../../src/lib/git.js').listWorktrees;
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const cp = await import('node:child_process');
    spawnMock = vi.mocked(cp.spawn);
    spawnMock.mockClear();
    listWorktrees = (await import('../../src/lib/git.js')).listWorktrees;
  });

  it('parses main + linked + detached worktrees from porcelain fixture', async () => {
    const porcelain = [
      'worktree /home/user/project\nHEAD abc123\nbranch refs/heads/main',
      'worktree /home/user/project-feature\nHEAD def456\nbranch refs/heads/feature-x',
      'worktree /home/user/project-detached\nHEAD ghi789\ndetached',
    ].join('\n\n');
    spawnMock.mockReturnValue(createMockProc(0, porcelain));

    const result = await listWorktrees('/home/user/project');
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ path: '/home/user/project', head: 'abc123', branch: 'main', detached: false, bare: false });
    expect(result[1]).toMatchObject({ path: '/home/user/project-feature', head: 'def456', branch: 'feature-x', detached: false });
    expect(result[2]).toMatchObject({ path: '/home/user/project-detached', head: 'ghi789', detached: true });
    expect(result[2].branch).toBeUndefined();
  });

  it('includes bare worktree entry (no HEAD line)', async () => {
    const porcelain = 'worktree /home/user/project.git\nbranch refs/heads/main\nbare';
    spawnMock.mockReturnValue(createMockProc(0, porcelain));

    const result = await listWorktrees('/home/user/project.git');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ path: '/home/user/project.git', bare: true });
  });

  it('strips refs/heads/ prefix from branch field', async () => {
    const porcelain = 'worktree /repo\nHEAD aaa\nbranch refs/heads/my-feature';
    spawnMock.mockReturnValue(createMockProc(0, porcelain));

    const result = await listWorktrees('/repo');
    expect(result[0].branch).toBe('my-feature');
  });

  it('throws on non-zero exit code', async () => {
    spawnMock.mockReturnValue(createMockProc(1, '', 'fatal: not a git repo'));
    await expect(listWorktrees('/not-a-repo')).rejects.toThrow('git worktree list failed');
  });

  it('passes repoPath as -C argv element (argv-safety)', async () => {
    spawnMock.mockReturnValue(createMockProc(0, 'worktree /repo\nHEAD abc\nbranch refs/heads/main'));
    await listWorktrees('/path with spaces/repo');
    const [, argv] = spawnMock.mock.calls[0];
    expect(argv).toContain('-C');
    const cIdx = argv.indexOf('-C');
    expect(argv[cIdx + 1]).toBe('/path with spaces/repo');
  });
});

// classifyCwd and validateWorkingDir tests live in git-worktree.test.ts
// (isolated because vi.mock('node:fs/promises') must be file-level — Vitest hoisting conflict)
