// app/.server/db/schema.ts —— 平台元数据（平台 PostgreSQL 的 platform schema）。业务数据不落这里（ADR-0002）
import { sql } from 'drizzle-orm';
import { boolean, index, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

export const platform = pgSchema('platform');

// 角色固定四种：管理员、数据工程师、分析师、查看者
export const ROLES = ['admin', 'data_engineer', 'analyst', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  data_engineer: '数据工程师',
  analyst: '分析师',
  viewer: '查看者',
};
export const roleEnum = platform.enum('member_role', ROLES);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = platform.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

// 空间：数据结构预留多空间，本期每个租户只有一个默认空间
export const spaces = platform.table('spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
}, t => [
  index('spaces_tenant_idx').on(t.tenantId),
  uniqueIndex('spaces_one_default_uq').on(t.tenantId).where(sql`is_default`),
]);

// 成员按 (租户, 邮箱) 唯一：同一个邮箱可以分别隶属于多个租户
export const members = platform.table('members', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: roleEnum('role').notNull(),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('members_tenant_email_uq').on(t.tenantId, t.email),
  index('members_email_idx').on(t.email),
]);

// Magic Link：只存令牌的 SHA-256，一次性（used_at）、短时有效（expires_at）
export const magicLinks = platform.table('magic_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// 会话：cookie 里放随机令牌，库里只存哈希；成员被删除时级联失效
export const sessions = platform.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
