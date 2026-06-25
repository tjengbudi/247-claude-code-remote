/**
 * Right-click (context menu) handling for the terminal, PuTTY-style.
 *
 * With `tmux mouse on`, xterm forwards the right-button mousedown to the PTY as
 * an SGR mouse report, so tmux pops its OWN context menu on top of the
 * browser's — two stacked menus. We suppress both and instead:
 *   - copy the current selection if there is one, else
 *   - open the paste flow.
 *
 * The mousedown handler runs in the CAPTURE phase to swallow button 2 before
 * xterm's bubble-phase forwarder (on the inner screen element) can send the SGR
 * report to tmux. The contextmenu handler suppresses the browser menu and does
 * the actual work.
 */

export interface RightClickDeps {
  /** Current terminal selection text ('' when nothing is selected). */
  getSelection: () => string;
  /** Writes text to the clipboard; resolves true on success. */
  writeClipboard: (text: string) => Promise<boolean>;
  /** Called after a successful copy (e.g. to flash the copied indicator). */
  onCopySuccess: () => void;
  /** Clears the terminal selection after copying. */
  clearSelection: () => void;
  /** Opens the paste flow when there is nothing to copy. */
  onRequestPaste: () => void;
}

export interface RightClickHandlers {
  /** Attach to the terminal element for the `contextmenu` event (capture). */
  onContextMenu: (e: MouseEvent) => void;
  /** Attach to the terminal element for the `mousedown` event (capture). */
  onMouseDownCapture: (e: MouseEvent) => void;
}

export function createRightClickHandlers(deps: RightClickDeps): RightClickHandlers {
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const selection = deps.getSelection();
    if (selection) {
      void deps.writeClipboard(selection).then((ok) => {
        if (ok) deps.onCopySuccess();
      });
      deps.clearSelection();
    } else {
      deps.onRequestPaste();
    }
  };

  const onMouseDownCapture = (e: MouseEvent) => {
    // Stop the right-button mousedown from reaching xterm's forwarder, so no
    // SGR report is sent to tmux and no tmux menu appears. The contextmenu
    // handler does the actual work.
    if (e.button === 2) e.stopPropagation();
  };

  return { onContextMenu, onMouseDownCapture };
}
