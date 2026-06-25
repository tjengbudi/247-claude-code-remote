/**
 * Right-click handler tests.
 *
 * We want the tmux (terminal-native) menu to appear on right-click, not the
 * browser's. So the handler suppresses ONLY the browser's native menu via
 * preventDefault and leaves the right-button mousedown to propagate to xterm
 * (which forwards it to the PTY → tmux shows its own menu).
 */
import { describe, it, expect, vi } from 'vitest';
import { createRightClickHandlers } from '@/components/Terminal/lib/rightClick';

function makeMouseEvent() {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

describe('createRightClickHandlers', () => {
  it('suppresses the browser menu via preventDefault', () => {
    const { onContextMenu } = createRightClickHandlers();
    const e = makeMouseEvent();
    onContextMenu(e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('does NOT stop propagation, so xterm still forwards to tmux', () => {
    const { onContextMenu } = createRightClickHandlers();
    const e = makeMouseEvent();
    onContextMenu(e);
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });
});
