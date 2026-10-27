// app/.server/db/schema.ts —— 平台元数据（平台 PostgreSQL 的 platform schema）。业务数据不落这里（ADR-0002）
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { CustomEntityField, CustomEntityKind, EntityRelation } from '../../lib/canonical-model';
import type { MergeRule } from '../../lib/merge-groups';
import { ROLES } from '../../lib/roles';
import { SOURCE_KINDS } from '../../lib/sources';
import type { CatalogEntry } from '../catalog';
import type { CatalogDiff } from '../catalog/versions';
import type { MergePlan } from '../pipeline/mapping-spec';

export { ROLE_LABELS, ROLES, type Role } from '../../lib/roles';
export { SOURCE_KIND_LABELS, SOURCE_KINDS, type SourceKind } from '../../lib/sources';

export const platform = pgSchema('platform');

export const roleEnum = platform.enum('member_role', ROLES);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// 停用（suspended_at 非空）：数据完整保留，可以恢复。拦截成员的会话与登录、外部系统的 API Key，排队的任务不再派发。
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
// catalog_initialized_at 为空表示 DuckLake 元数据表尚未建好（开通时初始化失败），此时不派发任务。
// ro_* 是数据查询工作台用的只读凭据（ADR-0036）：对 catalog 的表只有 SELECT 的数据库角色，与只能读、列出本租户前缀的
// 对象存储账号。为空表示还没建好（本功能上线前开通的租户），第一次执行工作台查询时补建
export const tenantLakes = platform.table('tenant_lakes', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  dataPath: text('data_path').notNull(),
  catalogSchema: text('catalog_schema').notNull().unique(),
  dbRole: text('db_role').notNull().unique(),
  dbPassword: text('db_password').notNull(),
  s3AccessKey: text('s3_access_key'),
  s3SecretKey: text('s3_secret_key'),
  roDbRole: text('ro_db_role').unique(),
  roDbPassword: text('ro_db_password'),
  roS3AccessKey: text('ro_s3_access_key'),
  roS3SecretKey: text('ro_s3_secret_key'),
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

// 外部系统的 API Key：明文只在创建时给管理员看一次，库里只存 SHA-256；prefix 是明文前 8 位，用于辨认。
// 吊销（revoked_at 非空）后立即失效；last_used_at 同一把 Key 每分钟最多更新一次
export const apiKeys = platform.table('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdByEmail: text('created_by_email').notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [index('api_keys_tenant_idx').on(t.tenantId, t.createdAt)]);

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

export const ACTOR_TYPES = ['member', 'operator', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// 审计日志：只追加。操作者邮箱在写入时留存，成员被移除后记录仍可追溯。
// 操作者是运营者时 actor_type 为 operator（经运营命令操作时没有运营者身份，邮箱为空）；平台自己发现的事件（如断言失败）为 system；
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
  // 删除标记（ADR-0044）：只软删，删除时清掉凭据（写成空串）与同步范围；已删除的数据源各处查不到，名称可以重新登记
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedByEmail: text('deleted_by_email'),
}, t => [uniqueIndex('sources_tenant_name_uq').on(t.tenantId, t.name).where(sql`deleted_at is null`)]);

// 数据源里的每张表：最近一次列出表得到的清单（schema、读权限、估算行数，源端删掉的表记下发现的时间），
// 成员选定的同步范围（ADR-0013），以及成员确认的水位线字段、业务主键与软删除字段。
// 列统计来自采集任务（source.profile）的结果，只采集同步范围内的表
export const sourceTables = platform.table('source_tables', {
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  /** 表所在的 schema（PostgreSQL 的 schema、MySQL 与 MongoDB 的库、DuckDB 文件里的 schema；对象存储文件为空串） */
  tableSchema: text('table_schema').notNull().default(''),
  readable: boolean('readable').notNull().default(true),
  /** 源端廉价给出的估算行数（PostgreSQL 的 reltuples、MySQL 的 TABLE_ROWS）；其他数据源与没有统计信息的表为 null */
  estimatedRows: bigint('estimated_rows', { mode: 'number' }),
  /** 第一次列出这张表的时间 */
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull().defaultNow(),
  /** 重新列出表时源端已经没有这张表：发现的时间（又出现时清空） */
  goneAt: timestamp('gone_at', { withTimezone: true }),
  /** 是否在同步范围内；选入、移出的成员与时间（迁移回填的表没有成员） */
  inScope: boolean('in_scope').notNull().default(false),
  scopedByEmail: text('scoped_by_email'),
  scopedAt: timestamp('scoped_at', { withTimezone: true }),
  watermarkColumn: text('watermark_column'),
  confirmedByEmail: text('confirmed_by_email'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  /** 源表没有主键时成员声明的业务主键（一列或多列的组合）：同步据此区分新增与更新、发现删除 */
  keyColumns: text('key_columns').array(),
  keyConfirmedByEmail: text('key_confirmed_by_email'),
  /** 成员声明的软删除字段：取值为真（布尔）、非零（整数）或非空（时间）的行按删除处理。只用于有主键的表 */
  softDeleteColumn: text('soft_delete_column'),
  softDeleteConfirmedByEmail: text('soft_delete_confirmed_by_email'),
}, t => [primaryKey({ columns: [t.sourceId, t.tableName] })]);

/** 双人发布的版本状态（映射、模板定义、源视图共用，ADR-0015）：草稿可改，已发布的锁定 */
export const VERSION_STATUSES = ['draft', 'published'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export const mappingVersionStatusEnum = platform.enum('mapping_version_status', VERSION_STATUSES);

// 映射：数据源里的一张表 → 一个标准实体（或自定义实体），属于某个空间（ADR-0015）。表与实体取自第一版文档，之后的版本不能改
export const mappings = platform.table('mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  spaceId: uuid('space_id').notNull().references(() => spaces.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  // 源表名；输入是源视图时是视图名，source_view_id 指向它（ADR-0023）
  tableName: text('table_name').notNull(),
  sourceViewId: uuid('source_view_id').references(() => sourceViews.id),
  entity: text('entity').notNull(),
  createdAt: createdAt(),
  // 映射停用（ADR-0031）：一位有发布权限的成员提议，另一位确认后写 disabled_at 与停用人（提议人，确认人记在审计里），清掉提议；停用的映射不再算作已发布
  disableRequestedByEmail: text('disable_requested_by_email'),
  disableRequestedAt: timestamp('disable_requested_at', { withTimezone: true }),
  disabledByEmail: text('disabled_by_email'),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, t => [
  index('mappings_tenant_idx').on(t.tenantId),
  uniqueIndex('mappings_source_table_entity_uq').on(t.sourceId, t.tableName, t.entity),
]);

// 映射的各个版本：YAML 原文与校验通过后的合并计划。草稿可以改，每个映射同时只有一份草稿；发布后锁定，再改就是新的一版草稿。
// authors 是改过这一版草稿的成员（邮箱，用于审计）；last_editor 是最后保存草稿的成员，发布者不能是这位成员（双人发布）
export const mappingVersions = platform.table('mapping_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  mappingId: uuid('mapping_id').notNull().references(() => mappings.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: mappingVersionStatusEnum('status').notNull().default('draft'),
  yaml: text('yaml').notNull(),
  plan: jsonb('plan').$type<MergePlan>().notNull(),
  authors: text('authors').array().notNull(),
  lastEditor: text('last_editor').notNull(),
  publishedByEmail: text('published_by_email'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('mapping_versions_mapping_version_uq').on(t.mappingId, t.version),
  uniqueIndex('mapping_versions_one_draft_uq').on(t.mappingId).where(sql`status = 'draft'`),
]);

// 映射源表里成员标记为有意不映射的新列：不再出现在新列提醒里（source-drift.ts）。只能标记，不能取消
export const mappingIgnoredColumns = platform.table('mapping_ignored_columns', {
  mappingId: uuid('mapping_id').notNull().references(() => mappings.id, { onDelete: 'cascade' }),
  column: text('column').notNull(),
  ignoredByEmail: text('ignored_by_email').notNull(),
  ignoredAt: timestamp('ignored_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.mappingId, t.column] })]);

// 映射各列已经通知过的落入兜底的取值（ADR-0015）：合并后不在这里的取值才算新取值、才发告警。与映射版本无关；task_id 是第一次见到它的合并任务
export const mappingFallbackValues = platform.table('mapping_fallback_values', {
  mappingId: uuid('mapping_id').notNull().references(() => mappings.id, { onDelete: 'cascade' }),
  column: text('column').notNull(),
  value: text('value').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  taskId: uuid('task_id').notNull(),
}, t => [primaryKey({ columns: [t.mappingId, t.column, t.value] })]);

// 不参与身份打通匹配的值（ADR-0039）：成员在数据质量页从热值里标记，之后每次合并都带上（silver.merge 参数 identityExclude）。
// 只存加盐哈希，不存明文；records 是标记时这个值连了的源记录数。撤销即删除这一行；标记人被移除后 created_by 为空
export const identityExcludedValues = platform.table('identity_excluded_values', {
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull(),
  records: integer('records').notNull(),
  createdBy: uuid('created_by').references(() => members.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, t => [primaryKey({ columns: [t.tenantId, t.hash] })]);

export const templateVersionStatusEnum = platform.enum('template_version_status', VERSION_STATUSES);

// 分析模板定义：租户对某个分析模板（如 rfm，见 pipeline/templates）的参数，每个租户每个模板一份（ADR-0004）。第一次保存草稿时建立，
// 从没发布过的定义丢弃草稿时删除；没有已发布版本时模板用注册表里的默认参数
export const templateDefinitions = platform.table('template_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  template: text('template').notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex('template_definitions_tenant_template_uq').on(t.tenantId, t.template)]);

// 模板定义的各个版本：校验通过的参数（不含每次运行时给定的参数，如 RFM 的 asOf）。草稿与双人发布的规则同映射版本（ADR-0015）：
// 每个定义同时只有一份草稿，发布后锁定；last_editor 是最后保存草稿的成员，发布者不能是这位成员
export const templateVersions = platform.table('template_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  definitionId: uuid('definition_id').notNull().references(() => templateDefinitions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: templateVersionStatusEnum('status').notNull().default('draft'),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  // 锁定的模板版本（pipeline/templates 注册表）：任务按它编译，不随注册表升级（ADR-0021）
  templateVersion: integer('template_version').notNull().default(1),
  authors: text('authors').array().notNull(),
  lastEditor: text('last_editor').notNull(),
  publishedByEmail: text('published_by_email'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('template_versions_definition_version_uq').on(t.definitionId, t.version),
  uniqueIndex('template_versions_one_draft_uq').on(t.definitionId).where(sql`status = 'draft'`),
]);

export const sourceViewVersionStatusEnum = platform.enum('source_view_version_status', VERSION_STATUSES);

// 源视图：数据工程师在某个数据源下手写的只读 SELECT，只能读本数据源的原始层，用来把复杂源表整理成可映射的形状（ADR-0022）。
// 名称在数据源内唯一；第一次保存草稿时建立，从没发布过的源视图丢弃草稿时删除
export const sourceViews = platform.table('source_views', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
}, t => [
  index('source_views_tenant_idx').on(t.tenantId),
  uniqueIndex('source_views_source_name_uq').on(t.sourceId, t.name),
]);

// 源视图的各个版本：校验通过的 SQL。草稿与双人发布的规则同映射版本（ADR-0015）：每个源视图同时只有一份草稿，发布后锁定；
// last_editor 是最后保存草稿的成员，发布者不能是这位成员。只能由成员在页面上发布，没有自动发布
export const sourceViewVersions = platform.table('source_view_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  viewId: uuid('view_id').notNull().references(() => sourceViews.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: sourceViewVersionStatusEnum('status').notNull().default('draft'),
  sql: text('sql').notNull(),
  // 保存时校验得到的输出列（不含平台列）与引用的原始层表（映射据此对照字段、在这些表同步后合并）；早于 #96 保存的版本为空
  columns: jsonb('columns').$type<{ name: string; type: string }[]>(),
  tables: text('tables').array(),
  authors: text('authors').array().notNull(),
  lastEditor: text('last_editor').notNull(),
  publishedByEmail: text('published_by_email'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('source_view_versions_view_version_uq').on(t.viewId, t.version),
  uniqueIndex('source_view_versions_one_draft_uq').on(t.viewId).where(sql`status = 'draft'`),
]);

export const customEntityVersionStatusEnum = platform.enum('custom_entity_version_status', VERSION_STATUSES);

// 自定义实体：租户在标准模型之外登记的实体（ADR-0019），映射可以写到它。名称 custom_ 开头、租户内唯一，建实体时定下、之后不能改；
// 第一次保存草稿时建立，从没发布过的实体丢弃草稿时删除
export const customEntities = platform.table('custom_entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('custom_entities_tenant_name_uq').on(t.tenantId, t.name),
]);

// 自定义实体的各个版本：中文名、类型（维度 / 事实，只用于引导）、字段、主键与关系（起点写全称，ADR-0019「关系」）。草稿与双人发布的规则同映射版本（ADR-0015）：
// 每个实体同时只有一份草稿，发布后锁定；last_editor 是最后保存草稿的成员，发布者不能是这位成员。只能由成员在页面上发布，没有自动发布
export const customEntityVersions = platform.table('custom_entity_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => customEntities.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: customEntityVersionStatusEnum('status').notNull().default('draft'),
  label: text('label').notNull(),
  kind: text('kind').$type<CustomEntityKind>().notNull(),
  fields: jsonb('fields').$type<CustomEntityField[]>().notNull(),
  primaryKey: text('primary_key').array().notNull(),
  relations: jsonb('relations').$type<EntityRelation[]>().notNull().default([]),
  authors: text('authors').array().notNull(),
  lastEditor: text('last_editor').notNull(),
  publishedByEmail: text('published_by_email'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('custom_entity_versions_entity_version_uq').on(t.entityId, t.version),
  uniqueIndex('custom_entity_versions_one_draft_uq').on(t.entityId).where(sql`status = 'draft'`),
]);

export const mergeGroupVersionStatusEnum = platform.enum('merge_group_version_status', VERSION_STATUSES);

// 合并组（ADR-0032）：把同一实体下描述同一批对象的几个映射绑在一起，同一主键在标准层只留一行。每个实体最多一个合并组；第一次保存草稿时建立，从没发布过的组丢弃草稿时删除
export const mergeGroups = platform.table('merge_groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entity: text('entity').notNull(),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('merge_groups_tenant_entity_uq').on(t.tenantId, t.entity),
]);

// 合并组的各个版本：组员（映射 ID 的有序数组，顺序即优先级）与存活规则。草稿与双人发布的规则同映射版本（ADR-0015）：
// 每个组同时只有一份草稿，发布后锁定；last_editor 是最后保存草稿的成员，发布者不能是这位成员。只能由成员在页面上发布，没有自动发布
export const mergeGroupVersions = platform.table('merge_group_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  groupId: uuid('group_id').notNull().references(() => mergeGroups.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: mergeGroupVersionStatusEnum('status').notNull().default('draft'),
  members: jsonb('members').$type<string[]>().notNull(),
  rule: jsonb('rule').$type<MergeRule>().notNull(),
  authors: text('authors').array().notNull(),
  lastEditor: text('last_editor').notNull(),
  publishedByEmail: text('published_by_email'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('merge_group_versions_group_version_uq').on(t.groupId, t.version),
  uniqueIndex('merge_group_versions_one_draft_uq').on(t.groupId).where(sql`status = 'draft'`),
]);

/** 快照登记时最近一次合并失败的映射：源表、实体、原因摘要（不带取值）与这个映射最近一次成功合并的时间（ISO 字符串，从未成功时为空） */
export interface IncompleteMapping { mapping: string; entity: string; table: string; error: string; lastSuccessAt: string | null }

/** 快照的来源（ADR-0028）：发布、回刷、定时刷新或手动 */
export const SNAPSHOT_TRIGGERS = ['publish', 'backfill', 'scheduled', 'manual'] as const;
export type SnapshotTrigger = (typeof SNAPSHOT_TRIGGERS)[number];

// 结果快照：分析模板任务（如 gold.rfm）每次成功后在租户数据湖结果层写下的一张表（ADR-0002：数据在湖里，这里只登记元数据）。
// definition_version 是运行所用的已发布模板定义版本（参数直接放在任务里时为空）；trigger 是来源（任务参数没写时与老快照一样为空）；
// expires_at 为创建后 90 天，过期清理后记下 expired_at
export const snapshots = platform.table('snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  template: text('template').notNull(),
  definitionVersion: integer('definition_version'),
  trigger: text('trigger').$type<SnapshotTrigger>(),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  /** 数据湖里的表名（如 gold.rfm__<任务 ID>） */
  table: text('table').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  /** 登记时模板读到的实体有已发布映射最近一次合并失败（数据不完整）时记下这些映射；完整时为空 */
  incomplete: jsonb('incomplete').$type<IncompleteMapping[]>(),
  rowCount: bigint('row_count', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
}, t => [
  index('snapshots_tenant_created_idx').on(t.tenantId, t.createdAt),
  uniqueIndex('snapshots_task_uq').on(t.taskId),
]);

/** 沙箱表保存后保留的天数 */
export const SANDBOX_TTL_DAYS = 7;

// 个人沙箱表（ADR-0036）：成员在工作台把查询结果存进湖里自己的 schema sandbox_<成员 ID 去掉横线>，这里只登记元数据。
// 同名表覆盖时重置行数、保存时间与过期时间（保存后 SANDBOX_TTL_DAYS 天），过期清理后记下 expired_at
export const sandboxTables = platform.table('sandbox_tables', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  /** 沙箱 schema 里的表名（[a-z][a-z0-9_]{0,62}） */
  name: text('name').notNull(),
  rowCount: bigint('row_count', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
}, t => [
  uniqueIndex('sandbox_tables_member_name_uq').on(t.tenantId, t.memberId, t.name),
]);

// 沙箱表的只读分享（ADR-0036）：表的主人分享给本租户有沙箱权限的成员，被分享人在工作台能读、不能写。
// 读的时候再按被分享人当前的角色判断；表过期清理时一并删掉它的分享
export const sandboxShares = platform.table('sandbox_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  tableId: uuid('table_id').notNull().references(() => sandboxTables.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, t => [
  uniqueIndex('sandbox_shares_table_member_uq').on(t.tableId, t.memberId),
  index('sandbox_shares_member_idx').on(t.memberId),
]);

/** 服务库里放的一张快照：快照 ID、模板、定义版本、登记时间（ISO 字符串）与数据是否不完整 */
export interface ServingStoreSnapshot { id: string; template: string; definitionVersion: number | null; createdAt: string; incomplete: boolean }

// 服务库指针（ADR-0033）：每个租户当前生效的服务库版本与文件位置（<dataPath>_serving/v<版本>.duckdb）。
// serving.build 上传完成、任务成功后才更新这一行，API 节点按它切换版本
export const servingStores = platform.table('serving_stores', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  path: text('path').notNull(),
  snapshots: jsonb('snapshots').$type<ServingStoreSnapshot[]>().notNull(),
  builtAt: timestamp('built_at', { withTimezone: true }).notNull(),
});

// 人群导出的下载链接（ADR-0040）：每次查到导出成功都签发一个，只存令牌的 SHA-256，15 分钟内可重复下载；
// 导出文件被清理后、链接到期时由调度器删掉
export const exportLinks = platform.table('export_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const DSL_DEFINITION_KINDS = ['metric', 'tag'] as const;
export const dslKindEnum = platform.enum('dsl_kind', DSL_DEFINITION_KINDS);

// DSL 定义：租户自己写的指标或标签（ADR-0025），键在租户与种类内唯一。在新建页起草时建立，之后的保存都改同一份草稿
export const dslDefinitions = platform.table('dsl_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  kind: dslKindEnum('kind').notNull(),
  key: text('key').notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex('dsl_definitions_tenant_kind_key_uq').on(t.tenantId, t.kind, t.key)]);

// DSL 定义的各个版本：YAML 原文。草稿与双人发布的规则同模板定义版本（ADR-0015）：每个定义同时只有一份草稿，发布后锁定；
// last_editor 是最后保存草稿的成员，发布者不能是这位成员
export const dslVersions = platform.table('dsl_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  definitionId: uuid('definition_id').notNull().references(() => dslDefinitions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  status: templateVersionStatusEnum('status').notNull().default('draft'),
  yaml: text('yaml').notNull(),
  authors: text('authors').array().notNull(),
  lastEditor: text('last_editor').notNull(),
  publishedByEmail: text('published_by_email'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('dsl_versions_definition_version_uq').on(t.definitionId, t.version),
  uniqueIndex('dsl_versions_one_draft_uq').on(t.definitionId).where(sql`status = 'draft'`),
]);

// 模型服务（ADR-0035）：租户自己的 OpenAI 兼容端点、模型名与 API Key（用租户数据密钥加密，context model_provider，ADR-0009）。
// 三列都为空时用平台默认（环境变量 LLM_*）；租户配置整套生效，不与平台默认混用。
// allow_samples 打开后才把敏感列已哈希的样本行发给模型，默认只发表结构与列统计
export const modelProviders = platform.table('model_providers', {
  tenantId: uuid('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  baseUrl: text('base_url'),
  model: text('model'),
  apiKey: text('api_key'),
  allowSamples: boolean('allow_samples').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 模型调用日志（ADR-0035）：每次调用一行，成功、HTTP 失败与 Schema 校验失败都记。不存提示词与返回原文（里面可能有样本行）。
// schema_valid 为空表示没拿到可解析的 JSON（请求失败、返回不是 JSON）
export const llmCalls = platform.table('llm_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  durationMs: integer('duration_ms').notNull(),
  schemaValid: boolean('schema_valid'),
  error: text('error'),
  createdAt: createdAt(),
}, t => [index('llm_calls_tenant_created_idx').on(t.tenantId, t.createdAt)]);

// 映射草稿的生成记录（ADR-0035）：新建页「用模型生成草稿」每次成功生成一行。origin 是草稿从哪来：复用已发布映射（reuse）、
// 没配置模型服务时按规则（rules）、模型（model），详情页用模型建议断言（assertions，只换了 assertions 块）；
// items 是模型给的每项（fields.<字段>、dedupe、identity、assertions.<序号>）的置信度与理由，非模型来源为 []。
// yaml 是生成的映射内容本身（与 mapping_versions.yaml 同级）；mapping_id 在保存成映射后回填，映射删除时置空
export const mappingGenerations = platform.table('mapping_generations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  entity: text('entity').notNull(),
  mappingId: uuid('mapping_id').references(() => mappings.id, { onDelete: 'set null' }),
  origin: text('origin').$type<'reuse' | 'rules' | 'model' | 'assertions'>().notNull(),
  yaml: text('yaml').notNull(),
  items: jsonb('items').$type<{ path: string; confidence: number; reason: string }[]>().notNull().default([]),
  createdByEmail: text('created_by_email').notNull(),
  createdAt: createdAt(),
}, t => [index('mapping_generations_tenant_created_idx').on(t.tenantId, t.createdAt)]);

// 业务说明（ADR-0041）：成员给实体字段写的本租户通用口径，只追加、留历史，不走双人发布。当前说明取同一 (entity, field, mapping_id) 最新的一行，
// 空串表示已清空。mapping_id 为空是实体字段的说明，非空是某个映射里这个字段的说明
export const businessNotes = platform.table('business_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  entity: text('entity').notNull(),
  field: text('field').notNull(),
  mappingId: uuid('mapping_id').references(() => mappings.id, { onDelete: 'cascade' }),
  note: text('note').notNull(),
  createdByEmail: text('created_by_email').notNull(),
  createdAt: createdAt(),
}, t => [index('business_notes_tenant_field_idx').on(t.tenantId, t.entity, t.field, t.mappingId, t.createdAt)]);

// 语义目录的版本（ADR-0041）：目录的结构或含义变了才记一版。snapshot 是去掉统计后的全部条目，diff 是与上一版按条目标识比出的差异；
// reason 是触发的审计动作（或 catalog.initial 之类）
export const catalogVersions = platform.table('catalog_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  reason: text('reason').notNull(),
  snapshot: jsonb('snapshot').$type<CatalogEntry[]>().notNull(),
  diff: jsonb('diff').$type<CatalogDiff>().notNull(),
  createdAt: createdAt(),
}, t => [uniqueIndex('catalog_versions_tenant_version_uq').on(t.tenantId, t.version)]);
