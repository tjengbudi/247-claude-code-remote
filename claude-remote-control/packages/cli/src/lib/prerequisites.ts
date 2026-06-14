import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import * as net from 'net';
import { getTestableHomedir } from './paths.js';
import { getAgentPaths } from './paths.js';

export interface PrerequisiteCheck {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  required: boolean;
}

/**
 * Check if Node.js version is sufficient
 */
export function checkNodeVersion(): PrerequisiteCheck {
  const version = process.version;
  const major = parseInt(version.slice(1).split('.')[0], 10);

  if (major >= 22) {
    return {
      name: 'Node.js',
      status: 'ok',
      message: version,
      required: true,
    };
  }

  if (major >= 18) {
    return {
      name: 'Node.js',
      status: 'warn',
      message: `${version} (recommended: >=22)`,
      required: true,
    };
  }

  return {
    name: 'Node.js',
    status: 'error',
    message: `${version} (required: >=22)`,
    required: true,
  };
}

/**
 * Check if tmux is installed
 */
export function checkTmux(): PrerequisiteCheck {
  try {
    const output = execSync('tmux -V', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const version = output.trim();

    // Parse version (e.g., "tmux 3.3a", "tmux 2.9", "tmux next-3.4")
    const match = version.match(/tmux (\d+)\.(\d+)/);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);

      // resurrect requires tmux >= 1.9
      if (major < 1 || (major === 1 && minor < 9)) {
        return {
          name: 'tmux',
          status: 'warn',
          message: `${version} (resurrect requires >=1.9)`,
          required: true,
        };
      }
    }

    return {
      name: 'tmux',
      status: 'ok',
      message: version,
      required: true,
    };
  } catch {
    const os = platform();
    const installCmd = os === 'darwin' ? 'brew install tmux' : 'sudo apt install tmux';

    return {
      name: 'tmux',
      status: 'error',
      message: `Not installed. Run: ${installCmd}`,
      required: true,
    };
  }
}

/**
 * Check platform compatibility
 */
export function checkPlatform(): PrerequisiteCheck {
  const os = platform();

  if (os === 'darwin') {
    return {
      name: 'Platform',
      status: 'ok',
      message: 'macOS',
      required: true,
    };
  }

  if (os === 'linux') {
    return {
      name: 'Platform',
      status: 'ok',
      message: 'Linux',
      required: true,
    };
  }

  return {
    name: 'Platform',
    status: 'error',
    message: `Unsupported: ${os}. Only macOS and Linux are supported.`,
    required: true,
  };
}

/**
 * Check if a port is available
 */
export async function checkPort(port: number): Promise<PrerequisiteCheck> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve({
          name: `Port ${port}`,
          status: 'error',
          message: 'Port is already in use',
          required: false,
        });
      } else {
        resolve({
          name: `Port ${port}`,
          status: 'warn',
          message: `Could not check: ${err.message}`,
          required: false,
        });
      }
    });

    server.once('listening', () => {
      server.close();
      resolve({
        name: `Port ${port}`,
        status: 'ok',
        message: 'Available',
        required: false,
      });
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Run all prerequisite checks
 */
export async function checkAllPrerequisites(port?: number): Promise<PrerequisiteCheck[]> {
  const checks: PrerequisiteCheck[] = [checkPlatform(), checkNodeVersion(), checkTmux()];

  if (port) {
    checks.push(await checkPort(port));
  }

  return checks;
}

/**
 * Check if all required prerequisites are met
 */
export function allRequiredMet(checks: PrerequisiteCheck[]): boolean {
  return checks.filter((c) => c.required).every((c) => c.status !== 'error');
}

/**
 * Check native dependencies (node-pty, better-sqlite3)
 */
export async function checkNativeDeps(): Promise<PrerequisiteCheck> {
  const issues: string[] = [];

  // Check node-pty
  try {
    await import('@homebridge/node-pty-prebuilt-multiarch');
  } catch {
    issues.push('node-pty');
  }

  // Check better-sqlite3
  try {
    await import('better-sqlite3');
  } catch {
    issues.push('better-sqlite3');
  }

  if (issues.length === 0) {
    return {
      name: 'Native modules',
      status: 'ok',
      message: 'All native modules loaded successfully',
      required: true,
    };
  }

  return {
    name: 'Native modules',
    status: 'error',
    message: `Failed to load: ${issues.join(', ')}`,
    required: true,
  };
}

/**
 * Get the path to the ABI version tracking file
 */
function getAbiVersionFile(): string {
  return join(getTestableHomedir(), '.247', 'node-abi-version');
}

/**
 * Get the stored Node ABI version from the last successful run
 */
export function getStoredAbiVersion(): string | null {
  try {
    return readFileSync(getAbiVersionFile(), 'utf-8').trim();
  } catch {
    return null;
  }
}

/**
 * Store the current Node ABI version after successful native module load
 */
export function storeAbiVersion(): void {
  try {
    writeFileSync(getAbiVersionFile(), process.versions.modules, 'utf-8');
  } catch {
    // Non-critical, ignore
  }
}

/**
 * Check if the Node ABI version has changed since last successful run
 */
export function isAbiVersionChanged(): boolean {
  const stored = getStoredAbiVersion();
  if (!stored) return false; // First run, no stored version yet
  return stored !== process.versions.modules;
}

/**
 * Rebuild native modules (better-sqlite3, node-pty) for the current Node version
 */
export function rebuildNativeModules(): { success: boolean; error?: string } {
  const paths = getAgentPaths();

  try {
    execSync('npm rebuild better-sqlite3 @homebridge/node-pty-prebuilt-multiarch', {
      cwd: paths.cliRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}

/**
 * Ensure native modules are compatible with the current Node version.
 * Automatically rebuilds if a Node version change is detected.
 */
export async function ensureNativeModules(): Promise<PrerequisiteCheck> {
  const abiChanged = isAbiVersionChanged();

  if (!abiChanged) {
    // ABI hasn't changed (or first run) — verify modules load
    const check = await checkNativeDeps();
    if (check.status === 'ok') {
      storeAbiVersion();
      return check;
    }
    // Modules failed to load even without ABI change — fall through to rebuild
  }

  // ABI version changed or modules failed to load — try rebuild
  const rebuild = rebuildNativeModules();

  if (!rebuild.success) {
    return {
      name: 'Native modules',
      status: 'error',
      message: `Node version changed and rebuild failed: ${rebuild.error}. Try: npm install -g 247-cli`,
      required: true,
    };
  }

  // Verify modules load after rebuild
  const postCheck = await checkNativeDeps();

  if (postCheck.status === 'ok') {
    storeAbiVersion();
  }

  return postCheck;
}

// Aliases for backwards compatibility
export const checkNode = checkNodeVersion;
