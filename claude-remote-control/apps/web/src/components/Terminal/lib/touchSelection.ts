/**
 * Touch-driven text selection math for the terminal on mobile.
 *
 * xterm's SelectionService only binds mouse events, and with the CanvasAddon
 * the text is rendered as pixels (no DOM text nodes), so neither native
 * long-press selection nor xterm's own selection engine ever fires on a finger
 * drag. Instead we map touch coordinates to terminal cells and drive selection
 * programmatically via term.select(column, row, length).
 *
 * term.select() takes a single anchor (column, row) plus a linear length that
 * wraps across rows, so an arbitrary (col,row)->(col,row) range is expressed by
 * converting both endpoints to a linear offset, taking the lower as the anchor,
 * and using the difference as the length.
 */

export interface Cell {
  /** Column 0..cols (cols allowed = end of line). */
  col: number;
  /** Row relative to the viewport top, 0..rows-1. */
  row: number;
}

/**
 * Maps a point within the terminal screen element to a cell.
 *
 * @param offsetX  X relative to the screen element's left edge (px).
 * @param offsetY  Y relative to the screen element's top edge (px).
 * @param cellWidth   Pixel width of one cell (screenWidth / cols).
 * @param cellHeight  Pixel height of one cell (screenHeight / rows).
 */
export function cellFromPoint(
  offsetX: number,
  offsetY: number,
  cellWidth: number,
  cellHeight: number,
  cols: number,
  rows: number
): Cell {
  if (cellWidth <= 0 || cellHeight <= 0) return { col: 0, row: 0 };
  // Round X so the user can land on a character boundary (incl. end-of-line);
  // floor Y so a touch anywhere within a row picks that row.
  const col = Math.max(0, Math.min(cols, Math.round(offsetX / cellWidth)));
  const row = Math.max(0, Math.min(rows - 1, Math.floor(offsetY / cellHeight)));
  return { col, row };
}

export interface SelectArgs {
  col: number;
  row: number;
  length: number;
}

/**
 * Builds term.select(column, row, length) arguments for a drag between an
 * anchor cell and the current cell. Row indices are ABSOLUTE buffer lines
 * (viewportY + relative row), so selection survives scrollback positioning.
 */
export function selectionRange(
  anchorCol: number,
  anchorRowAbs: number,
  curCol: number,
  curRowAbs: number,
  cols: number
): SelectArgs {
  const aLinear = anchorRowAbs * cols + anchorCol;
  const cLinear = curRowAbs * cols + curCol;
  const lo = Math.min(aLinear, cLinear);
  const hi = Math.max(aLinear, cLinear);
  return {
    col: lo % cols,
    row: Math.floor(lo / cols),
    length: hi - lo,
  };
}
