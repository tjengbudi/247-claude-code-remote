/**
 * Right-click handler tests.
 *
 * PuTTY-style behaviour: right-click copies the selection if there is one,
 * otherwise opens the paste flow. Both handlers suppress the default/forwarded
 * behaviour so neither the browser nor tmux pops a context menu.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRightClickHandlers, type RightClickDeps } from '@/components/Terminal/lib/rightClick';

function makeMouseEvent(button: number) {
  return {
    button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as MouseEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

describe('createRightClickHandlers', () => {
  let deps: {
    getSelection: ReturnType<typeof vi.fn>;
    writeClipboard: ReturnType<typeof vi.fn>;
    onCopySuccess: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
    onRequestPaste: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    deps = {
      getSelection: vi.fn().mockReturnValue(''),
      writeClipboard: vi.fn().mockResolvedValue(true),
      onCopySuccess: vi.fn(),
      clearSelection: vi.fn(),
      onRequestPaste: vi.fn(),
    };
  });

  describe('onContextMenu', () => {
    it('always suppresses the browser + tmux menus', () => {
      const { onContextMenu } = createRightClickHandlers(deps as unknown as RightClickDeps);
      const e = makeMouseEvent(2);
      onContextMenu(e);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(e.stopPropagation).toHaveBeenCalled();
    });

    it('copies and clears the selection when one exists', async () => {
      deps.getSelection.mockReturnValue('hello world');
      const { onContextMenu } = createRightClickHandlers(deps as unknown as RightClickDeps);

      onContextMenu(makeMouseEvent(2));
      await vi.waitFor(() => expect(deps.onCopySuccess).toHaveBeenCalled());

      expect(deps.writeClipboard).toHaveBeenCalledWith('hello world');
      expect(deps.clearSelection).toHaveBeenCalled();
      expect(deps.onRequestPaste).not.toHaveBeenCalled();
    });

    it('does not flash copied when the clipboard write fails', async () => {
      deps.getSelection.mockReturnValue('hello');
      deps.writeClipboard.mockResolvedValue(false);
      const { onContextMenu } = createRightClickHandlers(deps as unknown as RightClickDeps);

      onContextMenu(makeMouseEvent(2));
      await Promise.resolve();
      await Promise.resolve();

      expect(deps.onCopySuccess).not.toHaveBeenCalled();
    });

    it('requests paste when there is no selection', () => {
      deps.getSelection.mockReturnValue('');
      const { onContextMenu } = createRightClickHandlers(deps as unknown as RightClickDeps);

      onContextMenu(makeMouseEvent(2));

      expect(deps.onRequestPaste).toHaveBeenCalled();
      expect(deps.writeClipboard).not.toHaveBeenCalled();
      expect(deps.clearSelection).not.toHaveBeenCalled();
    });
  });

  describe('onMouseDownCapture', () => {
    it('swallows the right button so tmux gets no SGR report', () => {
      const { onMouseDownCapture } = createRightClickHandlers(deps as unknown as RightClickDeps);
      const e = makeMouseEvent(2);
      onMouseDownCapture(e);
      expect(e.stopPropagation).toHaveBeenCalled();
    });

    it('leaves left/middle clicks untouched', () => {
      const { onMouseDownCapture } = createRightClickHandlers(deps as unknown as RightClickDeps);
      const left = makeMouseEvent(0);
      const middle = makeMouseEvent(1);
      onMouseDownCapture(left);
      onMouseDownCapture(middle);
      expect(left.stopPropagation).not.toHaveBeenCalled();
      expect(middle.stopPropagation).not.toHaveBeenCalled();
    });
  });
});
