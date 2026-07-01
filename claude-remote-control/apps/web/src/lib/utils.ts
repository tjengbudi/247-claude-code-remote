import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Strip protocol (http://, https://, ws://, wss://) from a URL
 * Returns just the host:port/path portion
 */
export function stripProtocol(url: string): string {
  return url.replace(/^(https?|wss?):\/\//, '');
}

/**
 * Check if the current page is served over HTTPS
 * SSR-safe: returns false in non-browser contexts
 */
function pageIsSecure(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'https:';
}

/**
 * Build a WebSocket URL from an agent URL
 * Follows the page protocol: page http: → ws, page https: → wss
 */
export function buildWebSocketUrl(agentUrl: string, path: string): string {
  const cleanUrl = stripProtocol(agentUrl);
  return `${pageIsSecure() ? 'wss' : 'ws'}://${cleanUrl}${path}`;
}

/**
 * Build an HTTP API URL from an agent URL
 * Follows the page protocol: page http: → http, page https: → https
 */
export function buildApiUrl(agentUrl: string, path: string): string {
  const cleanUrl = stripProtocol(agentUrl);
  return `${pageIsSecure() ? 'https' : 'http'}://${cleanUrl}${path}`;
}

/**
 * Returns true when the page is served over HTTPS but the agent URL is plain HTTP.
 * Browsers block these connections (mixed-content policy) — callers should surface
 * an actionable error rather than letting the WebSocket silently fail.
 *
 * Always returns false in non-browser (SSR) contexts.
 */
export function isMixedContent(agentUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  if (!pageIsSecure()) return false;
  const lower = agentUrl.toLowerCase();
  // ws:// or http:// while page is https
  return lower.startsWith('http://') || lower.startsWith('ws://');
}
