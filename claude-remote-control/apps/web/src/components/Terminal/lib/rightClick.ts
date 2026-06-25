/**
 * Right-click (context menu) handling for the terminal.
 *
 * With `tmux mouse on`, xterm forwards the right-button mousedown to the PTY as
 * an SGR mouse report, so tmux pops its OWN context menu. The browser ALSO pops
 * its native context menu on the same click — two stacked menus.
 *
 * We want the tmux menu only (the terminal-native one), so we leave the
 * mousedown alone (xterm still forwards it → tmux menu appears) and merely
 * suppress the browser's native menu via preventDefault on the contextmenu
 * event.
 */

export interface RightClickHandlers {
  /** Attach to the terminal element for the `contextmenu` event. */
  onContextMenu: (e: MouseEvent) => void;
}

export function createRightClickHandlers(): RightClickHandlers {
  const onContextMenu = (e: MouseEvent) => {
    // Suppress ONLY the browser's native menu. The right-button mousedown is
    // left to propagate so xterm forwards it to the PTY and tmux shows its own
    // menu — the single menu we want.
    e.preventDefault();
  };

  return { onContextMenu };
}
