import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as realFs from 'fs';

// Mock fs and child_process at module level
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof realFs>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    renameSync: vi.fn(),
  };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Import mocked fs for use in tests
import * as fs from 'fs';

describe('tmux-resume', () => {
  let tmuxDir: string;
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Use real temp dir for isolation
    tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), '247-tmux-test-'));
    realFs.mkdirSync(path.join(tmpDir, '.247'), { recursive: true });
    process.env.AGENT_247_HOME = tmpDir;

    tmuxDir = path.join(tmpDir, '.247', 'tmux');

    // Default mocks
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.writeFileSync).mockImplementation(() => undefined);
    vi.mocked(fs.copyFileSync).mockImplementation(() => undefined);
    vi.mocked(fs.renameSync).mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    // Cleanup temp dir
    realFs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('setupTmuxResume', () => {
    it('clones plugins if not present', async () => {
      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');
      const { execSync } = await import('child_process');

      setupTmuxResume(tmuxDir);

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone --depth 1 https://github.com/tmux-plugins/tmux-resurrect'),
        expect.anything()
      );
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone --depth 1 https://github.com/tmux-plugins/tmux-continuum'),
        expect.anything()
      );
    });

    it('skips clone if plugins already exist', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pStr = String(p);
        // Simulate plugins already cloned
        if (pStr.includes('tmux-resurrect') || pStr.includes('tmux-continuum')) {
          return true;
        }
        return false;
      });

      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');
      const { execSync } = await import('child_process');

      setupTmuxResume(tmuxDir);

      expect(execSync).not.toHaveBeenCalled();
    });

    it('creates .tmux.conf if missing', async () => {
      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');

      setupTmuxResume(tmuxDir);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.tmp-'),
        expect.stringContaining('# >>> 247 managed >>>'),
        'utf-8'
      );
    });

    it('backs up existing .tmux.conf without marker', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pStr = String(p);
        // .tmux.conf exists but no managed block
        if (pStr.endsWith('.tmux.conf')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue('set -g default-terminal "screen-256color"');

      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');
      const result = setupTmuxResume(tmuxDir);

      expect(result.backupPath).toMatch(/\.247-backup-\d{4}-\d{2}-\d{2}/);
      expect(fs.copyFileSync).toHaveBeenCalled();
    });

    it('replaces existing managed block without backup', async () => {
      const existingBlock = `# >>> 247 managed >>>
set -g exit-empty off
# <<< 247 managed <<<`;
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pStr = String(p);
        if (pStr.endsWith('.tmux.conf')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(existingBlock);

      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');
      const result = setupTmuxResume(tmuxDir);

      expect(result.backupPath).toBeUndefined();
      expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('uses atomic write (temp file + rename)', async () => {
      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');

      setupTmuxResume(tmuxDir);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const renameCall = vi.mocked(fs.renameSync).mock.calls[0];

      expect(writeCall[0]).toMatch(/\.tmp-\d+$/);
      expect(renameCall[0]).toBe(writeCall[0]);
      expect(renameCall[1]).toMatch(/\.tmux\.conf$/);
    });

    it('uses absolute paths (no ~ expansion)', async () => {
      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');

      setupTmuxResume(tmuxDir);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const content = writeCall[1] as string;

      expect(content).not.toMatch(/~\//);
      expect(content).toContain(tmuxDir);
    });

    it('includes all required tmux config options', async () => {
      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');

      setupTmuxResume(tmuxDir);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const content = writeCall[1] as string;

      expect(content).toContain('set -g exit-empty off');
      expect(content).toContain('@resurrect-dir');
      expect(content).toContain('@resurrect-capture-pane-contents');
      expect(content).toContain('@resurrect-processes');
      expect(content).toContain('@continuum-restore');
      expect(content).toContain('@continuum-save-interval');
      expect(content).toContain('run-shell');
    });

    it('includes correct resume mapping for AI tools', async () => {
      const { setupTmuxResume } = await import('../../src/lib/tmux-resume.js');

      setupTmuxResume(tmuxDir);

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const content = writeCall[1] as string;

      expect(content).toContain('~claude->claude --continue');
      expect(content).toContain('~codex->codex resume --last');
      expect(content).toContain('gemini');
      expect(content).toContain('qwen');
    });
  });

  describe('removeTmuxResume', () => {
    it('strips managed block from .tmux.conf', async () => {
      const content = `set -g default-terminal "screen-256color"

# >>> 247 managed >>>
set -g exit-empty off
# <<< 247 managed <<<

set -g history-limit 10000`;
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pStr = String(p);
        if (pStr.endsWith('.tmux.conf')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue(content);

      const { removeTmuxResume } = await import('../../src/lib/tmux-resume.js');
      removeTmuxResume();

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      const cleaned = writeCall[1] as string;

      expect(cleaned).not.toContain('247 managed');
      expect(cleaned).toContain('default-terminal');
      expect(cleaned).toContain('history-limit');
    });

    it('does nothing if .tmux.conf missing', async () => {
      const { removeTmuxResume } = await import('../../src/lib/tmux-resume.js');
      removeTmuxResume();

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('does nothing if no managed block present', async () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const pStr = String(p);
        if (pStr.endsWith('.tmux.conf')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockReturnValue('set -g default-terminal "screen-256color"');

      const { removeTmuxResume } = await import('../../src/lib/tmux-resume.js');
      removeTmuxResume();

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });
  });
});
