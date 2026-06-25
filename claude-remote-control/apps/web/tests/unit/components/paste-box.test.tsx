/**
 * PasteBox tests.
 *
 * PasteBox is the non-secure-context fallback for pasting: it focuses a real
 * field and lets the OS paste action populate it. Three commit paths:
 *  - onPaste event
 *  - onChange guard (multi-char jump = Android IME paste)
 *  - explicit Insert button
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PasteBox } from '@/components/Terminal/PasteBox';

afterEach(cleanup);

describe('PasteBox', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <PasteBox open={false} onText={vi.fn()} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('commits and closes on a paste event', () => {
    const onText = vi.fn();
    const onClose = vi.fn();
    render(<PasteBox open onText={onText} onClose={onClose} />);

    const field = screen.getByLabelText('Paste text to send to terminal');
    fireEvent.paste(field, {
      clipboardData: { getData: () => 'pasted text' },
    });

    expect(onText).toHaveBeenCalledWith('pasted text');
    expect(onClose).toHaveBeenCalled();
  });

  it('commits on a multi-character onChange (IME paste without onPaste)', () => {
    const onText = vi.fn();
    const onClose = vi.fn();
    render(<PasteBox open onText={onText} onClose={onClose} />);

    const field = screen.getByLabelText('Paste text to send to terminal');
    fireEvent.change(field, { target: { value: 'multi char paste' } });

    expect(onText).toHaveBeenCalledWith('multi char paste');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not auto-commit single-character typing', () => {
    const onText = vi.fn();
    const onClose = vi.fn();
    render(<PasteBox open onText={onText} onClose={onClose} />);

    const field = screen.getByLabelText('Paste text to send to terminal');
    fireEvent.change(field, { target: { value: 'a' } });

    expect(onText).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('commits typed text via the Insert button', () => {
    const onText = vi.fn();
    const onClose = vi.fn();
    render(<PasteBox open onText={onText} onClose={onClose} />);

    const field = screen.getByLabelText('Paste text to send to terminal');
    fireEvent.change(field, { target: { value: 'x' } });
    fireEvent.click(screen.getByText('Insert'));

    expect(onText).toHaveBeenCalledWith('x');
    expect(onClose).toHaveBeenCalled();
  });

  it('Insert is disabled until there is text', () => {
    render(<PasteBox open onText={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByText('Insert') as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes without committing on Cancel', () => {
    const onText = vi.fn();
    const onClose = vi.fn();
    render(<PasteBox open onText={onText} onClose={onClose} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(onText).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(<PasteBox open onText={vi.fn()} onClose={onClose} />);

    const field = screen.getByLabelText('Paste text to send to terminal');
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
