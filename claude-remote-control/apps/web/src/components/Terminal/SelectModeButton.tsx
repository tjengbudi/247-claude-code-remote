'use client';

import { TextCursor, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SelectModeButtonProps {
  active: boolean;
  onToggle: () => void;
  /** Shift up when the keybar is visible, mirroring KeybarToggleButton. */
  keybarVisible: boolean;
}

/**
 * Floating button to toggle mobile text-selection mode. When active, finger
 * drags select terminal text (driven via xterm's selection API) instead of
 * scrolling. Sits just left of the keybar toggle.
 */
export function SelectModeButton({ active, onToggle, keybarVisible }: SelectModeButtonProps) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'absolute z-30',
        'flex items-center justify-center',
        'h-11 w-11 rounded-full',
        'backdrop-blur-sm transition-all duration-200',
        'touch-manipulation active:scale-95',
        active
          ? 'border border-orange-500/40 bg-orange-500/25 text-orange-300'
          : 'border border-white/10 bg-white/10 text-white/60 hover:bg-white/15 hover:text-white',
        // Position: bottom-right, one slot left of the keybar toggle.
        keybarVisible ? 'bottom-[116px] right-16' : 'bottom-4 right-16'
      )}
      aria-label={active ? 'Exit text selection' : 'Select text'}
      aria-pressed={active}
    >
      {active ? <Check className="h-5 w-5" /> : <TextCursor className="h-5 w-5" />}
    </button>
  );
}
