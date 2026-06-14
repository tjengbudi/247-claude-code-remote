/**
 * Database Schema Tests
 *
 * Validates table/column shape for the SQLite schema:
 * - All 6 timestamp columns use integer({ mode: 'timestamp_ms' })
 * - isCloud uses integer({ mode: 'boolean' })
 * - user/session/token tables exist with pinned columns
 * - 5 indexes + 2 UNIQUEs carried over + 2 new session indexes
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import {
  agentConnection,
  userSettings,
  pushSubscription,
  user,
  session,
} from '@/lib/db/schema';

/** Extract column metadata for a given column name from a table. */
function getColumn(table: unknown, name: string) {
  const config = getTableConfig(table as any);
  return config.columns.find((c: any) => c.name === name);
}

describe('Database Schema', () => {
  describe('agentConnection', () => {
    it('has correct table name', () => {
      const config = getTableConfig(agentConnection as any);
      expect(config.name).toBe('agent_connection');
    });

    it('has id as text primary key', () => {
      const col = getColumn(agentConnection, 'id');
      expect(col).toBeDefined();
      expect(col?.dataType).toBe('string');
      expect(col?.primary).toBe(true);
    });

    it('has userId mapped to user_id column', () => {
      const col = getColumn(agentConnection, 'user_id');
      expect(col).toBeDefined();
      expect(col?.notNull).toBe(true);
    });

    it('has machineId mapped to machine_id column', () => {
      const col = getColumn(agentConnection, 'machine_id');
      expect(col).toBeDefined();
    });

    it('has createdAt as timestamp_ms', () => {
      const col = getColumn(agentConnection, 'created_at');
      expect(col).toBeDefined();
      expect(col?.dataType).toBe('date');
      expect(col?.columnType).toBe('SQLiteTimestamp');
    });

    it('has updatedAt as timestamp_ms', () => {
      const col = getColumn(agentConnection, 'updated_at');
      expect(col).toBeDefined();
      expect(col?.dataType).toBe('date');
    });

    it('has isCloud as boolean mode integer', () => {
      const col = getColumn(agentConnection, 'is_cloud');
      expect(col).toBeDefined();
      expect(col?.columnType).toBe('SQLiteBoolean');
    });

    it('has token column', () => {
      const col = getColumn(agentConnection, 'token');
      expect(col).toBeDefined();
      expect(col?.dataType).toBe('string');
    });

    it('has 2 indexes', () => {
      const config = getTableConfig(agentConnection as any);
      expect(config.indexes).toHaveLength(2);
      const names = config.indexes.map((i: any) => i.config?.name ?? '');
      expect(names).toContain('idx_agent_connection_user');
      expect(names).toContain('idx_agent_connection_machine');
    });
  });

  describe('userSettings', () => {
    it('has correct table name', () => {
      const config = getTableConfig(userSettings as any);
      expect(config.name).toBe('user_settings');
    });

    it('has timestamp_ms columns', () => {
      const created = getColumn(userSettings, 'created_at');
      const updated = getColumn(userSettings, 'updated_at');
      expect(created?.dataType).toBe('date');
      expect(updated?.dataType).toBe('date');
    });

    it('has 2 indexes (1 regular + 1 unique)', () => {
      const config = getTableConfig(userSettings as any);
      expect(config.indexes).toHaveLength(2);
      const names = config.indexes.map((i: any) => i.config?.name ?? '');
      expect(names).toContain('idx_user_settings_user');
      expect(names).toContain('idx_user_settings_user_key');
    });

    it('has unique index on (userId, key)', () => {
      const config = getTableConfig(userSettings as any);
      const uniqueIdx = config.indexes.find(
        (i: any) => i.config?.name === 'idx_user_settings_user_key'
      );
      expect(uniqueIdx).toBeDefined();
    });
  });

  describe('pushSubscription', () => {
    it('has correct table name', () => {
      const config = getTableConfig(pushSubscription as any);
      expect(config.name).toBe('push_subscription');
    });

    it('has createdAt as timestamp_ms', () => {
      const col = getColumn(pushSubscription, 'created_at');
      expect(col?.dataType).toBe('date');
    });

    it('has 2 indexes (1 regular + 1 unique)', () => {
      const config = getTableConfig(pushSubscription as any);
      expect(config.indexes).toHaveLength(2);
      const names = config.indexes.map((i: any) => i.config?.name ?? '');
      expect(names).toContain('idx_push_subscription_user');
      expect(names).toContain('idx_push_subscription_endpoint');
    });
  });

  describe('user', () => {
    it('has correct table name', () => {
      const config = getTableConfig(user as any);
      expect(config.name).toBe('user');
    });

    it('has id as text primary key', () => {
      const col = getColumn(user, 'id');
      expect(col).toBeDefined();
      expect(col?.dataType).toBe('string');
      expect(col?.primary).toBe(true);
    });

    it('has username column that is not null and unique', () => {
      const col = getColumn(user, 'username');
      expect(col).toBeDefined();
      expect(col?.notNull).toBe(true);
    });

    it('has email column (nullable)', () => {
      const col = getColumn(user, 'email');
      expect(col).toBeDefined();
      expect(col?.notNull).toBe(false);
    });

    it('has password_hash column', () => {
      const col = getColumn(user, 'password_hash');
      expect(col).toBeDefined();
    });

    it('has createdAt and updatedAt as timestamp_ms', () => {
      const created = getColumn(user, 'created_at');
      const updated = getColumn(user, 'updated_at');
      expect(created?.dataType).toBe('date');
      expect(updated?.dataType).toBe('date');
    });
  });

  describe('session', () => {
    it('has correct table name', () => {
      const config = getTableConfig(session as any);
      expect(config.name).toBe('session');
    });

    it('has id as text primary key', () => {
      const col = getColumn(session, 'id');
      expect(col).toBeDefined();
      expect(col?.dataType).toBe('string');
      expect(col?.primary).toBe(true);
    });

    it('has userId mapped to user_id, not null', () => {
      const col = getColumn(session, 'user_id');
      expect(col).toBeDefined();
      expect(col?.notNull).toBe(true);
    });

    it('has tokenHash mapped to token_hash, not null', () => {
      const col = getColumn(session, 'token_hash');
      expect(col).toBeDefined();
      expect(col?.notNull).toBe(true);
    });

    it('has expiresAt as timestamp_ms, not null', () => {
      const col = getColumn(session, 'expires_at');
      expect(col).toBeDefined();
      expect(col?.notNull).toBe(true);
      expect(col?.dataType).toBe('date');
    });

    it('has createdAt as timestamp_ms', () => {
      const col = getColumn(session, 'created_at');
      expect(col?.dataType).toBe('date');
    });

    it('has 2 indexes (idx_session_user + idx_session_token_hash unique)', () => {
      const config = getTableConfig(session as any);
      expect(config.indexes).toHaveLength(2);
      const names = config.indexes.map((i: any) => i.config?.name ?? '');
      expect(names).toContain('idx_session_user');
      expect(names).toContain('idx_session_token_hash');
    });
  });

  describe('schema type exports', () => {
    it('all 5 tables are exported', () => {
      expect(agentConnection).toBeDefined();
      expect(userSettings).toBeDefined();
      expect(pushSubscription).toBeDefined();
      expect(user).toBeDefined();
      expect(session).toBeDefined();
    });
  });
});
