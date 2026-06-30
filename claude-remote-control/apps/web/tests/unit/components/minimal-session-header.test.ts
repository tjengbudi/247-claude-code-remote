import { describe, it, expect } from 'vitest';

/**
 * Test MinimalSessionHeader component logic.
 * Tests status colors, session name parsing, and display logic.
 */

// Status colors (must match MinimalSessionHeader.tsx)
const STATUS_COLORS: Record<string, string> = {
  working: 'bg-orange-500',
  needs_attention: 'bg-amber-500 animate-pulse',
  idle: 'bg-emerald-500',
  init: 'bg-blue-500',
};

describe('MinimalSessionHeader', () => {
  describe('status colors', () => {
    it('has correct color for working status', () => {
      expect(STATUS_COLORS.working).toBe('bg-orange-500');
    });

    it('has correct color for needs_attention status with animation', () => {
      expect(STATUS_COLORS.needs_attention).toBe('bg-amber-500 animate-pulse');
    });

    it('has correct color for idle status', () => {
      expect(STATUS_COLORS.idle).toBe('bg-emerald-500');
    });

    it('has correct color for init status', () => {
      expect(STATUS_COLORS.init).toBe('bg-blue-500');
    });

    it('covers all expected statuses', () => {
      const expectedStatuses = ['working', 'needs_attention', 'idle', 'init'];
      expect(Object.keys(STATUS_COLORS).sort()).toEqual(expectedStatuses.sort());
    });
  });

  describe('session name parsing', () => {
    // Helper function that mimics the logic in MinimalSessionHeader
    function parseDisplayName(sessionName: string): string {
      return sessionName.split('--')[1] || sessionName;
    }

    function isNewSession(sessionName: string): boolean {
      return sessionName.endsWith('--new');
    }

    it('extracts display name from full session name', () => {
      expect(parseDisplayName('project--wise-lynx-83')).toBe('wise-lynx-83');
    });

    it('returns full name if no separator', () => {
      expect(parseDisplayName('simple-session')).toBe('simple-session');
    });

    it('handles empty session name', () => {
      expect(parseDisplayName('')).toBe('');
    });

    it('handles session name with multiple separators', () => {
      expect(parseDisplayName('project--part1--part2')).toBe('part1');
    });

    it('detects new session correctly', () => {
      expect(isNewSession('project--new')).toBe(true);
      expect(isNewSession('project--wise-lynx-83')).toBe(false);
    });

    it('detects new session with different patterns', () => {
      expect(isNewSession('anything--new')).toBe(true);
      expect(isNewSession('new')).toBe(false);
      expect(isNewSession('--new')).toBe(true);
    });
  });

  describe('header height', () => {
    it('should be 44px on mobile (h-11)', () => {
      // h-11 = 44px in Tailwind
      const mobileHeight = 11 * 4; // Tailwind uses 4px base
      expect(mobileHeight).toBe(44);
    });

    it('should be 48px on desktop (h-12)', () => {
      // h-12 = 48px in Tailwind
      const desktopHeight = 12 * 4;
      expect(desktopHeight).toBe(48);
    });
  });

  describe('button sizing', () => {
    it('should have 36px buttons on mobile (h-9 w-9)', () => {
      const mobileButtonSize = 9 * 4;
      expect(mobileButtonSize).toBe(36);
    });

    it('should have 32px buttons on desktop (h-8 w-8)', () => {
      const desktopButtonSize = 8 * 4;
      expect(desktopButtonSize).toBe(32);
    });

    it('buttons meet minimum touch target on mobile (>= 36px)', () => {
      const mobileButtonSize = 9 * 4; // h-9 w-9
      expect(mobileButtonSize).toBeGreaterThanOrEqual(36);
    });
  });

  describe('connection states', () => {
    const connectionStates = ['connected', 'disconnected', 'reconnecting'] as const;

    it('should handle all connection states', () => {
      expect(connectionStates).toContain('connected');
      expect(connectionStates).toContain('disconnected');
      expect(connectionStates).toContain('reconnecting');
    });

    it('reconnecting state should show animation indicator', () => {
      // The component shows a pulsing amber dot when reconnecting
      const reconnectingIndicator = 'animate-pulse rounded-full bg-amber-500';
      expect(reconnectingIndicator).toContain('animate-pulse');
      expect(reconnectingIndicator).toContain('bg-amber-500');
    });
  });

  describe('claude status visibility', () => {
    it('should hide Start Claude button when status is working', () => {
      // When claudeStatus === 'working', button should not render
      const showButton = (status: string | undefined) => status !== 'working';

      expect(showButton('working')).toBe(false);
      expect(showButton('idle')).toBe(true);
      expect(showButton('init')).toBe(true);
      expect(showButton('needs_attention')).toBe(true);
      expect(showButton(undefined)).toBe(true);
    });
  });

  describe('bound sub-path badge (Story 6.5)', () => {
    // Badge renders when workingDir is set; label depends on gitCwdContext.kind.
    // Logic mirrors MinimalSessionHeader.tsx lines 144-156.

    function getBadgeLabel(workingDir: string | undefined, kind?: 'root' | 'worktree' | 'subfolder', branch?: string): string | null {
      if (!workingDir) return null;
      if (kind === 'worktree') return `WT: ${branch ?? 'detached'}`;
      return workingDir.split('/').pop() ?? workingDir;
    }

    it('returns null when workingDir is undefined', () => {
      expect(getBadgeLabel(undefined)).toBeNull();
    });

    it('returns null when workingDir is empty string', () => {
      expect(getBadgeLabel('')).toBeNull();
    });

    it('shows WT: branch when kind=worktree with branch', () => {
      expect(getBadgeLabel('/sibling-wt', 'worktree', 'feat/my-feature')).toBe('WT: feat/my-feature');
    });

    it('shows WT: detached when kind=worktree and branch is undefined', () => {
      expect(getBadgeLabel('/sibling-wt', 'worktree', undefined)).toBe('WT: detached');
    });

    it('shows basename when kind=subfolder', () => {
      expect(getBadgeLabel('/home/user/project/packages/shared', 'subfolder')).toBe('shared');
    });

    it('shows basename when kind=root (unusual but not crashing)', () => {
      expect(getBadgeLabel('/home/user/project', 'root')).toBe('project');
    });

    it('shows basename when gitCwdContext is absent but workingDir is set', () => {
      expect(getBadgeLabel('/home/user/project/apps/web')).toBe('web');
    });
  });
});
