// app/.server/db/schema.ts —— 平台元数据（平台 PostgreSQL 的 platform schema）。业务数据不落这里（ADR-0002）
import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { CustomEntityField, CustomEntityKind } from '../../lib/canonical-model';
import { ROLES } from '../../lib/roles';
import { SOURCE_KINDS } from '../../lib/sources';
import type { MergePlan } from '../pipeline/mapping-spec';

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

// 自定义实体的各个版本：中文名、类型（维度 / 事实，只用于引导）、字段与主键。草稿与双人发布的规则同映射版本（ADR-0015）：
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

// 结果快照：分析模板任务（如 gold.rfm）每次成功后在租户数据湖结果层写下的一张表（ADR-0002：数据在湖里，这里只登记元数据）。
// definition_version 是运行所用的已发布模板定义版本（参数直接放在任务里时为空）；expires_at 为创建后 90 天，过期清理后记下 expired_at
export const snapshots = platform.table('snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  template: text('template').notNull(),
  definitionVersion: integer('definition_version'),
  taskId: uuid('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  /** 数据湖里的表名（如 gold.rfm__<任务 ID>） */
  table: text('table').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  rowCount: bigint('row_count', { mode: 'number' }).notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
}, t => [
  index('snapshots_tenant_created_idx').on(t.tenantId, t.createdAt),
  uniqueIndex('snapshots_task_uq').on(t.taskId),
]);
