/**
 * Touch-selection magnifier tests.
 *
 * Two concerns:
 *  - loupePlacement: pure geometry positioning the loupe above the finger,
 *    flipping below and clamping to the viewport when there is no room.
 *  - createMagnifier: DOM lifecycle (lazy create on show, hide, destroy) and
 *    that compositing the xterm canvas layers does not throw under happy-dom.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loupePlacement, createMagnifier } from '@/components/Terminal/lib/magnifier';

describe('loupePlacement', () => {
  const size = 140;
  const gap = 24;
  const margin = 8;
  const vw = 400;
  const vh = 800;

  it('floats above the fingertip when there is headroom', () => {
    const { top } = loupePlacement(200, 500, size, gap, margin, vw, vh);
    // 500 - 24 - 140 = 336
    expect(top).toBe(336);
  });

  it('centres horizontally on the finger', () => {
    const { left } = loupePlacement(200, 500, size, gap, margin, vw, vh);
    // 200 - 70 = 130
    expect(left).toBe(130);
  });

  it('flips below the finger when there is no headroom at the top', () => {
    const { top } = loupePlacement(200, 30, size, gap, margin, vw, vh);
    // 30 - 24 - 140 = -134 < margin → flip to 30 + 24 = 54
    expect(top).toBe(54);
  });

  it('clamps the left edge to the viewport margin', () => {
    const { left } = loupePlacement(10, 500, size, gap, margin, vw, vh);
    expect(left).toBe(margin);
  });

  it('clamps the right edge to the viewport margin', () => {
    const { left } = loupePlacement(395, 500, size, gap, margin, vw, vh);
    // vw - size - margin = 400 - 140 - 8 = 252
    expect(left).toBe(252);
  });

  it('pins within the viewport when neither above nor below fits', () => {
    const shortVh = 150;
    const { top } = loupePlacement(200, 80, size, gap, margin, vw, shortVh);
    // flips below to 104, but 104 + 140 = 244 > 150 - 8 → pin to max(8, 150-8-140)=8
    expect(top).toBe(margin);
  });
});

describe('createMagnifier', () => {
  let screen: HTMLElement;

  beforeEach(() => {
    // happy-dom has no 2D canvas backend; stub a no-op context so the loupe's
    // own canvas can be drawn into. Returns a Proxy whose every method is a noop.
    const stubCtx = new Proxy(
      {},
      { get: () => () => undefined }
    ) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(stubCtx);

    document.body.innerHTML = '';
    screen = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 480;
    // happy-dom canvases report 0x0 via getBoundingClientRect by default; stub it.
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 240, right: 400, bottom: 240, x: 0, y: 0, toJSON() {} }) as DOMRect;
    screen.appendChild(canvas);
    document.body.appendChild(screen);
  });

  it('does not attach the loupe element until show() is called', () => {
    createMagnifier(screen);
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('creates and reveals the loupe on show()', () => {
    const m = createMagnifier(screen);
    m.show(100, 100);
    const loupe = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(loupe).not.toBeNull();
    expect(loupe.style.display).toBe('block');
    expect(loupe.querySelector('canvas')).not.toBeNull();
  });

  it('hides the loupe without removing it', () => {
    const m = createMagnifier(screen);
    m.show(100, 100);
    m.hide();
    const loupe = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(loupe).not.toBeNull();
    expect(loupe.style.display).toBe('none');
  });

  it('reuses a single loupe element across repeated show() calls', () => {
    const m = createMagnifier(screen);
    m.show(100, 100);
    m.show(120, 130);
    expect(document.querySelectorAll('[aria-hidden="true"]').length).toBe(1);
  });

  it('removes the loupe element on destroy()', () => {
    const m = createMagnifier(screen);
    m.show(100, 100);
    m.destroy();
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('tolerates zero-sized canvas layers without throwing', () => {
    const empty = document.createElement('canvas');
    empty.width = 0;
    empty.height = 0;
    screen.appendChild(empty);
    const m = createMagnifier(screen);
    expect(() => m.show(50, 50)).not.toThrow();
  });
});
