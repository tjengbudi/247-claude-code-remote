/**
 * Clipboard helper tests.
 *
 * Covers both the secure-context async Clipboard API path and the plain-HTTP
 * fallbacks (execCommand for write, null for read).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeClipboard, readClipboard } from '@/lib/clipboard';

// Helpers to toggle the global flags the helpers branch on.
function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', {
    value,
    configurable: true,
    writable: true,
  });
}

function setClipboard(clipboard: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    value: clipboard,
    configurable: true,
    writable: true,
  });
}

describe('clipboard', () => {
  const originalExecCommand = document.execCommand;

  beforeEach(() => {
    setSecureContext(true);
    setClipboard(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.execCommand = originalExecCommand;
    setClipboard(undefined);
  });

  describe('writeClipboard', () => {
    it('returns false for empty text without touching the DOM', async () => {
      const exec = vi.fn();
      document.execCommand = exec;
      const writeText = vi.fn();
      setClipboard({ writeText });

      expect(await writeClipboard('')).toBe(false);
      expect(writeText).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    });

    it('uses the async Clipboard API in a secure context', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      setClipboard({ writeText });

      expect(await writeClipboard('hello')).toBe(true);
      expect(writeText).toHaveBeenCalledWith('hello');
    });

    it('falls back to execCommand when writeText rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('denied'));
      setClipboard({ writeText });
      const exec = vi.fn().mockReturnValue(true);
      document.execCommand = exec;

      expect(await writeClipboard('hello')).toBe(true);
      expect(exec).toHaveBeenCalledWith('copy');
    });

    it('uses execCommand fallback in a non-secure context', async () => {
      setSecureContext(false);
      const writeText = vi.fn();
      setClipboard({ writeText });
      const exec = vi.fn().mockReturnValue(true);
      document.execCommand = exec;

      expect(await writeClipboard('hello')).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledWith('copy');
    });

    it('returns false when execCommand reports failure', async () => {
      setSecureContext(false);
      const exec = vi.fn().mockReturnValue(false);
      document.execCommand = exec;

      expect(await writeClipboard('hello')).toBe(false);
    });

    it('cleans up the temporary textarea after fallback copy', async () => {
      setSecureContext(false);
      document.execCommand = vi.fn().mockReturnValue(true);

      await writeClipboard('hello');
      expect(document.querySelectorAll('textarea').length).toBe(0);
    });
  });

  describe('readClipboard', () => {
    it('reads via the async Clipboard API in a secure context', async () => {
      const readText = vi.fn().mockResolvedValue('pasted');
      setClipboard({ readText });

      expect(await readClipboard()).toBe('pasted');
    });

    it('returns null in a non-secure context', async () => {
      setSecureContext(false);
      const readText = vi.fn();
      setClipboard({ readText });

      expect(await readClipboard()).toBeNull();
      expect(readText).not.toHaveBeenCalled();
    });

    it('returns null when readText rejects', async () => {
      const readText = vi.fn().mockRejectedValue(new Error('denied'));
      setClipboard({ readText });

      expect(await readClipboard()).toBeNull();
    });

    it('returns null when the Clipboard API is absent', async () => {
      setClipboard(undefined);
      expect(await readClipboard()).toBeNull();
    });
  });
});
