/**
 * Touch-selection magnifier ("loupe") for the terminal on mobile.
 *
 * On Android/iOS the OS shows a magnifying glass over a finger during native
 * text selection so the user can see where the caret lands under their fingertip.
 * Our selection is custom: xterm renders text as pixels into <canvas> via the
 * CanvasAddon (see lib/touchSelection), so the native loupe never fires — the
 * browser sees only an opaque canvas, not selectable text. We recreate it.
 *
 * The loupe is a fixed, circular, pointer-events:none overlay holding its own
 * canvas. On each finger move we copy the region of the xterm canvas layers
 * under the finger, scaled up by `zoom`, into the loupe, and float it just above
 * the fingertip so the finger never covers what it is pointing at.
 */

export interface MagnifierOptions {
  /** Diameter of the loupe in CSS px. */
  size?: number;
  /** Magnification factor applied to the captured region. */
  zoom?: number;
  /** Gap in CSS px between the fingertip and the nearest loupe edge. */
  gap?: number;
  /** Minimum distance the loupe keeps from any viewport edge (CSS px). */
  margin?: number;
  /** Fill painted before compositing, so transparent text cells show the terminal bg. */
  background?: string;
}

export interface MagnifierController {
  /** Composite the region under (clientX, clientY) and reveal the loupe above it. */
  show(clientX: number, clientY: number): void;
  /** Hide the loupe without tearing down its DOM. */
  hide(): void;
  /** Remove the loupe element entirely. */
  destroy(): void;
}

/**
 * Computes the top-left corner of the loupe box so it floats above the finger,
 * flipping below when there isn't room at the top and clamping to the viewport.
 *
 * Pure geometry — no DOM — so it is unit-testable in isolation.
 */
export function loupePlacement(
  clientX: number,
  clientY: number,
  size: number,
  gap: number,
  margin: number,
  viewportW: number,
  viewportH: number
): { left: number; top: number } {
  // Prefer floating above the fingertip (loupe bottom sits `gap` above it).
  let top = clientY - gap - size;
  // Not enough headroom → flip below the finger.
  if (top < margin) top = clientY + gap;
  // Still overflowing the bottom → pin within the viewport.
  if (top + size > viewportH - margin) {
    top = Math.max(margin, viewportH - margin - size);
  }

  let left = clientX - size / 2;
  left = Math.max(margin, Math.min(left, viewportW - size - margin));

  return { left, top };
}

export function createMagnifier(
  screenEl: HTMLElement,
  options: MagnifierOptions = {}
): MagnifierController {
  const size = options.size ?? 96;
  const zoom = options.zoom ?? 2;
  const gap = options.gap ?? 24;
  const margin = options.margin ?? 8;
  const background = options.background ?? '#0a0a10';

  let loupe: HTMLDivElement | null = null;
  let canvas: HTMLCanvasElement | null = null;

  const ensure = () => {
    if (loupe) return;
    const ratio = window.devicePixelRatio || 1;

    loupe = document.createElement('div');
    loupe.setAttribute('aria-hidden', 'true');
    Object.assign(loupe.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: '50%',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '40',
      background,
      border: '2px solid rgba(249, 115, 22, 0.6)',
      boxShadow: '0 2px 12px rgba(0, 0, 0, 0.5)',
      display: 'none',
    } as Partial<CSSStyleDeclaration>);

    canvas = document.createElement('canvas');
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    loupe.appendChild(canvas);
    document.body.appendChild(loupe);
  };

  const show = (clientX: number, clientY: number) => {
    ensure();
    if (!loupe || !canvas) return;
    const cv = canvas;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cv.width, cv.height);

    // CSS-px window captured around the fingertip; `zoom` enlarges it to fill.
    const srcCss = size / zoom;
    const half = srcCss / 2;

    // Composite every xterm canvas layer in DOM order to preserve stacking
    // (background/text/selection). Each layer's backing store is at its own
    // device-pixel scale, so map CSS coords into backing-store coords per layer.
    const layers = screenEl.querySelectorAll('canvas');
    layers.forEach((node) => {
      const layer = node as HTMLCanvasElement;
      if (!layer.width || !layer.height) return;
      const rect = layer.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const scaleX = layer.width / rect.width;
      const scaleY = layer.height / rect.height;
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;

      ctx.drawImage(
        layer,
        (localX - half) * scaleX,
        (localY - half) * scaleY,
        srcCss * scaleX,
        srcCss * scaleY,
        0,
        0,
        cv.width,
        cv.height
      );
    });

    const { left, top } = loupePlacement(
      clientX,
      clientY,
      size,
      gap,
      margin,
      window.innerWidth,
      window.innerHeight
    );
    loupe.style.left = `${left}px`;
    loupe.style.top = `${top}px`;
    loupe.style.display = 'block';
  };

  const hide = () => {
    if (loupe) loupe.style.display = 'none';
  };

  const destroy = () => {
    if (loupe?.parentNode) loupe.parentNode.removeChild(loupe);
    loupe = null;
    canvas = null;
  };

  return { show, hide, destroy };
}
