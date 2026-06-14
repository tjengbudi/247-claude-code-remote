import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'fs';
import { join } from 'path';
import { getTestableHomedir } from './paths.js';

const MANAGED_START = '# >>> 247 managed >>>';
const MANAGED_END = '# <<< 247 managed <<<';

export interface SetupTmuxResumeResult {
  backupPath?: string;
  pluginsCloned: boolean;
  configUpdated: boolean;
}

/**
 * Clone tmux-resurrect and tmux-continuum plugins, write managed config block.
 * Idempotent: re-runs replace the managed block in-place, no duplicates.
 */
export function setupTmuxResume(tmuxDir: string): SetupTmuxResumeResult {
  const result: SetupTmuxResumeResult = { pluginsCloned: false, configUpdated: false };

  // 1. Clone plugins (skip if already present)
  const pluginsDir = join(tmuxDir, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });

  const resurrectDir = join(pluginsDir, 'tmux-resurrect');
  if (!existsSync(resurrectDir)) {
    execSync(`git clone --depth 1 https://github.com/tmux-plugins/tmux-resurrect "${resurrectDir}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  const continuumDir = join(pluginsDir, 'tmux-continuum');
  if (!existsSync(continuumDir)) {
    execSync(
      `git clone --depth 1 https://github.com/tmux-plugins/tmux-continuum "${continuumDir}"`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  }
  result.pluginsCloned = true;

  // 2. Render managed block with ABSOLUTE paths (tmux doesn't expand ~)
  const tmuxConfPath = join(getTestableHomedir(), '.tmux.conf');
  const managedBlock = renderManagedBlock(tmuxDir);

  // 3. Read or create .tmux.conf
  let existingContent = '';
  let needsBackup = false;

  if (existsSync(tmuxConfPath)) {
    existingContent = readFileSync(tmuxConfPath, 'utf-8');
    if (!existingContent.includes(MANAGED_START)) {
      needsBackup = true;
    }
  }

  // 4. Backup if first time touching user's config
  if (needsBackup) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${tmuxConfPath}.247-backup-${timestamp}`;
    copyFileSync(tmuxConfPath, backupPath);
    result.backupPath = backupPath;
  }

  // 5. Update config (replace existing block or append)
  let newContent: string;
  if (existingContent.includes(MANAGED_START)) {
    // Replace existing managed block
    const regex = new RegExp(
      `${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}`,
      'g'
    );
    newContent = existingContent.replace(regex, managedBlock);
  } else {
    // Append block
    const separator = existingContent.trimEnd().length > 0 ? '\n\n' : '';
    newContent = existingContent.trimEnd() + separator + '\n' + managedBlock + '\n';
  }

  // 6. Atomic write via temp file + rename
  const tempPath = `${tmuxConfPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, newContent, 'utf-8');
  renameSync(tempPath, tmuxConfPath);
  result.configUpdated = true;

  return result;
}

/**
 * Remove the 247 managed block from ~/.tmux.conf (used by uninstall).
 */
export function removeTmuxResume(): void {
  const tmuxConfPath = join(getTestableHomedir(), '.tmux.conf');
  if (!existsSync(tmuxConfPath)) return;

  const content = readFileSync(tmuxConfPath, 'utf-8');
  if (!content.includes(MANAGED_START)) return;

  // Remove the managed block and surrounding blank lines
  const regex = new RegExp(
    `\\n*${escapeRegex(MANAGED_START)}[\\s\\S]*?${escapeRegex(MANAGED_END)}\\n*`,
    'g'
  );
  const cleaned = content.replace(regex, '\n').trim() + '\n';

  const tempPath = `${tmuxConfPath}.tmp-${process.pid}`;
  writeFileSync(tempPath, cleaned, 'utf-8');
  renameSync(tempPath, tmuxConfPath);
}

function renderManagedBlock(tmuxDir: string): string {
  const resurrectPath = join(tmuxDir, 'plugins', 'tmux-resurrect', 'resurrect.tmux');
  const continuumPath = join(tmuxDir, 'plugins', 'tmux-continuum', 'continuum.tmux');

  return `${MANAGED_START}
set -g exit-empty off
set -g @resurrect-dir '${join(tmuxDir, 'resurrect')}'
set -g @resurrect-capture-pane-contents 'on'
set -g @resurrect-processes '"~claude->claude --continue" "~codex->codex resume --last" "gemini" "qwen"'
set -g @continuum-restore 'on'
set -g @continuum-save-interval '5'
run-shell '${resurrectPath}'
run-shell '${continuumPath}'
${MANAGED_END}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
