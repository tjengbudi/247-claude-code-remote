/**
 * Touch selection math tests.
 *
 * Pure coordinate -> cell and drag -> select(col,row,length) conversions used
 * to drive xterm selection from finger drags on mobile.
 */
import { describe, it, expect } from 'vitest';
import { cellFromPoint, selectionRange } from '@/components/Terminal/lib/touchSelection';

describe('cellFromPoint', () => {
  const cw = 10;
  const ch = 20;
  const cols = 80;
  const rows = 24;

  it('maps the origin to cell (0,0)', () => {
    expect(cellFromPoint(0, 0, cw, ch, cols, rows)).toEqual({ col: 0, row: 0 });
  });

  it('rounds X to the nearest column boundary', () => {
    // 24px -> 2.4 cells -> rounds to col 2
    expect(cellFromPoint(24, 0, cw, ch, cols, rows).col).toBe(2);
    // 26px -> 2.6 cells -> rounds to col 3
    expect(cellFromPoint(26, 0, cw, ch, cols, rows).col).toBe(3);
  });

  it('floors Y to the row the touch lands in', () => {
    // 59px -> 2.95 rows -> floor to row 2
    expect(cellFromPoint(0, 59, cw, ch, cols, rows).row).toBe(2);
  });

  it('clamps beyond the grid to the last valid cell', () => {
    const c = cellFromPoint(10_000, 10_000, cw, ch, cols, rows);
    expect(c.col).toBe(cols); // end-of-line allowed
    expect(c.row).toBe(rows - 1);
  });

  it('returns (0,0) for non-positive cell sizes', () => {
    expect(cellFromPoint(50, 50, 0, ch, cols, rows)).toEqual({ col: 0, row: 0 });
    expect(cellFromPoint(50, 50, cw, 0, cols, rows)).toEqual({ col: 0, row: 0 });
  });
});

describe('selectionRange', () => {
  const cols = 80;

  it('handles a forward single-row drag', () => {
    // row 5, col 3 -> col 10
    expect(selectionRange(3, 5, 10, 5, cols)).toEqual({ col: 3, row: 5, length: 7 });
  });

  it('normalises a backward drag to the lower anchor', () => {
    // dragging right-to-left yields the same range as left-to-right
    expect(selectionRange(10, 5, 3, 5, cols)).toEqual({ col: 3, row: 5, length: 7 });
  });

  it('spans multiple rows via a linear length', () => {
    // from (col 70, row 2) to (col 5, row 4)
    // lo = 2*80+70 = 230, hi = 4*80+5 = 325, length = 95
    expect(selectionRange(70, 2, 5, 4, cols)).toEqual({ col: 70, row: 2, length: 95 });
  });

  it('produces zero length when anchor equals current', () => {
    expect(selectionRange(12, 7, 12, 7, cols)).toEqual({ col: 12, row: 7, length: 0 });
  });
});
