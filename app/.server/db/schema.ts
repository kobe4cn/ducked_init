// app/.server/db/schema.ts —— 平台元数据（平台 PostgreSQL 的 platform schema）。业务数据不落这里（ADR-0002）
import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ROLES } from '../../lib/roles';
import { SOURCE_KINDS } from '../../lib/sources';

export { ROLE_LABELS, ROLES, type Role } from '../../lib/roles';
export { SOURCE_KIND_LABELS, SOURCE_KINDS, type SourceKind } from '../../lib/sources';

export const platform = pgSchema('platform');

export const roleEnum = platform.enum('member_role', ROLES);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// 停用（suspended_at 非空）：数据完整保留，可以恢复。拦截成员的会话与登录，排队的任务不再派发；外部系统接口随对应切片接入。
// 配额由运营者设置：每个任务的 DuckDB 内存上限与线程数，以及同时运行的任务数（超出的排队）
export const tenants = platform.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspensionReason: text('suspension_reason'),
  memoryLimitMb: integer('memory_limit_mb').notNull().default(2048),
  threads: integer('threads').notNull().default(2),
  maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(1),
  createdAt: createdAt(),
});

// 租户的数据湖（ADR-0001、0002、0008）：独立的对象存储前缀，DuckLake catalog 放在平台 PG 中本租户独占的 schema，
// 由本租户独占的数据库角色拥有；任务进程只拿到这个角色的凭据，读不到其他租户的 catalog 与平台元数据。
// 存储前缀在对象存储上时，s3_access_key / s3_secret_key 是本租户在存储服务上的账号，只能访问本租户的前缀；
// 与数据库角色的密码同等对待。为空表示账号尚未建好（开通时失败或本功能上线前开通），此时不派发任务。
// catalog_initialized_at 为空表示 DuckLake 元数据表尚未建好（开通时初始化失败），此时不派发任务
export const tenantLakes = platform.table('tenant_lakes', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  dataPath: text('data_path').notNull(),
  catalogSchema: text('catalog_schema').notNull().unique(),
  dbRole: text('db_role').notNull().unique(),
  dbPassword: text('db_password').notNull(),
  s3AccessKey: text('s3_access_key'),
  s3SecretKey: text('s3_secret_key'),
  catalogInitializedAt: timestamp('catalog_initialized_at', { withTimezone: true }),
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

/** 数据湖盘点：各表（非 main schema 的带 schema 前缀）与行数 */
export type LakeInventory = { name: string; rows: number }[];

export const LAKE_MIGRATION_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export type LakeMigrationStatus = (typeof LAKE_MIGRATION_STATUSES)[number];
export const lakeMigrationStatusEnum = platform.enum('lake_migration_status', LAKE_MIGRATION_STATUSES);

// 数据湖迁移存储：把租户存储前缀下的文件搬到新的数据湖根下（本地目录 ⇄ 对象存储），再把 catalog 与 tenant_lakes 的 data_path 一起切过去。
// pending / running 即「迁移中」：不派发该租户的任务（排队的保留），每个租户同时只有一个。pending 等该租户运行中的任务结束后
// 由调度器领取；claim 每次领取时重新生成，heartbeat_at 由执行它的调度器定期刷新，失联后其他调度器可以重新领取、从头再做。
// inventory 是复制前的盘点（各表行数），切换后与新位置的盘点比对；result 为复制的文件数与字节数，以及需要运营者留意的提示
export const lakeMigrations = platform.table('lake_migrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  fromPath: text('from_path').notNull(),
  toPath: text('to_path').notNull(),
  status: lakeMigrationStatusEnum('status').notNull().default('pending'),
  claim: uuid('claim'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  inventory: jsonb('inventory').$type<LakeInventory>(),
  result: jsonb('result').$type<{ files: number; bytes: number; warning?: string }>(),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [
  index('lake_migrations_tenant_created_idx').on(t.tenantId, t.createdAt),
  uniqueIndex('lake_migrations_one_active_uq').on(t.tenantId).where(sql`status IN ('pending', 'running')`),
]);

export const TASK_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const taskStatusEnum = platform.enum('task_status', TASK_STATUSES);

// 任务队列：每个任务由调度器派发给一个独立的工作进程，只挂载本租户的数据湖。
// heartbeat_at 由派发它的调度器定期刷新（取数据库时钟）；调度器失联后，其他调度器据此把任务判为失败
export const tasks = platform.table('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  status: taskStatusEnum('status').notNull().default('queued'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  error: text('error'),
  workerPid: integer('worker_pid'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, t => [
  index('tasks_tenant_created_idx').on(t.tenantId, t.createdAt),
  index('tasks_tenant_started_idx').on(t.tenantId, t.startedAt),
  index('tasks_queued_idx').on(t.tenantId, t.createdAt).where(sql`status = 'queued'`),
  index('tasks_running_idx').on(t.tenantId).where(sql`status = 'running'`),
]);

// 租户数据密钥（信封加密）：每个租户一把随机的数据密钥，用平台主密钥（PLATFORM_MASTER_KEY，以后可换 KMS）包裹后保存。
// 数据源凭据、模型服务 API Key 等用它加密；首次需要时生成
export const tenantKeys = platform.table('tenant_keys', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  wrappedKey: text('wrapped_key').notNull(),
  createdAt: createdAt(),
});

export const sourceKindEnum = platform.enum('source_kind', SOURCE_KINDS);

// 数据源：租户登记的外部只读连接，属于某个空间。config 是可以展示的连接参数（主机、库名、用户名、路径等），
// credentials 是用租户数据密钥加密的凭据（密码、对象存储密钥），任何界面与接口都不回显。
// 登记与修改时平台探测账号的写权限，可写即拒绝，因此库里只有只读账号
export const sources = platform.table('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  kind: sourceKindEnum('kind').notNull(),
  config: jsonb('config').$type<Record<string, string>>().notNull(),
  credentials: text('credentials').notNull(),
  credentialsRotatedAt: timestamp('credentials_rotated_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex('sources_tenant_name_uq').on(t.tenantId, t.name)]);

// 数据源里每张表由成员确认的设置：本期只有水位线字段（从平台给出的候选中确认）。
// 表清单与列统计来自最近一次成功的采集任务（source.profile）的结果
export const sourceTables = platform.table('source_tables', {
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  watermarkColumn: text('watermark_column'),
  confirmedByEmail: text('confirmed_by_email'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
}, t => [primaryKey({ columns: [t.sourceId, t.tableName] })]);
