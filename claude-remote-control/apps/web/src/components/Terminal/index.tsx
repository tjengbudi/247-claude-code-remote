'use client';

import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { generateSessionName } from './constants';
import { SearchBar } from './SearchBar';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { MobileKeybar } from './MobileKeybar';
import { KeybarToggleButton } from './KeybarToggleButton';
import { PasteBox } from './PasteBox';
import { SelectModeButton } from './SelectModeButton';
import { readClipboard } from '@/lib/clipboard';
import { useTerminalConnection, useTerminalSearch } from './hooks';
import { useKeybarVisibility } from '@/hooks/useKeybarVisibility';
import { MinimalSessionHeader } from '@/components/MinimalSessionHeader';
import type { GitCwdContext } from '247-shared';

interface TerminalProps {
  agentUrl: string;
  agentToken?: string;
  project: string;
  sessionName?: string;
  environmentId?: string;
  planningProjectId?: string;
  onConnectionChange?: (connected: boolean) => void;
  onSessionCreated?: (sessionName: string) => void;
  /** Callback when menu button is clicked (opens sidebar) */
  onMenuClick: () => void;
  /** Mobile mode for responsive styling and smaller font */
  isMobile?: boolean;
  /** Web user id of the current viewer — tags newly-created sessions for per-user isolation. */
  owner?: string;
  // StatusLine metrics
  model?: string;
  costUsd?: number;
  /** Bound sub-path (worktree or subfolder) — session's cwd (Story 6.5) */
  workingDir?: string;
  /** Classified git context for bound path — kind, branch, boundPath (Story 6.5) */
  gitCwdContext?: GitCwdContext;
  /** Human-readable label supplied at create time (v21), sent as a WS query param. */
  description?: string;
}

export function Terminal({
  agentUrl,
  agentToken,
  project,
  sessionName,
  environmentId,
  planningProjectId,
  onConnectionChange,
  onSessionCreated,
  onMenuClick,
  isMobile = false,
  owner,
  model,
  costUsd,
  workingDir,
  gitCwdContext,
  description,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [pasteBoxOpen, setPasteBoxOpen] = useState(false);
  const { isVisible: keybarVisible, toggle: toggleKeybar } = useKeybarVisibility();

  // Generate session name ONCE on first render, persisted across re-mounts
  const generatedSessionRef = useRef<string | null>(null);
  if (!sessionName && !generatedSessionRef.current) {
    generatedSessionRef.current = generateSessionName(project);
  }
  const effectiveSessionName = sessionName || generatedSessionRef.current || '';

  const handleCopySuccess = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const {
    connected,
    connectionState,
    isAtBottom,
    xtermRef,
    searchAddonRef,
    scrollToBottom,
    copySelection,
    startClaude,
    sendInput,
    triggerResize,
    selectMode,
    toggleSelectMode,
  } = useTerminalConnection({
    terminalRef,
    agentUrl,
    token: agentToken,
    project,
    sessionName: effectiveSessionName,
    environmentId,
    planningProjectId,
    onSessionCreated,
    onCopySuccess: handleCopySuccess,
    isMobile,
    owner,
    workingDir,
    description,
  });

  // Handle paste from clipboard (mobile header button).
  // readClipboard works in a secure context (HTTPS / installed PWA); over plain
  // HTTP it returns null, so we fall back to the PasteBox native-paste field.
  const handlePaste = async () => {
    const text = await readClipboard();
    if (text) {
      sendInput(text);
      return;
    }
    setPasteBoxOpen(true);
  };

  const {
    searchVisible,
    searchQuery,
    setSearchQuery,
    searchInputRef,
    toggleSearch,
    closeSearch,
    findNext,
    findPrevious,
  } = useTerminalSearch(searchAddonRef, xtermRef);

  // Notify parent of connection changes
  useEffect(() => {
    onConnectionChange?.(connected);
  }, [connected, onConnectionChange]);

  // Trigger terminal resize when keybar visibility changes (mobile only)
  useEffect(() => {
    if (!isMobile) return;
    // Small delay to allow CSS transition to start
    const timer = setTimeout(() => {
      triggerResize();
    }, 50);
    return () => clearTimeout(timer);
  }, [keybarVisible, isMobile, triggerResize]);

  return (
    <div className="relative flex w-full flex-1 flex-col overflow-hidden">
      <MinimalSessionHeader
        sessionName={effectiveSessionName}
        connectionState={connectionState}
        connected={connected}
        copied={copied}
        searchVisible={searchVisible}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
        onStartClaude={startClaude}
        onCopySelection={copySelection}
        onPaste={isMobile ? handlePaste : undefined}
        onToggleSearch={toggleSearch}
        model={model}
        costUsd={costUsd}
        workingDir={workingDir}
        gitCwdContext={gitCwdContext}
      />

      <SearchBar
        ref={searchInputRef}
        visible={searchVisible}
        query={searchQuery}
        onQueryChange={setSearchQuery}
        onFindNext={findNext}
        onFindPrevious={findPrevious}
        onClose={closeSearch}
      />

      {/* Terminal container - NO padding! FitAddon reads offsetHeight which includes padding,
          but xterm renders inside padding box, causing dimension mismatch */}
      {/* touch-action: none is CRITICAL for mobile - prevents browser from intercepting touch events */}
      <div
        ref={terminalRef}
        className="min-h-0 w-full flex-1 overflow-hidden bg-[#0a0a10]"
        style={isMobile ? { touchAction: 'none' } : undefined}
      />

      <ScrollToBottomButton visible={!isAtBottom} onClick={scrollToBottom} />

      <PasteBox
        open={pasteBoxOpen}
        onText={(t) => sendInput(t)}
        onClose={() => setPasteBoxOpen(false)}
      />

      {/* Mobile: selection toggle, keybar toggle, and virtual keyboard */}
      {isMobile && (
        <>
          <SelectModeButton
            active={selectMode}
            onToggle={toggleSelectMode}
            keybarVisible={keybarVisible}
          />
          <KeybarToggleButton isVisible={keybarVisible} onToggle={toggleKeybar} />
          <MobileKeybar onKeyPress={sendInput} visible={keybarVisible} />
          {/* While selecting, surface a Copy action that reuses the desktop copy
              path (clipboard write with HTTP fallback). */}
          {selectMode && (
            <button
              onClick={copySelection}
              className="absolute left-1/2 z-30 -translate-x-1/2 rounded-full border border-orange-500/40 bg-orange-500/25 px-5 py-2 text-sm font-medium text-orange-200 backdrop-blur-sm active:scale-95"
              style={{ bottom: keybarVisible ? 124 : 16 }}
            >
              {copied ? 'Copied' : 'Copy selection'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
