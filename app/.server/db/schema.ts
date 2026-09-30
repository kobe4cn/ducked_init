// app/.server/db/schema.ts —— 平台元数据（平台 PostgreSQL 的 platform schema）。业务数据不落这里（ADR-0002）
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ROLES } from '../../lib/roles';

export { ROLE_LABELS, ROLES, type Role } from '../../lib/roles';

export const platform = pgSchema('platform');

export const roleEnum = platform.enum('member_role', ROLES);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// 停用（suspended_at 非空）：数据完整保留，可以恢复。目前拦截成员的会话与登录；外部系统接口与平台任务随对应切片接入
export const tenants = platform.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspensionReason: text('suspension_reason'),
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

// Magic Link 申请记录：用于按邮箱限流。已登记与未登记邮箱一视同仁地记录，邮箱只存哈希（未登记的是陌生人的信息）
export const magicLinkRequests = platform.table('magic_link_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  emailHash: text('email_hash').notNull(),
  createdAt: createdAt(),
}, t => [index('magic_link_requests_email_idx').on(t.emailHash, t.createdAt)]);

// 会话：cookie 里放随机令牌，库里只存哈希；成员被删除时级联失效
export const sessions = platform.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// 运营者：运行平台本身的人，独立于成员（ADR-0007）。只能由运营命令创建。
// TOTP 密钥首次登录时生成，确认一次验证码后才算绑定；totp_last_step 记下最近用过的时间步，防止验证码重放
export const operators = platform.table('operators', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  totpSecret: text('totp_secret'),
  totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
  totpLastStep: integer('totp_last_step'),
  createdAt: createdAt(),
});

// 运营者的 Magic Link：与成员的分表存放，成员的链接无法用来登录运营后台，反之亦然
export const operatorMagicLinks = platform.table('operator_magic_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  operatorId: uuid('operator_id').notNull().references(() => operators.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// 运营者会话：通过 Magic Link 后先处于待验证状态（totp_verified_at 为空），通过 TOTP 后才能进入运营后台
export const operatorSessions = platform.table('operator_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  operatorId: uuid('operator_id').notNull().references(() => operators.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  totpVerifiedAt: timestamp('totp_verified_at', { withTimezone: true }),
  totpFailures: integer('totp_failures').notNull().default(0),
  createdAt: createdAt(),
});

export const ACTOR_TYPES = ['member', 'operator'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// 审计日志：只追加。操作者邮箱在写入时留存，成员被移除后记录仍可追溯。
// 操作者是运营者时 actor_type 为 operator（经运营命令操作时没有运营者身份，邮箱为空）；
// 与租户无关的平台级事件 tenant_id 为空，只在运营后台可见
export const auditLogs = platform.table('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  actorType: text('actor_type', { enum: ACTOR_TYPES }).notNull().default('member'),
  actorMemberId: uuid('actor_member_id').references(() => members.id, { onDelete: 'set null' }),
  actorOperatorId: uuid('actor_operator_id').references(() => operators.id, { onDelete: 'set null' }),
  actorEmail: text('actor_email'),
  action: text('action').notNull(),
  targetType: text('target_type').notNull(),
  targetId: text('target_id'),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, t => [
  index('audit_logs_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('audit_logs_operator_created_idx').on(t.createdAt).where(sql`actor_type = 'operator'`),
]);
