/**
 * viewerParams — the per-user view-isolation wire contract appended to agent
 * /sessions WS + /api/sessions requests. Must stay byte-compatible with the
 * agent's parseViewer (owner=<id>, isOwner=1).
 */
import { describe, it, expect } from 'vitest';
import { viewerParams } from '@/contexts/SessionPollingContext';

describe('viewerParams', () => {
  it('emits owner + isOwner for the owner account', () => {
    expect(viewerParams({ ownerId: 'dev-id', isOwner: true })).toBe('owner=dev-id&isOwner=1');
  });

  it('emits only owner for a non-owner user', () => {
    expect(viewerParams({ ownerId: 'alice-id', isOwner: false })).toBe('owner=alice-id');
  });

  it('is empty when identity is unknown (logged out / pre-resolve)', () => {
    expect(viewerParams({ ownerId: null, isOwner: false })).toBe('');
  });

  it('still flags isOwner when ownerId is null (null-owner owner account)', () => {
    expect(viewerParams({ ownerId: null, isOwner: true })).toBe('isOwner=1');
  });

  it('url-encodes the owner id', () => {
    expect(viewerParams({ ownerId: 'a b/c', isOwner: false })).toBe('owner=a+b%2Fc');
  });
});
