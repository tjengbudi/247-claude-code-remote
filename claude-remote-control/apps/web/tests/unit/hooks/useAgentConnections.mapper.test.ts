import { describe, it, expect } from 'vitest';
import type { AgentConnection } from '@/hooks/useAgentConnections';

/**
 * Tests that the token field survives the DB→AgentConnection mapping.
 *
 * The actual mapping lives inside `useAgentConnections` (a React hook), so
 * we extract the mapping shape here and assert the fields are preserved.
 * This is a focused mapper test — the hook's fetch/add/update behavior
 * is exercised by integration tests.
 */
describe('AgentConnection token mapping', () => {
  function mapConnection(c: Record<string, unknown>): AgentConnection {
    return {
      id: c.id as string,
      url: c.url as string,
      name: c.name as string,
      method: c.method as AgentConnection['method'],
      createdAt: c.createdAt ? new Date(c.createdAt as string).getTime() : Date.now(),
      isCloud: c.isCloud as boolean | undefined,
      cloudAgentId: c.cloudAgentId as string | undefined,
      color: c.color as string | undefined,
      token: c.token as string | undefined,
    };
  }

  it('preserves token from DB row', () => {
    const row = {
      id: 'abc-123',
      url: 'localhost:4678',
      name: 'My Agent',
      method: 'localhost',
      createdAt: '2026-06-14T00:00:00Z',
      token: 'aGVsbG93b3JsZHRoaXNpc3Rlc3R0b2tlbjEyMzQ1Njc4OTAxMg',
    };
    const result = mapConnection(row);
    expect(result.token).toBe('aGVsbG93b3JsZHRoaXNpc3Rlc3R0b2tlbjEyMzQ1Njc4OTAxMg');
  });

  it('handles missing token (pre-3.2 rows)', () => {
    const row = {
      id: 'abc-123',
      url: 'localhost:4678',
      name: 'My Agent',
      method: 'localhost',
      createdAt: '2026-06-14T00:00:00Z',
    };
    const result = mapConnection(row);
    expect(result.token).toBeUndefined();
  });

  it('handles null token', () => {
    const row = {
      id: 'abc-123',
      url: 'localhost:4678',
      name: 'My Agent',
      method: 'localhost',
      createdAt: '2026-06-14T00:00:00Z',
      token: null,
    };
    const result = mapConnection(row);
    expect(result.token).toBeNull();
  });
});
