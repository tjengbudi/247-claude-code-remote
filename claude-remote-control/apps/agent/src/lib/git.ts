/**
 * Git contract implementation — safe executor + parsers (Epic 6, Story 6.1)
 *
 * Anti-pattern warnings:
 * - NEVER build git as shell string; always spawn('git', argvArray, { cwd, env }) with shell=false
 * - Terminate options with '--' before user-supplied pathspecs to prevent leading-dash injection
 * - Network ops MUST set GIT_TERMINAL_PROMPT=0 + GIT_SSH_COMMAND with BatchMode=yes
 * - Parse `-z` output: records are NUL-terminated; split on \0, not whitespace
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { access, constants, readFile, readdir, stat } from 'node:fs/promises';

export type {
  GitExecResult,
  GitFileStatusFlags,
  GitFileInfo,
  GitBranchInfo,
  GitRepoStatus,
  GitCommit,
  GitDiffFile,
  GitCommitWithDiff,
  DiscoveredGitRepo,
  DiscoverReposOptions,
  DiscoverReposResult,
  GitRunOptions,
  SafeRefResult,
} from '247-shared';

// ============================================================================
// Safe reference validator
// ============================================================================

/**
 * Validate a git ref (branch name, tag) against safe patterns.
 * Rejects: leading '-', '..', control chars (anywhere), spaces.
 */
export function validateSafeRef(ref: string): { valid: true; normalized: string } | { valid: false; reason: string } {
  if (!ref || typeof ref !== 'string') return { valid: false, reason: 'empty ref' };
  if (/\s/.test(ref)) return { valid: false, reason: 'ref contains whitespace' };
  if (/[\x00-\x1f]/.test(ref)) return { valid: false, reason: 'ref contains control characters' };
  if (ref.startsWith('-')) return { valid: false, reason: 'ref starts with dash (injection risk)' };
  if (ref.includes('..')) return { valid: false, reason: "ref contains '..' (range syntax)" };
  // Accept normal branch names like feature/x, main, v1.0.0
  return { valid: true, normalized: ref };
}

// ============================================================================
// Git executor core
// ============================================================================

/**
 * Run a git command safely via child_process.spawn().
 * NEVER uses shell mode — argv elements are inert data.
 */
export async function runGit(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; network?: boolean } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { cwd, env, network = false } = opts;

  // Build environment: merge with process.env, add network guards if needed
  const gitEnv: NodeJS.ProcessEnv = { ...process.env };
  if (network) {
    gitEnv.GIT_TERMINAL_PROMPT = '0';
    // GIT_SSH_COMMAND is the correct env var for passing SSH flags to git
    gitEnv.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }

  // Additional env overrides (caller-provided)
  if (env) Object.assign(gitEnv, env);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    // SECURITY: Always pass argv array, never shell out
    // cwd can contain spaces/special chars — they're one inert argv element
    const proc = spawn('git', args, {
      cwd: cwd || process.cwd(),
      env: gitEnv,
      shell: false,
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      // Preserve any stderr already accumulated alongside the spawn error
      resolve({ code: -1, stdout, stderr: stderr + (stderr ? '\n' : '') + String(err) });
    });

    proc.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ============================================================================
// Repository discovery
// ============================================================================

async function hasDotGit(dir: string): Promise<boolean> {
  try {
    const dotGitPath = join(dir, '.git');
    await access(dotGitPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover all git repos under a starting directory.
 * Skips configured directories (e.g., node_modules).
 * Prunes descent into found repos to avoid O(n-files) traversal.
 * Returns unique top-level repos.
 */
export async function discoverRepos(
  opts: { cwd?: string; skipDirs?: string[]; maxDepth?: number; maxRepos?: number } = {}
): Promise<{ repos: Array<{ path: string; topLevel: boolean; worktreeInfo?: { mainWorktree: string; detached: boolean } }>; capped: boolean }> {
  const { cwd = process.cwd(), skipDirs = ['node_modules', '.247-worktrees'], maxDepth = -1, maxRepos = 50 } = opts;
  const resolvedRoot = resolve(cwd);

  const foundPaths = new Set<string>();
  const worktrees = new Map<string, { mainWorktree: string; detached: boolean }>();

  async function scan(dir: string, depth: number): Promise<boolean> {
    if (foundPaths.size >= maxRepos) return true;
    if (maxDepth >= 0 && depth > maxDepth) return false;

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (skipDirs.includes(entry)) continue;

      const fullPath = join(dir, entry);

      if (await hasDotGit(fullPath)) {
        // Check if .git is a file (worktree pointer) or directory (main repo)
        const gitFile = join(fullPath, '.git');
        let gitStat: Awaited<ReturnType<typeof stat>> | null = null;
        try {
          gitStat = await stat(gitFile);
        } catch {
          // .git doesn't exist or not accessible; treat as plain repo
        }

        if (gitStat?.isFile()) {
          // Linked worktree: .git file contains "gitdir: /abs/.git/worktrees/<name>"
          const content = (await readFile(gitFile, 'utf8')).trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (match) {
            // gitdir → .git/worktrees/<name>; resolve to absolute then climb 3 dirs to repo root
            const gitdir = resolve(fullPath, match[1]);
            const mainWorktree = resolve(gitdir, '../../..');
            foundPaths.add(fullPath);
            worktrees.set(fullPath, { mainWorktree, detached: false });
            // Prune — don't recurse into a worktree's subtree
            continue;
          }
        }

        // Regular repo (or submodule): record and prune
        if (!foundPaths.has(fullPath)) {
          foundPaths.add(fullPath);
        }
        if (foundPaths.size >= maxRepos) return true;
        // Prune: don't recurse below a found repo
        continue;
      }

      // Not a repo — recurse if it's a directory
      try {
        const st = await stat(fullPath);
        if (st.isDirectory()) {
          const capped = await scan(fullPath, depth + 1);
          if (capped) return true;
        }
      } catch {
        // Ignore non-readable entries
      }
    }

    return false;
  }

  const capped = await scan(resolvedRoot, 0);

  const repos = Array.from(foundPaths).map((path) => ({
    path,
    topLevel: !worktrees.has(path),
    worktreeInfo: worktrees.get(path),
  }));

  return { repos: repos.slice(0, maxRepos), capped };
}

// ============================================================================
// Parsers (pure functions, testable via fixtures)
// ============================================================================

/**
 * Parse git status --porcelain=v2 --branch -z output.
 * Format: NUL-terminated records; header records start with '#', data records start with digit.
 *
 * Porcelain v2 record format:
 *   '1 XY SUB mH mI mW tH tI path'  — ordinary (prefix '1')
 *   '2 XY SUB mH mI mW tH tI R score path'  — rename/copy (prefix '2'), next NUL field = origPath
 *   'u XY SUB m1 m2 m3 mW h1 h2 h3 path'  — unmerged (prefix 'u')
 *   '? path'  — untracked
 *   '! path'  — ignored
 *
 * XY is at positions 2–3 (0-indexed) of the record string.
 */
export function parseStatusPorcelain(stdout: string): {
  branch: { head: string | null; upstream: string | null; ahead: number; behind: number; branchName: string | null };
  files: Array<{
    path: string;
    flags: { index: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' '; worktree: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' ' };
    indexStatus: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
    worktreeStatus: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
    staged: boolean;
    origPath?: string;
  }>;
  untrackedCount: number;
  ignoredCount: number;
} {
  const records = stdout.split('\0').filter(Boolean);
  const files: Array<{
    path: string;
    flags: { index: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' '; worktree: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' ' };
    indexStatus: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
    worktreeStatus: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
    staged: boolean;
    origPath?: string;
  }> = [];
  let branchHead: string | null = null;
  let branchUpstream: string | null = null;
  let branchAhead = 0;
  let branchBehind = 0;
  let branchName: string | null = null;
  let untrackedCount = 0;
  let ignoredCount = 0;

  for (let i = 0; i < records.length; i++) {
    const record = records[i].trim();
    if (!record) continue;

    // Header lines (branch info) — start with '#'
    if (record.startsWith('#')) {
      if (record.startsWith('# branch.head ')) {
        branchHead = record.substring('# branch.head '.length).trim() || null;
      } else if (record.startsWith('# branch.upstream ')) {
        branchUpstream = record.substring('# branch.upstream '.length).trim() || null;
      } else if (record.startsWith('# branch.ab ')) {
        const parts = record.substring('# branch.ab '.length).trim().split(' ');
        branchAhead = parseInt(parts.find((p) => p.startsWith('+'))?.substring(1) || '0', 10);
        branchBehind = parseInt(parts.find((p) => p.startsWith('-'))?.substring(1) || '0', 10);
      } else if (record.startsWith('# branch.name ')) {
        branchName = record.substring('# branch.name '.length).trim() || null;
      }
      continue;
    }

    // Untracked / ignored — include as distinct GitFileInfo entries
    if (record.startsWith('? ')) {
      const filePath = record.substring(2);
      untrackedCount++;
      files.push({
        path: filePath,
        flags: { index: '?', worktree: '?' },
        indexStatus: 'untracked',
        worktreeStatus: 'untracked',
        staged: false,
      });
      continue;
    }
    if (record.startsWith('! ')) {
      const filePath = record.substring(2);
      ignoredCount++;
      files.push({
        path: filePath,
        flags: { index: '!', worktree: '!' },
        indexStatus: 'ignored',
        worktreeStatus: 'ignored',
        staged: false,
      });
      continue;
    }

    // Data records: '1 XY ...', '2 XY ...', 'u XY ...'
    if (/^[12u]/.test(record)) {
      const prefix = record[0];
      // XY is at positions 2-3 (after "prefix " at 0-1)
      const xy = record.substring(2, 4);
      const rest = record.substring(5); // skip "prefix XY "... fields before path

      // File path is the last space-delimited field
      const lastSpaceIdx = rest.lastIndexOf(' ');
      const filePath = lastSpaceIdx >= 0 ? rest.substring(lastSpaceIdx + 1) : rest;

      const indexCode = xy[0] as 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' ';
      const worktreeCode = xy[1] as 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' ';

      if (prefix === '2') {
        // Rename/copy: the NEXT NUL-delimited record is origPath
        const origPath = records[i + 1]?.trim() || undefined;
        files.push({
          path: filePath,
          flags: { index: indexCode, worktree: worktreeCode },
          indexStatus: xy[0] !== ' ' ? getStatusCode(xy[0]) : null,
          worktreeStatus: xy[1] !== ' ' ? getStatusCode(xy[1]) : null,
          staged: xy[0] !== ' ',
          origPath,
        });
        i++; // skip origPath record
      } else if (prefix === 'u') {
        // Unmerged: XY can be AA/DD/AU/UA/DU/UD/UU — all mean conflict.
        // getStatusCode maps only 'U'→'unmerged'; others ('A','D') would give wrong semantic.
        files.push({
          path: filePath,
          flags: { index: indexCode, worktree: worktreeCode },
          indexStatus: 'unmerged',
          worktreeStatus: 'unmerged',
          staged: false,
        });
      } else {
        // Ordinary changed file ('1')
        files.push({
          path: filePath,
          flags: { index: indexCode, worktree: worktreeCode },
          indexStatus: xy[0] !== ' ' ? getStatusCode(xy[0]) : null,
          worktreeStatus: xy[1] !== ' ' ? getStatusCode(xy[1]) : null,
          staged: xy[0] !== ' ',
        });
      }
    }
  }

  return {
    branch: { head: branchHead, upstream: branchUpstream, ahead: branchAhead, behind: branchBehind, branchName },
    files,
    untrackedCount,
    ignoredCount,
  };
}

/**
 * Helper: map single-character porcelain v2 status to human-readable string.
 */
function getStatusCode(c: string): 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null {
  switch (c) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'U': return 'unmerged';
    case '?': return 'untracked';
    case '!': return 'ignored';
    default: return null;
  }
}

/**
 * Parse git log --format='%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x00' -z output.
 *
 * With -z each record is NUL-terminated: field0\0field1\0...\0field6\0
 * Records are separated by newlines OR by the double-NUL boundary created when
 * the trailing \0 of one record abuts the start of the next.
 *
 * Strategy: split on the record terminator pattern to get per-commit chunks,
 * then split each chunk on \0 to get exactly 7 fields. This correctly handles
 * root commits (empty parents field is preserved as an empty string, not filtered).
 */
export function parseLog(stdout: string): Array<{
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  timestamp: number;
  parents: string[];
  subject: string;
}> {
  const commits: Array<{ hash: string; shortHash: string; author: string; email: string; timestamp: number; parents: string[]; subject: string }> = [];

  // Format: field0\0field1\0...\0field6\0 per commit (NUL-terminated with -z).
  // Split on \0 WITHOUT filter(Boolean) — the empty parents field of a root commit
  // must remain as '' at position 5, not be dropped. Chunk flat array by 7.
  const allFields = stdout.split('\0');

  for (let i = 0; i + 6 < allFields.length; i += 7) {
    const hash = allFields[i];
    if (!hash) continue; // skip trailing empty element at end of output
    const parentsStr = allFields[i + 5];
    commits.push({
      hash,
      shortHash: allFields[i + 1],
      author: allFields[i + 2],
      email: allFields[i + 3],
      timestamp: Number(allFields[i + 4]),
      parents: parentsStr ? parentsStr.split(' ').filter(Boolean) : [],
      subject: allFields[i + 6],
    });
  }

  return commits;
}

/**
 * Parse git show --numstat -z --format='%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x00' <hash> output.
 * Returns GitCommit header + per-file diffs.
 *
 * With -z, numstat format per file:
 *   ordinary: additions\tdeletions\tpath\0
 *   rename:   additions\tdeletions\t\0origPath\0newPath\0  (empty path field + 2 extra NUL fields)
 *   binary:   -\t-\tpath\0
 *
 * Header and numstat body are separated by double-NUL (\0\0).
 */
export function parseShowNumstat(
  stdout: string
): { commit: { hash: string; shortHash: string; author: string; email: string; timestamp: number; parents: string[]; subject: string }; files: Array<{ path: string; additions: number; deletions: number; binary: boolean; origPath?: string }> } {
  const sections = stdout.split('\x00\x00'); // separator between commit header and numstat body
  const headerSection = sections[0].trim();
  const bodySection = sections.slice(1).join('\0');

  // Parse commit header (same fields as parseLog)
  const headerFields = headerSection.split('\0').filter(Boolean);
  if (headerFields.length < 7) {
    throw new Error('Invalid git show output: malformed header');
  }
  const [hash, shortHash, author, email, atStr, parentsStr, subject] = headerFields;

  const commit = {
    hash,
    shortHash,
    author,
    email,
    timestamp: Number(atStr),
    parents: parentsStr ? parentsStr.split(' ').filter(Boolean) : [],
    subject,
  };

  // Parse numstat body (NUL-terminated records)
  const files: Array<{ path: string; additions: number; deletions: number; binary: boolean; origPath?: string }> = [];
  const lines = bodySection.split('\0').filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Numstat line format: additions\tdeletions\tpath (ordinary/binary)
    //                      additions\tdeletions\t    (rename — empty path, next two NUL fields are origPath/newPath)
    const firstTabIdx = line.indexOf('\t');
    if (firstTabIdx < 0) continue; // not a numstat line

    const firstField = line.substring(0, firstTabIdx);
    const rest = line.substring(firstTabIdx + 1);

    if (firstField === '-' && rest.startsWith('-\t')) {
      // Binary file: -\t-\tpath
      const binaryPath = rest.substring(2);
      files.push({ path: binaryPath, additions: 0, deletions: 0, binary: true });
    } else {
      // Text file: firstField = additions, rest = deletions\tpath OR deletions\t (empty = rename)
      const secondTabIdx = rest.indexOf('\t');
      const deletions = secondTabIdx >= 0 ? rest.substring(0, secondTabIdx) : '0';
      const afterDeletions = secondTabIdx >= 0 ? rest.substring(secondTabIdx + 1) : '';

      if (afterDeletions === '' && i + 2 < lines.length && !lines[i + 1].includes('\t') && !lines[i + 2].includes('\t')) {
        // Rename: next two NUL-separated fields are origPath and newPath
        files.push({
          path: lines[i + 2],
          additions: Number(firstField),
          deletions: Number(deletions) || 0,
          binary: false,
          origPath: lines[i + 1],
        });
        i += 2; // skip origPath and newPath lines
      } else {
        // Ordinary: afterDeletions is the path
        files.push({
          path: afterDeletions,
          additions: Number(firstField),
          deletions: Number(deletions) || 0,
          binary: false,
        });
      }
    }
  }

  return { commit, files };
}

/**
 * Get complete git status for a repository, mapped to GitRepoStatus shape.
 *
 * Calls `git -C <repoPath> status --porcelain=v2 --branch -z` and maps output
 * to shared GitRepoStatus type with per-file GitFileInfo entries including
 * flags, staged/worktree status, and untracked/ignored files.
 *
 * @param repoPath - Absolute path to git repository
 * @returns GitRepoStatus with branch info, file list, and counts
 */
export async function getRepoStatus(repoPath: string): Promise<{
  branch: {
    head: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    branchName: string | null;
  };
  files: Array<{
    path: string;
    flags: { index: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' '; worktree: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' ' };
    indexStatus: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
    worktreeStatus: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
    staged: boolean;
    origPath?: string;
  }>;
  conflicted: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  ignoredCount: number;
}> {
  const result = await runGit(['-C', repoPath, 'status', '--porcelain=v2', '--branch', '-z']);

  if (result.code !== 0) {
    throw new Error(`git status failed: ${result.stderr}`);
  }

  const parsed = parseStatusPorcelain(result.stdout);

  // Compute counts from file list
  const conflicted = parsed.files.filter(f => f.indexStatus === 'unmerged' || f.worktreeStatus === 'unmerged').length;
  const stagedCount = parsed.files.filter(f => f.staged).length;
  const unstagedCount = parsed.files.filter(f => f.worktreeStatus && f.worktreeStatus !== 'untracked' && f.worktreeStatus !== 'ignored' && f.worktreeStatus !== 'unmerged').length;

  return {
    branch: parsed.branch,
    files: parsed.files,
    conflicted,
    stagedCount,
    unstagedCount,
    untrackedCount: parsed.untrackedCount,
    ignoredCount: parsed.ignoredCount,
  };
}
