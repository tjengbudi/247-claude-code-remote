import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Custom table for agent connections (in public schema)
export const agentConnection = sqliteTable(
  'agent_connection',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    machineId: text('machine_id'),
    url: text('url').notNull(),
    name: text('name').notNull(),
    method: text('method').notNull().default('tailscale'),
    isCloud: integer('is_cloud', { mode: 'boolean' }).default(false),
    cloudAgentId: text('cloud_agent_id'),
    color: text('color'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    token: text('token'),
  },
  (table) => [
    index('idx_agent_connection_user').on(table.userId),
    index('idx_agent_connection_machine').on(table.machineId),
  ]
);

export type AgentConnection = typeof agentConnection.$inferSelect;
export type NewAgentConnection = typeof agentConnection.$inferInsert;

// User settings table for storing encrypted API keys and preferences
export const userSettings = sqliteTable(
  'user_settings',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_user_settings_user').on(table.userId),
    uniqueIndex('idx_user_settings_user_key').on(table.userId, table.key),
  ]
);

export type UserSetting = typeof userSettings.$inferSelect;
export type NewUserSetting = typeof userSettings.$inferInsert;

// Push notification subscriptions for PWA background notifications
export const pushSubscription = sqliteTable(
  'push_subscription',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_push_subscription_user').on(table.userId),
    uniqueIndex('idx_push_subscription_endpoint').on(table.endpoint),
  ]
);

export type PushSubscription = typeof pushSubscription.$inferSelect;
export type NewPushSubscription = typeof pushSubscription.$inferInsert;

// User table for local authentication (Epic 4 groundwork)
export const user = sqliteTable(
  'user',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull().unique(),
    email: text('email').unique(),
    passwordHash: text('password_hash'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  }
);

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

// Session table for local authentication (Epic 4 groundwork)
export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_session_user').on(table.userId),
    uniqueIndex('idx_session_token_hash').on(table.tokenHash),
  ]
);

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
