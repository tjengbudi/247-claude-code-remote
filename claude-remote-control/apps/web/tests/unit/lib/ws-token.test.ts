import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openAgentWebSocket } from '@/lib/ws-token';

describe('openAgentWebSocket', () => {
  let calls: Array<{ url: string; protocols: string[] | undefined }>;
  let MockWebSocket: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    MockWebSocket = vi.fn(function (this: any, url: string, protocols?: string | string[]) {
      calls.push({ url, protocols: protocols as string[] | undefined });
      this.readyState = 0;
    });
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates WebSocket with ["247"] when no token provided', () => {
    openAgentWebSocket('wss://example.com/terminal');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('wss://example.com/terminal');
    expect(calls[0].protocols).toEqual(['247']);
  });

  it('creates WebSocket with ["247", token] when token provided', () => {
    const token = 'my-test-token-abc123';
    openAgentWebSocket('wss://example.com/terminal', token);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('wss://example.com/terminal');
    expect(calls[0].protocols).toEqual(['247', token]);
  });

  it('creates WebSocket with ["247"] when token is empty string', () => {
    openAgentWebSocket('wss://example.com/terminal', '');
    expect(calls[0].protocols).toEqual(['247']);
  });

  it('creates WebSocket with ["247"] when token is undefined', () => {
    openAgentWebSocket('wss://example.com/terminal', undefined);
    expect(calls[0].protocols).toEqual(['247']);
  });

  it('returns a WebSocket instance', () => {
    const result = openAgentWebSocket('wss://example.com/terminal', 'token');
    expect(result).toBeDefined();
    expect(result.readyState).toBe(0);
  });
});
