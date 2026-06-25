'use client';

import { useEffect, useRef, useState } from 'react';

interface PasteBoxProps {
  /** When true, render the focused capture field. */
  open: boolean;
  /** Called with pasted text once the user commits it. */
  onText: (text: string) => void;
  /** Called to dismiss the box (committed, cancelled, or backdrop tap). */
  onClose: () => void;
}

/**
 * Fallback paste UI for non-secure contexts (plain HTTP over LAN), where
 * navigator.clipboard.readText() is unavailable. Reading the clipboard
 * programmatically is impossible there, so instead we focus a real input and
 * let the user trigger the OS paste action (long-press → Paste on mobile,
 * Ctrl/Cmd+V on desktop). The pasted text is captured and forwarded to the
 * terminal.
 *
 * Three commit paths, all routed through commit():
 *  - onPaste: fires on most browsers when the OS paste lands.
 *  - onChange guard: Android IMEs sometimes skip onPaste; a value jumping to
 *    >1 char in one event signals a paste rather than single-key typing.
 *  - explicit "Insert" button: always available as a manual fallback.
 */
export function PasteBox({ open, onText, onClose }: PasteBoxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState('');

  // Focus the field as soon as it opens so the OS paste menu targets it, and
  // reset any stale value from a previous open.
  useEffect(() => {
    if (open) {
      setValue('');
      // Defer focus to after paint so mobile keyboards reliably attach.
      const id = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [open]);

  if (!open) return null;

  const commit = (text: string) => {
    if (text) onText(text);
    setValue('');
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-white/10 bg-[#0d0d14] p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 text-sm text-white/80">Paste here</p>
        <p className="mb-3 text-xs text-white/50">
          Long-press the field and tap Paste (or press Ctrl/Cmd+V), then Insert.
        </p>
        <textarea
          ref={inputRef}
          value={value}
          rows={3}
          aria-label="Paste text to send to terminal"
          className="w-full resize-none rounded-lg border border-white/10 bg-black/40 p-2 font-mono text-sm text-white/90 outline-none focus:border-orange-500/50"
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (text) {
              e.preventDefault();
              commit(text);
            }
          }}
          onChange={(e) => {
            const next = e.target.value;
            // A jump to multiple characters in a single change is a paste that
            // bypassed onPaste (some Android IMEs). Single-char changes are
            // manual typing — let those accumulate until the user taps Insert.
            if (next.length > 1 && value.length === 0) {
              commit(next);
            } else {
              setValue(next);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-white/60 hover:bg-white/5 hover:text-white/90"
          >
            Cancel
          </button>
          <button
            onClick={() => commit(value)}
            disabled={!value}
            className="rounded-lg bg-orange-500/20 px-4 py-1.5 text-sm text-orange-400 hover:bg-orange-500/30 disabled:opacity-40"
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
