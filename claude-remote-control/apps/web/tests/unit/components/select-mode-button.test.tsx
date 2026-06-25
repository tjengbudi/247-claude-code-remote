/**
 * SelectModeButton tests — the floating toggle that switches finger drags
 * between scrolling and text selection on mobile.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SelectModeButton } from '@/components/Terminal/SelectModeButton';

afterEach(cleanup);

describe('SelectModeButton', () => {
  it('labels itself for entering selection when inactive', () => {
    render(<SelectModeButton active={false} onToggle={vi.fn()} keybarVisible={false} />);
    const btn = screen.getByRole('button', { name: 'Select text' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('labels itself for exiting selection when active', () => {
    render(<SelectModeButton active onToggle={vi.fn()} keybarVisible={false} />);
    const btn = screen.getByRole('button', { name: 'Exit text selection' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('fires onToggle when tapped', () => {
    const onToggle = vi.fn();
    render(<SelectModeButton active={false} onToggle={onToggle} keybarVisible={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shifts up when the keybar is visible', () => {
    const { rerender } = render(
      <SelectModeButton active={false} onToggle={vi.fn()} keybarVisible={false} />
    );
    expect(screen.getByRole('button').className).toContain('bottom-4');

    rerender(<SelectModeButton active={false} onToggle={vi.fn()} keybarVisible />);
    expect(screen.getByRole('button').className).toContain('bottom-[116px]');
  });
});
