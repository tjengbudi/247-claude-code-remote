/**
 * Tests for session description persistence via the real db/sessions module.
 * Covers upsert COALESCE semantics and the explicit setSessionDescription setter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDatabase, closeDatabase } from '../../src/db/index.js';
import {
  upsertSession,
  getSession,
  setSessionDescription,
} from '../../src/db/sessions.js';

describe('Session description persistence', () => {
  beforeEach(() => {
    initTestDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  it('stores a description supplied at create time', () => {
    upsertSession('proj--abc', { project: 'proj', description: 'Fix login bug' });
    expect(getSession('proj--abc')?.description).toBe('Fix login bug');
  });

  it('defaults to null when no description is supplied', () => {
    upsertSession('proj--abc', { project: 'proj' });
    expect(getSession('proj--abc')?.description).toBeNull();
  });

  it('preserves the stored description when a later upsert omits it (COALESCE)', () => {
    upsertSession('proj--abc', { project: 'proj', description: 'Original label' });
    // A status update that does not carry a description must not wipe it.
    upsertSession('proj--abc', { project: 'proj', status: 'working' });
    expect(getSession('proj--abc')?.description).toBe('Original label');
  });

  it('setSessionDescription sets a new label', () => {
    upsertSession('proj--abc', { project: 'proj' });
    const updated = setSessionDescription('proj--abc', 'New label');
    expect(updated?.description).toBe('New label');
    expect(getSession('proj--abc')?.description).toBe('New label');
  });

  it('setSessionDescription clears the label with null', () => {
    upsertSession('proj--abc', { project: 'proj', description: 'Some label' });
    const updated = setSessionDescription('proj--abc', null);
    expect(updated?.description).toBeNull();
    expect(getSession('proj--abc')?.description).toBeNull();
  });

  it('setSessionDescription returns null for a missing session', () => {
    expect(setSessionDescription('does--not-exist', 'x')).toBeNull();
  });
});
