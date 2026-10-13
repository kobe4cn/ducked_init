// app/.server/mappings.ts —— 映射：数据工程师用 YAML 编写“源表（或已发布的源视图，ADR-0023）→ 标准实体”的映射，校验通过才能保存为草稿；草稿由最后保存它的人以外的
// 另一位有发布权限的成员发布，也可以丢弃（回到最近的已发布版本），发布后版本锁定（再改是新的一版草稿）。发布后为这个映射入队合并任务（silver.merge），同步给已发布映射的源表写入变更后也为这些映射再合并一次，把原始层的变更批次合并进标准层（ADR-0015）。
// 源表新增的列可一键加为扩展字段，写进草稿（或最新已发布版本）的 YAML 填进编辑框，不保存；也可标记为有意不映射（忽略），不再提醒并记审计。
// 编辑时可对任一版本空跑：在请求内只读挂载本租户的数据湖，转换原始层的样本，返回样例行与基础断言，不写标准层（pipeline/dry-run-engine.ts）。
// 一律限定在操作者所属租户内；合并本身在工作进程里进行（pipeline/merge-engine.ts）
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { allRelations, publishedCustomEntities, type RegisteredEntity, relationsFrom, relationsTo, uniqueKeys } from './custom-entities';
import { getDb, isUniqueViolation } from './db/client';
import { mappingIgnoredColumns, mappings, mappingVersions, sources, sourceViews, sourceViewVersions, tasks, tenants, type TaskStatus } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { publishedDependents } from './dsl-dependencies';
import { dryRun } from './pipeline/dry-run-engine';
import { consumerSensitive, identityRules, type IdentitySummary } from './pipeline/identity-engine';
import { openTenantLake, redactLakeSecrets } from './pipeline/lake-engine';
import type { MergeDrop, MergeMappingParam, MergeRecord, RelationParam } from './pipeline/merge-engine';
import { draftCustomMapping, draftMapping, DraftError } from './pipeline/mapping-draft';
import { checkMapping, type CustomerSources, mappingTemplate, type MappingIssue, type MergePlan } from './pipeline/mapping-spec';
import { isStale, publishBlocker, publisherCount, withAuthor } from './publish-rules';
import { tenantPiiSalt } from './secrets';
import { requireSource } from './source-config';
import { mappingDrift } from './source-drift';
import { confirmedTables } from './sources';
import { insertTask } from './tasks';
import { CANONICAL_ENTITIES, type CustomEntityField, entityLabel, entityOf, type EntityRelation, type RelationStat, relationText } from '../lib/canonical-model';
import { entityForTable } from '../lib/field-synonyms';
import { diffPlans } from '../lib/mapping-diff';
import { newExtension, readExtensions, writeExtension } from '../lib/mapping-form';

/** 可以展示给成员的业务错误；issues 是映射文档里带行列位置的问题 */
export class MappingError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400, readonly issues: MappingIssue[] = []) { super(message); }
}

/** 映射详情的合并历史取最近多少次带这个映射的合并任务 */
const HISTORY_TASKS = 50;

/** 空跑取多少条源记录，与所用的计算资源 */
const DRY_RUN_ROWS = 50;
const DRY_RUN_LIMITS = { memoryLimitMb: 512, threads: 1 };

/** 数据源里各表最近一次成功采集到的列统计（带声明的业务主键）：表不在同步范围、还没采集时返回原因 */
export async function profiledTables(tenantId: string, sourceId: string) {
  const { listing, tables } = await confirmedTables(tenantId, sourceId);
  return (table: string) => {
    const profiled = tables.find(t => t.table.name === table);
    if (profiled) return profiled;
    const listed = listing.find(t => t.tableName === table);
    if (!listed || (listed.goneAt && !listed.inScope)) return `数据源中没有表 ${table}`;
    if (!listed.inScope) return `表 ${table} 不在同步范围内，请先在数据源页选入`;
    if (listed.goneAt) return `源端已不存在表 ${table}`;
    if (!listed.readable) return `账号没有表 ${table} 的读权限`;
    return `表 ${table} 还没有采集到列统计，请等采集完成`;
  };
}

/**
 * 源视图（给了 viewIds 时只取这些，否则取数据源 sourceId 下的）最新的已发布版本：SQL、输出列与引用的原始层表。
 * 早于映射读源视图（#96）保存的版本没有列与表，为空
 */
async function publishedViews(db: Tx | ReturnType<typeof getDb>, tenantId: string, where: { sourceId: string } | { viewIds: string[] }) {
  if ('viewIds' in where && !where.viewIds.length) return [];
  return db
    .selectDistinctOn([sourceViewVersions.viewId], {
      id: sourceViews.id, name: sourceViews.name, version: sourceViewVersions.version,
      sql: sourceViewVersions.sql, columns: sourceViewVersions.columns, tables: sourceViewVersions.tables,
    })
    .from(sourceViewVersions)
    .innerJoin(sourceViews, eq(sourceViews.id, sourceViewVersions.viewId))
    .where(and(eq(sourceViews.tenantId, tenantId), eq(sourceViewVersions.status, 'published'),
      'sourceId' in where ? eq(sourceViews.sourceId, where.sourceId) : inArray(sourceViews.id, where.viewIds)))
    .orderBy(sourceViewVersions.viewId, desc(sourceViewVersions.version));
}

/** 合并与空跑用到的源视图版本 */
const viewParam = (v: { version: number; sql: string; tables: string[] | null }) => ({ version: v.version, sql: v.sql, tables: v.tables ?? [] });

/**
 * 数据源里各表的字段（最近一次成功采集到的）与已发布源视图的输出列：表不在同步范围、还没采集，或源视图没有发布时返回原因。
 * 另返回已发布的源视图（新建映射时据此记下视图）
 */
async function sourceColumns(tenantId: string, sourceId: string) {
  const lookup = await profiledTables(tenantId, sourceId);
  const views = await publishedViews(getDb(), tenantId, { sourceId });
  return (table: string, view?: boolean) => {
    if (view) {
      const found = views.find(v => v.name === table);
      if (!found) return `数据源中没有已发布的源视图 ${table}`;
      return found.columns ?? `源视图 ${table} 是在映射支持源视图之前保存的，请重新保存并发布一版`;
    }
    const profiled = lookup(table);
    return typeof profiled === 'string' ? profiled : profiled.table.columns.map(c => ({ name: c.name, type: c.type }));
  };
}

/** 对照面板里的一张源表或一个源视图（列统计的取值见 referenceTables） */
export interface ReferenceInput {
  name: string; view?: true; sampleRows: number; primaryKey: string[]; watermark: string | null;
  /** 同一数据源里各实体已发布映射声明的键空间（实体 → 键空间），表单据此预填引用字段的键空间 */
  keySpaces: Record<string, string>;
  /** 本租户有已发布 customer 映射的其他数据源（按名字排序），表单里指向 customer 的引用字段据此选所属数据源（customer_source） */
  customerSources: { id: string; name: string }[];
  /** 已登记关系的起点（实体 → 起点字段 → 终点实体），不含标准模型内置的 ref；表单据此给扩展字段显示键空间与所属数据源 */
  relationOrigins: Record<string, Record<string, string>>;
  columns: { name: string; type: string; nullRate: number; distinct: number; top: { value: string; rows: number }[] | null; formats: { format: string; share: number }[] }[];
}

/**
 * 编写映射时对照的源表（同步范围内、已采集的）：各列的类型、空值率、不同取值数与常见取值，
 * 主键（源端主键，没有时为声明的业务主键）与确认的水位线字段；其后是已发布的源视图（view 为真，只有列名与类型，没有列统计）。
 * 每张都带同一份键空间：同一数据源里已发布映射声明的键空间，同一实体有几个时取第一个（ADR-0024）；
 * 同一份跨源引用可选的数据源：有已发布 customer 映射的其他数据源（ADR-0030）；以及同一份已登记关系的起点（ADR-0019）
 */
export async function referenceTables(actor: CurrentMember, sourceId: string): Promise<ReferenceInput[]> {
  assertCan(actor, 'sources:read');
  const { tables } = await confirmedTables(actor.tenant.id, sourceId);
  const keySpaces: Record<string, string> = {};
  const withCustomer = new Set<string>();
  for (const p of await publishedPlans(getDb(), actor.tenant.id)) {
    if (p.sourceId === sourceId && p.keySpace && !(p.entity in keySpaces)) keySpaces[p.entity] = p.keySpace;
    if (p.entity === 'customer' && p.sourceId !== sourceId) withCustomer.add(p.sourceId);
  }
  const names = withCustomer.size ? await sourceNames(getDb(), actor.tenant.id) : new Map<string, string>();
  const otherCustomerSources = [...withCustomer].map(id => ({ id, name: names.get(id)! })).sort((a, b) => a.name.localeCompare(b.name));
  const relationOrigins: Record<string, Record<string, string>> = {};
  for (const r of [...(await publishedCustomEntities(getDb(), actor.tenant.id)).values()].flatMap(e => e.relations ?? [])) {
    (relationOrigins[r.from.entity] ??= {})[r.from.field] = r.ref.entity;
  }
  const views = (await publishedViews(getDb(), actor.tenant.id, { sourceId })).filter(v => v.columns)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(v => ({
      name: v.name, view: true as const, sampleRows: 0, primaryKey: [] as string[], watermark: null, keySpaces, customerSources: otherCustomerSources, relationOrigins,
      columns: v.columns!.map(c => ({ name: c.name, type: c.type, nullRate: 0, distinct: 0, top: null, formats: [] })),
    }));
  return [...tables.map(({ table, watermark, key }) => ({
    name: table.name,
    sampleRows: table.sampleRows,
    // 旧的采集结果里没有主键信息
    primaryKey: table.primaryKey?.length ? table.primaryKey : (key ?? []),
    watermark: watermark?.column ?? null,
    keySpaces,
    customerSources: otherCustomerSources,
    relationOrigins,
    // formats：表单新建扩展字段时据此判断是否像敏感信息
    columns: table.columns.map(c => ({ name: c.name, type: c.type, nullRate: c.nullRate, distinct: c.distinct, top: c.top ?? null, formats: c.formats ?? [] })),
  })), ...views];
}

/**
 * 按规则生成映射草稿（ADR-0017）：对照源表最近一次采集的列统计与目标实体（标准实体，或已发布登记的自定义实体），返回 YAML 文本。不调用模型、不保存、不记审计，
 * 成员确认修改后仍走保存校验与双人发布
 */
export async function draftFor(actor: CurrentMember, sourceId: string, table: string, entity: string) {
  assertCan(actor, 'sources:write');
  await requireSource(actor.tenant.id, sourceId).catch(() => { throw new MappingError('请选择数据源'); });
  if (!table) throw new MappingError('请选择表');
  const profiled = (await profiledTables(actor.tenant.id, sourceId))(table);
  if (typeof profiled === 'string') throw new MappingError(profiled);
  const target = entityOf(entity);
  if (target) return draftMapping(profiled.table, target, { key: profiled.key ?? undefined });
  // 自定义实体只认已发布的登记，与保存校验一致（ADR-0019）
  const registration = (await publishedCustomEntities(getDb(), actor.tenant.id)).get(entity);
  if (!registration) throw new MappingError(`只能为标准实体或已发布登记的自定义实体生成草稿，${entity} 都不是`);
  try {
    return draftCustomMapping(profiled.table, registration);
  } catch (e) {
    throw e instanceof DraftError ? new MappingError(e.message) : e;
  }
}

/**
 * 新建映射时编辑框的默认内容：数据源里第一张能按表名认出实体的已采集表的草稿（都认不出时取第一张表、第一个实体）；
 * 没有已采集的表、生成不了时是模板
 */
export async function defaultDraft(actor: CurrentMember, sourceId: string) {
  const candidates = (await referenceTables(actor, sourceId)).filter(t => !t.view).map(t => ({ table: t.name, entity: entityForTable(t.name) }));
  const pick = candidates.find(c => c.entity) ?? candidates[0];
  if (!pick) return mappingTemplate('order', 'orders');
  try {
    return await draftFor(actor, sourceId, pick.table, (pick.entity ?? CANONICAL_ENTITIES[0]).name);
  } catch (e) {
    if (e instanceof MappingError) return mappingTemplate('order', 'orders');
    throw e;
  }
}

/** 为已有映射（它的源表与实体）按规则生成草稿 */
export async function draftForMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:write');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  if (mapping.sourceViewId) throw new MappingError('按规则生成草稿要用源表的列统计，读源视图的映射请直接编辑');
  return draftFor(actor, mapping.sourceId, mapping.tableName, mapping.entity);
}

/**
 * 把源表新增、映射还没用到的列（mappingDrift 的新列）按表单勾选源列的规则加为扩展字段（名字 x_<列名>，类型按列推断，像敏感信息的标成敏感），
 * 写进草稿（没有草稿时是最新已发布版本）的 YAML，返回文本。不保存，保存仍走校验与双人发布（ADR-0015）
 */
export async function yamlWithColumns(actor: CurrentMember, mappingId: string, columns: string[]) {
  assertCan(actor, 'sources:write');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  if (!columns.length) throw new MappingError('请选择要加为扩展字段的列');
  const fresh = new Set((await mappingDrift(actor.tenant.id, [mappingId])).get(mappingId)?.newColumns.map(c => c.name));
  const stale = columns.find(c => !fresh.has(c));
  if (stale !== undefined) throw new MappingError(`${stale} 不是源表新增、映射还没用到的列`);
  const profiled = (await profiledTables(actor.tenant.id, mapping.sourceId))(mapping.tableName);
  if (typeof profiled === 'string') throw new MappingError(profiled);
  const versions = await getDb().select({ status: mappingVersions.status, yaml: mappingVersions.yaml }).from(mappingVersions)
    .where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version));
  const base = versions.find(v => v.status === 'draft') ?? versions.find(v => v.status === 'published');
  if (!base) throw new MappingError('映射还没有版本');
  const doc = parseDocument(base.yaml);
  const { extensions, reason } = readExtensions(doc);
  if (reason) throw new MappingError(reason);
  const taken = extensions.map(e => e.name);
  try {
    for (const column of new Set(columns)) {
      const choice = newExtension(profiled.table, column, taken);
      writeExtension(doc, choice.name, choice);
      taken.push(choice.name);
    }
  } catch (e) {
    // 已有的扩展字段是表单不认识的写法等
    throw new MappingError(e instanceof Error ? e.message : String(e));
  }
  return doc.toString();
}

/** 有意不映射源表新增的一列（mappingDrift 的新列）：记下成员，之后不再提醒，记审计。不能取消 */
export async function ignoreColumn(actor: CurrentMember, mappingId: string, column: string) {
  assertCan(actor, 'sources:write');
  await getDb().transaction(async tx => {
    const mapping = await requireMapping(actor.tenant.id, mappingId, tx);
    // 锁住映射行：与保存草稿互斥，草稿刚用上这一列时不再把它标成忽略
    await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    const isNewColumn = (await mappingDrift(actor.tenant.id, [mappingId])).get(mappingId)?.newColumns.some(c => c.name === column);
    if (!isNewColumn) throw new MappingError(`${column} 不是源表新增、映射还没用到的列`);
    const inserted = await tx.insert(mappingIgnoredColumns).values({ mappingId, column, ignoredByEmail: actor.email }).onConflictDoNothing()
      .returning({ column: mappingIgnoredColumns.column });
    // 并发的另一次请求已经忽略了这一列
    if (!inserted.length) return;
    const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'mapping.column_ignored',
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, column },
    });
  });
}

/**
 * 跨源引用的目标数据源（customer_source）：按名字找同租户的数据源，看它有没有已发布（且没停用）的 customer 映射。
 * YAML 里没写 customer_source 时不查平台库
 */
async function customerSources(tenantId: string, sourceId: string, yaml: string): Promise<CustomerSources> {
  if (!yaml.includes('customer_source')) return { self: sourceId, resolve: () => 'missing' };
  const db = getDb();
  const all = await db.select({ id: sources.id, name: sources.name }).from(sources).where(eq(sources.tenantId, tenantId));
  const published = new Set((await db.selectDistinct({ sourceId: mappings.sourceId }).from(mappings)
    .innerJoin(mappingVersions, eq(mappingVersions.mappingId, mappings.id))
    .where(and(eq(mappings.tenantId, tenantId), eq(mappings.entity, 'customer'), isNull(mappings.disabledAt), eq(mappingVersions.status, 'published')))).map(r => r.sourceId));
  return {
    self: sourceId,
    resolve: name => {
      const source = all.find(s => s.name === name);
      if (!source) return 'missing';
      return published.has(source.id) ? { id: source.id } : 'unpublished';
    },
  };
}

/**
 * 校验映射文档（对照数据源的字段、已发布的源视图、已发布的自定义实体登记与跨源引用的目标数据源；给了 registrations 时对照它），不通过时抛出带问题列表的 MappingError。
 * viewId 是输入为源视图时这个视图的 ID，否则为 null；notices 是不拦保存与发布的提示
 */
export async function checkMappingDraft(tenantId: string, sourceId: string, yaml: string, registrations?: Map<string, RegisteredEntity>) {
  const entities = registrations ?? await publishedCustomEntities(getDb(), tenantId);
  const result = checkMapping(yaml, await sourceColumns(tenantId, sourceId), entities, await customerSources(tenantId, sourceId, yaml));
  if (!result.ok) throw new MappingError(`映射有 ${result.issues.length} 处问题，未保存`, 400, result.issues);
  const [view] = result.plan.view ? await getDb().select({ id: sourceViews.id }).from(sourceViews)
    .where(and(eq(sourceViews.tenantId, tenantId), eq(sourceViews.sourceId, sourceId), eq(sourceViews.name, result.plan.table))) : [];
  return { ...result, viewId: view?.id ?? null };
}

export async function requireMapping(tenantId: string, mappingId: string, tx: Tx | ReturnType<typeof getDb> = getDb()) {
  if (!/^[0-9a-f-]{36}$/i.test(mappingId)) throw new MappingError('映射不存在', 404);
  const [row] = await tx.select().from(mappings).where(and(eq(mappings.id, mappingId), eq(mappings.tenantId, tenantId)));
  if (!row) throw new MappingError('映射不存在', 404);
  return row;
}

/**
 * 新建映射：文档校验通过后保存为第一版草稿，返回的映射行带上检查的 notices（不拦保存的提示）。同一数据源的同一张表到同一个实体只能有一个映射。
 * opts.registrations 只给一键直通（passthrough.ts）用：对照这些登记校验（含刚建、还没发布的那份），而不是只对照已发布登记
 */
export async function createMapping(actor: CurrentMember, sourceId: string, yaml: string, opts?: { registrations: Map<string, RegisteredEntity> }) {
  assertCan(actor, 'sources:write');
  const source = await requireSource(actor.tenant.id, sourceId).catch(() => { throw new MappingError('请选择数据源'); });
  const { plan, viewId, notices } = await checkMappingDraft(actor.tenant.id, sourceId, yaml, opts?.registrations);
  try {
    return await getDb().transaction(async tx => {
      const [mapping] = await tx.insert(mappings).values({
        tenantId: actor.tenant.id, spaceId: actor.space.id, sourceId, tableName: plan.table, sourceViewId: viewId, entity: plan.entity,
      }).returning();
      await tx.insert(mappingVersions).values({ mappingId: mapping.id, version: 1, yaml, plan, authors: [actor.email], lastEditor: actor.email });
      await recordAudit(tx, {
        tenantId: actor.tenant.id,
        actor,
        action: 'mapping.drafted',
        targetType: 'mapping',
        targetId: mapping.id,
        detail: { source: source.name, table: plan.table, entity: plan.entity, version: 1 },
      });
      return { ...mapping, notices };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new MappingError(`「${source.name}」的 ${plan.table} 已有到 ${entityLabel(plan.entity)} 的映射，请在那个映射上修改`);
    throw e;
  }
}

/**
 * 保存草稿：已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 表与实体在第一版就定下了，换表或换实体请新建映射
 */
export async function saveDraft(actor: CurrentMember, mappingId: string, yaml: string) {
  return (await saveMappingDraft(actor, mappingId, yaml)).version;
}

/** 同 saveDraft，另返回检查的 notices（不拦保存的提示，编辑页显示） */
export async function saveMappingDraft(actor: CurrentMember, mappingId: string, yaml: string): Promise<{ version: number; notices: MappingIssue[] }> {
  assertCan(actor, 'sources:write');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const { plan, viewId, notices } = await checkMappingDraft(actor.tenant.id, mapping.sourceId, yaml);
  if (plan.table !== mapping.tableName || viewId !== mapping.sourceViewId || plan.entity !== mapping.entity) {
    throw new MappingError(`这个映射是 ${mapping.sourceViewId ? '源视图 ' : ''}${mapping.tableName} → ${mapping.entity}，不能改表、源视图或实体；请新建映射`);
  }
  const saved = await getDb().transaction(async tx => {
    // 锁住映射行；等锁期间映射可能因丢弃草稿被删除
    const [locked] = await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    if (!locked) throw new MappingError('映射不存在', 404);
    const [latest] = await tx.select().from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version)).limit(1);
    if (latest?.status === 'draft') {
      await tx.update(mappingVersions).set({ yaml, plan, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() }).where(eq(mappingVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(mappingVersions).values({ mappingId, version, yaml, plan, authors: [actor.email], lastEditor: actor.email });
    const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'mapping.drafted',
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, version },
    });
    return version;
  });
  return { version: saved, notices };
}

/**
 * 扩展字段在同一实体上的类型必须一致：与已发布映射（含本映射之前发布的版本）里同名扩展字段的类型冲突时拒绝。
 * 标准层表的列一旦建好不改类型，换类型请换一个字段名
 */
async function assertExtensionTypes(tx: Tx, tenantId: string, plan: MergePlan) {
  const others = await publishedPlans(tx, tenantId);
  for (const other of others.filter(o => o.entity === plan.entity)) {
    for (const c of plan.entityColumns) {
      const clash = other.entityColumns.find(o => o.name === c.name && o.type !== c.type);
      if (clash) throw new MappingError(`字段 ${c.name} 在已发布的映射里是 ${clash.type}，这里是 ${c.type}：同一实体上的扩展字段类型必须一致`);
    }
  }
}

/**
 * 发布后这个实体的已发布映射（本映射换成这一版）里仍要有已发布指标引用的每个 x_ 字段（ADR-0025）：不再有时拒绝，报出指标的键与字段。
 * 调用方已锁住租户行，与发布指标互斥
 */
async function assertMetricFields(tx: Tx, tenantId: string, mappingId: string, plan: MergePlan) {
  const after = [...(await publishedPlans(tx, tenantId)).filter(o => o.mapping !== mappingId && o.entity === plan.entity), plan];
  const present = new Set(after.flatMap(p => p.columns.map(c => c.name)));
  const missing = (await publishedDependents(tx, tenantId)).flatMap(d => d.fields
    .filter(f => f.entity === plan.entity && f.field.startsWith('x_') && !present.has(f.field))
    .map(f => `指标 ${d.key} 的 ${f.field}`));
  if (missing.length) throw new MappingError(`发布后 ${plan.entity} 的已发布映射里不再有已发布指标引用的扩展字段，不能发布：${missing.join('、')}`);
}

/** 映射在报错里的叫法 */
const mappingName = (p: { table: string; entity: string }) => `${p.table} → ${p.entity}`;

/**
 * 身份打通的匹配规则在全部 customer 映射里必须一致：与其他映射已发布的规则（本映射之前发布的版本不算）不一致时拒绝。
 * 要改规则，先把其他映射的规则去掉或改成一样
 */
async function assertIdentityRules(tx: Tx, tenantId: string, mappingId: string, plan: MergePlan) {
  const others = (await publishedPlans(tx, tenantId)).filter(o => o.mapping !== mappingId);
  try {
    identityRules([...others, { ...plan, mapping: mappingId }], mappingName);
  } catch (e) {
    throw new MappingError((e as Error).message);
  }
}

/** 计划里的引用列：列名是 relations 里某条关系起点字段的列，带上它写的键空间与关系的终点实体 */
function referenceColumns(plan: Pick<MergePlan, 'columns'>, relations: EntityRelation[]) {
  return plan.columns.flatMap(c => relations.filter(r => r.from.field === c.name).map(r => ({ column: c.name, keySpace: c.keySpace, target: r.ref.entity })));
}

const keySpaceText = (spaces: string[]) => spaces.map(s => `key_space: ${s}`).join(' 或 ');

/** 跨源引用列与目标数据源 customer 的键空间 spaces 对不上：spaces 非空时没写其中之一，为空时写了键空间（标准层的主键不带前缀） */
const crossSourceMismatch = (c: MergePlan['columns'][number], spaces: string[]) => (spaces.length ? !(c.keySpace && spaces.includes(c.keySpace)) : !!c.keySpace);

/** 某数据源里 entity 各已发布映射声明的键空间（去重） */
const keySpacesIn = (plans: Pick<MergePlan, 'entity' | 'keySpace'>[], entity: string) =>
  [...new Set(plans.flatMap(p => (p.entity === entity && p.keySpace ? [p.keySpace] : [])))];

async function sourceNames(db: Tx | ReturnType<typeof getDb>, tenantId: string) {
  return new Map((await db.select({ id: sources.id, name: sources.name }).from(sources).where(eq(sources.tenantId, tenantId))).map(s => [s.id, s.name]));
}

/**
 * 引用字段的键空间（ADR-0024）：本映射里指向别的实体的字段（内置 ref 与已登记关系的起点），要写上同一数据源里目标实体已发布映射
 * （本映射不算）声明的键空间之一；自引用时用本映射自己声明的键空间。同源目标实体都没声明键空间时不检查（目标映射可能还没发布）。
 * 写了 customer_source 的跨源引用（ADR-0030）改对照目标数据源里已发布 customer 映射声明的键空间（目标源一定有已发布的 customer 映射，都没声明时引用不能写键空间），报错里给出目标数据源
 */
async function assertKeySpaces(tx: Tx, tenantId: string, mapping: typeof mappings.$inferSelect, plan: MergePlan) {
  const relations = relationsFrom(plan.entity, await publishedCustomEntities(tx, tenantId));
  if (!relations.length) return;
  const others = (await publishedPlans(tx, tenantId)).filter(p => p.mapping !== mapping.id);
  const sameSource = others.filter(p => p.sourceId === mapping.sourceId);
  const spacesOf = (entity: string) => (entity === plan.entity ? (plan.keySpace ? [plan.keySpace] : []) : keySpacesIn(sameSource, entity));
  const references = referenceColumns(plan, relations);
  const wrong = plan.columns.flatMap(c => {
    if (c.customerSource) return [];
    const own = references.filter(r => r.column === c.name);
    const spaces = [...new Set(own.flatMap(r => spacesOf(r.target)))];
    return spaces.length && !(c.keySpace && spaces.includes(c.keySpace)) ? [`${c.name} 应写 ${keySpaceText(spaces)}`] : [];
  });
  if (wrong.length) throw new MappingError(`引用字段要写上目标实体在同一数据源里声明的键空间：${wrong.join('；')}`);
  const crossSource = plan.columns.filter(c => c.customerSource);
  if (!crossSource.length) return;
  const names = await sourceNames(tx, tenantId);
  const wrongCross = crossSource.flatMap(c => {
    const spaces = keySpacesIn(others.filter(p => p.sourceId === c.customerSource), 'customer');
    if (!crossSourceMismatch(c, spaces)) return [];
    return [`${c.name} ${spaces.length ? `应写 ${keySpaceText(spaces)}` : '不应写键空间，目标数据源没声明'}（数据源 ${names.get(c.customerSource!)}）`];
  });
  if (wrongCross.length) throw new MappingError(`跨源引用字段要写上目标数据源里消费者（customer）映射声明的键空间：${wrongCross.join('；')}`);
}

/** 各映射里 customer_source 指向 sourceId 的跨源引用列 */
function crossSourceColumns(plans: MergeMappingParam[], sourceId: string) {
  return plans.flatMap(p => {
    const columns = p.columns.filter(c => c.customerSource === sourceId);
    return columns.length ? [{ plan: p, columns }] : [];
  });
}

/**
 * 跨源引用了 sourceId 的已发布映射（ADR-0030）：最新已发布版本里有字段的 customer_source 指向这个数据源的映射，带上映射名（表 → 实体）、
 * 所在数据源与这些字段。依赖查询，将来删除数据源时据此阻止删除
 */
export async function crossSourceReferrers(db: Tx | ReturnType<typeof getDb>, tenantId: string, sourceId: string) {
  return crossSourceColumns(await publishedPlans(db, tenantId), sourceId)
    .map(({ plan, columns }) => ({ mappingId: plan.mapping, mapping: mappingName(plan), sourceId: plan.sourceId, columns: columns.map(c => c.name) }));
}

/**
 * 重发 customer 映射改了键空间时（ADR-0030）：本数据源发布后的 customer 键空间（本映射的新计划加上同源别的已发布 customer 映射）
 * 与别的数据源跨源引用本源的字段写的键空间对不上（没有键空间时是写了键空间的）就拒绝发布，列出这些映射与字段。键空间没变时不查
 */
async function assertCrossSourceReferrers(tx: Tx, tenantId: string, mapping: typeof mappings.$inferSelect, plan: MergePlan) {
  if (plan.entity !== 'customer') return;
  const all = await publishedPlans(tx, tenantId);
  if (all.find(p => p.mapping === mapping.id)?.keySpace === plan.keySpace) return;
  const spaces = keySpacesIn([plan, ...all.filter(p => p.sourceId === mapping.sourceId && p.mapping !== mapping.id)], 'customer');
  const broken = crossSourceColumns(all, mapping.sourceId).flatMap(({ plan: referrer, columns }) => {
    const fields = columns.filter(c => crossSourceMismatch(c, spaces));
    return fields.length ? [{ referrer, fields }] : [];
  });
  if (!broken.length) return;
  const names = await sourceNames(tx, tenantId);
  const listed = broken.map(({ referrer, fields }) =>
    `${names.get(referrer.sourceId)} 的 ${mappingName(referrer)}（${fields.map(c => `${c.name} ${c.keySpace ? `写的是 key_space: ${c.keySpace}` : '没写键空间'}`).join('、')}）`);
  throw new MappingError(`${names.get(mapping.sourceId)} 的消费者（customer）映射发布后${spaces.length ? `键空间为 ${keySpaceText(spaces)}` : '不再声明键空间'}，`
    + `这些跨源引用会失效：${listed.join('；')}，先把它们改成一致再发布`);
}

/**
 * 主键的键空间改了时要一起改的映射（ADR-0024「同源一起改」）：草稿的键空间与最新已发布版本（没有时按未声明）不同时，
 * 同一数据源里引用本实体（自引用除外）的别的映射中，已发布版本的引用字段没写新键空间的那些映射与字段。只是提示，不阻止发布
 */
async function keySpaceFollowers(db: Tx | ReturnType<typeof getDb>, tenantId: string, mapping: typeof mappings.$inferSelect, draft: MergePlan, live?: MergePlan) {
  const next = draft.keySpace;
  if (next === live?.keySpace) return [];
  const relations = relationsTo(draft.entity, await publishedCustomEntities(db, tenantId));
  if (!relations.length) return [];
  return (await publishedPlans(db, tenantId)).flatMap(p => {
    if (p.sourceId !== mapping.sourceId || p.mapping === mapping.id) return [];
    const fields = [...new Set(referenceColumns(p, relations.filter(r => r.from.entity === p.entity)).filter(r => r.keySpace !== next).map(r => r.column))];
    return fields.length ? [{ mapping: p.mapping, entity: p.entity, table: p.table, fields }] : [];
  });
}

/**
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。发布前对照数据源当前的字段再校验一次。
 * 发布后版本锁定，并为这个映射入队一次合并（已有合并在排队时补进那个合并，在运行时由调度器在它之后补上）
 */
export async function publishMapping(actor: CurrentMember, mappingId: string, version: number) {
  assertCan(actor, 'publish');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const [draft] = await getDb().select().from(mappingVersions)
    .where(and(eq(mappingVersions.mappingId, mappingId), eq(mappingVersions.version, version)));
  if (!draft) throw new MappingError(`没有第 ${version} 版`, 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new MappingError(blocker, draft.status === 'draft' ? 403 : 400);
  const { plan } = await checkMappingDraft(actor.tenant.id, mapping.sourceId, draft.yaml);
  return getDb().transaction(async tx => {
    // 先锁住租户行（入队合并也锁它）：与入队合并、定时检查互斥
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, actor.tenant.id)).for('update');
    return publishMappingDraft(tx, actor, mapping, draft, plan);
  });
}

/**
 * 在调用方的事务里发布检查过的这份草稿（plan 是发布前对照数据源当前的字段校验出的），记审计并入队合并，返回合并任务（同 enqueueMerge）。
 * 调用方须已锁住租户行；这里锁映射行。等锁期间草稿被修改、发布或丢弃，或扩展字段类型、身份打通规则与已发布映射冲突、引用字段没写同源目标实体（跨源引用为目标数据源 customer）的键空间、改了 customer 键空间使别的数据源的跨源引用失效时抛出 MappingError。
 * 发布权限与双人发布由调用方检查（publishMapping，以及一键直通里登记与映射一起发布）
 */
export async function publishMappingDraft(
  tx: Tx, actor: CurrentMember, mapping: typeof mappings.$inferSelect, draft: typeof mappingVersions.$inferSelect, plan: MergePlan,
) {
  // 锁住映射行：与保存草稿互斥，发布的正是检查过的那份草稿
  await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mapping.id)).for('update');
  // 等锁期间草稿可能已被丢弃
  const [current] = await tx.select().from(mappingVersions).where(eq(mappingVersions.id, draft.id));
  if (isStale(current, draft)) {
    throw new MappingError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
  }
  await assertExtensionTypes(tx, actor.tenant.id, plan);
  await assertIdentityRules(tx, actor.tenant.id, mapping.id, plan);
  await assertKeySpaces(tx, actor.tenant.id, mapping, plan);
  await assertCrossSourceReferrers(tx, actor.tenant.id, mapping, plan);
  await assertMetricFields(tx, actor.tenant.id, mapping.id, plan);
  await tx.update(mappingVersions)
    .set({ status: 'published', plan, publishedByEmail: actor.email, publishedAt: sql`now()` })
    .where(eq(mappingVersions.id, draft.id));
  const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
  await recordAudit(tx, {
    tenantId: actor.tenant.id,
    actor,
    action: 'mapping.published',
    targetType: 'mapping',
    targetId: mapping.id,
    detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, version: draft.version, authors: draft.authors, lastEditor: draft.lastEditor },
  });
  return enqueueMerge(tx, actor.tenant.id, [mapping.id]);
}

/**
 * 丢弃草稿：映射回到最近的已发布版本；从没发布过的映射整个删除（可以重新新建同一个“表 → 实体”映射）。
 * 用于草稿卡住（如最后保存的人离职）的情况。返回映射是否还在
 */
export async function discardDraft(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:write');
  return getDb().transaction(async tx => {
    const mapping = await requireMapping(actor.tenant.id, mappingId, tx);
    // 锁住映射行：与保存、发布互斥
    await tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.id, mappingId)).for('update');
    const versions = await tx.select({ id: mappingVersions.id, version: mappingVersions.version, status: mappingVersions.status })
      .from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version));
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new MappingError('这个映射没有草稿');
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    // 从没发布过时删除映射，各版本随之级联删除
    if (published) await tx.delete(mappingVersions).where(eq(mappingVersions.id, draft.id));
    else await tx.delete(mappings).where(eq(mappings.id, mappingId));
    const [source] = await tx.select({ name: sources.name }).from(sources).where(eq(sources.id, mapping.sourceId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'mapping.draft_discarded',
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: source.name, table: mapping.tableName, entity: mapping.entity, version: draft.version, published },
    });
    return { kept: published !== null };
  });
}

/**
 * 有发布权限的成员做不了停用的这一步（request 提议、confirm 确认，ADR-0031）的报错：映射没有已发布版本、已停用，
 * 确认时还没有人提议或提议的是自己（双人确认，403）；可以时为 null。发布权限由调用方另行检查
 */
function disableBlocker(actor: CurrentMember, mapping: typeof mappings.$inferSelect, published: boolean, step: 'request' | 'confirm') {
  if (!published) return new MappingError('这个映射还没有发布，不用停用；可以丢弃草稿');
  if (mapping.disabledAt) return new MappingError('映射已停用');
  if (step === 'request') return null;
  if (!mapping.disableRequestedByEmail) return new MappingError('还没有人提议停用这个映射');
  if (mapping.disableRequestedByEmail === actor.email) return new MappingError('你提议了停用，需由另一位数据工程师或管理员确认', 403);
  return null;
}

/** 停用的两步各记的审计 */
const DISABLE_ACTIONS = { request: 'mapping.disable_requested', confirm: 'mapping.disabled' } as const;

/**
 * 停用的一步：锁住租户行（与发布、入队合并互斥）与映射行后检查 disableBlocker，以及 customer 映射没被别的数据源跨源引用（ADR-0030，
 * 停用后这些引用的 _customer_source 会指向空），然后在同一事务里做 apply 并记审计，apply 返回的是审计 detail 里另加的项
 */
async function disableStep(
  actor: CurrentMember, mappingId: string, step: keyof typeof DISABLE_ACTIONS,
  apply: (tx: Tx, mapping: typeof mappings.$inferSelect) => Promise<Record<string, unknown> | void>,
) {
  assertCan(actor, 'publish');
  await getDb().transaction(async tx => {
    await lockTenant(tx, actor.tenant.id);
    await requireMapping(actor.tenant.id, mappingId, tx);
    const [mapping] = await tx.select().from(mappings).where(eq(mappings.id, mappingId)).for('update');
    const [published] = await tx.select({ id: mappingVersions.id }).from(mappingVersions)
      .where(and(eq(mappingVersions.mappingId, mappingId), eq(mappingVersions.status, 'published'))).limit(1);
    const blocker = disableBlocker(actor, mapping, !!published, step);
    if (blocker) throw blocker;
    const names = await sourceNames(tx, actor.tenant.id);
    if (mapping.entity === 'customer') {
      const referrers = (await crossSourceReferrers(tx, actor.tenant.id, mapping.sourceId)).filter(r => r.sourceId !== mapping.sourceId);
      if (referrers.length) {
        throw new MappingError(`${names.get(mapping.sourceId)} 的消费者（customer）映射被别的数据源跨源引用，停用后这些引用会找不到消费者：`
          + `${referrers.map(r => `${names.get(r.sourceId)} 的 ${r.mapping}（${r.columns.join('、')}）`).join('；')}，先改掉或停用它们`);
      }
    }
    const detail = await apply(tx, mapping);
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: DISABLE_ACTIONS[step],
      targetType: 'mapping',
      targetId: mappingId,
      detail: { source: names.get(mapping.sourceId), table: mapping.tableName, entity: mapping.entity, ...detail },
    });
  });
}

/**
 * 提议停用已发布的映射（ADR-0031）：需要发布权限，记下提议人与时间；已有提议时覆盖原提议人。被别的数据源跨源引用的 customer 映射不能停用
 */
export async function requestDisable(actor: CurrentMember, mappingId: string) {
  await disableStep(actor, mappingId, 'request', async tx => {
    await tx.update(mappings).set({ disableRequestedByEmail: actor.email, disableRequestedAt: sql`now()` }).where(eq(mappings.id, mappingId));
  });
}

/**
 * 确认停用（ADR-0031）：需要发布权限，确认人不能是提议人。停用后映射不再算作已发布（publishedPlans、同步后的合并与定时检查都跳过它），
 * 停用人记为提议人、确认人记在审计里，并清掉提议。被别的数据源跨源引用的 customer 映射不能停用（提议之后才有的引用也算）。
 * 同一事务里入队一次合并：撤下它写进标准层的行，同实体其余映射一起合并；已有合并在运行时报错，不停用
 */
export async function confirmDisable(actor: CurrentMember, mappingId: string) {
  await disableStep(actor, mappingId, 'confirm', async (tx, mapping) => {
    await tx.update(mappings)
      .set({ disabledAt: sql`now()`, disabledByEmail: mapping.disableRequestedByEmail, disableRequestedByEmail: null, disableRequestedAt: null })
      .where(eq(mappings.id, mappingId));
    // 撤下它写进标准层的行，同实体其余映射一起合并（失败的合并不自动重试，原先因它失败的映射要在这次补上，ADR-0015）
    const rest = (await publishedPlans(tx, actor.tenant.id)).filter(p => p.entity === mapping.entity).map(p => p.mapping);
    const task = await enqueueMerge(tx, actor.tenant.id, rest, { drop: [{ mapping: mappingId, entity: mapping.entity }] });
    if (!task) throw new MappingError('已有一次合并在运行，等它结束后再确认停用');
    return { requestedBy: mapping.disableRequestedByEmail, confirmedBy: actor.email };
  });
}

/**
 * 空跑映射的第 version 版：在只读挂载的数据湖上转换原始层里源表（或源视图）最新的样本（只用会话的本机库 stage），返回样例行与基础断言。
 * 不写标准层与合并日志、不记审计。源表还没同步、转换出错时抛出 MappingError（报错里抹掉凭据、盐与敏感字段的取值）
 */
export async function dryRunMapping(actor: CurrentMember, mappingId: string, version: number) {
  assertCan(actor, 'sources:write');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const [row] = await getDb().select({ plan: mappingVersions.plan }).from(mappingVersions)
    .where(and(eq(mappingVersions.mappingId, mappingId), eq(mappingVersions.version, version)));
  if (!row) throw new MappingError(`没有第 ${version} 版`, 404);
  // 输入是源视图时空跑它最新的已发布版本
  const [view] = mapping.sourceViewId ? await publishedViews(getDb(), actor.tenant.id, { viewIds: [mapping.sourceViewId] }) : [];
  const lake = await lakeRow(actor.tenant.id);
  if (!lake || !lakeReady(lake)) throw new MappingError('本租户的数据湖还没有初始化');
  const salt = await tenantPiiSalt(actor.tenant.id);
  const spec = lakeSpecOf(lake);
  const session = await openTenantLake(spec, DRY_RUN_LIMITS, undefined, { readOnly: true });
  try {
    const result = await dryRun(session.con, row.plan, mapping.sourceId, salt, DRY_RUN_ROWS, view && viewParam(view));
    if ('skipped' in result) throw new MappingError(result.skipped);
    return result;
  } catch (e) {
    if (e instanceof MappingError) throw e;
    throw new MappingError(`空跑失败：${redactLakeSecrets((e as Error).message, spec).replaceAll(salt, '***')}`);
  } finally {
    session.close();
  }
}

/**
 * 租户各映射（给了 mappingIds 时只取这些；停用的映射除外，ADR-0031）最新的已发布版本及其合并计划（合并任务的参数）。
 * 输入是源视图的映射带上视图最新的已发布版本（SQL 与引用的表），工作进程不读平台库；
 * 写入全部实体（customer 除外，ADR-0024「独占」）的映射带上实体主键 uniqueKey，合并时跨映射查重；主键含指向 customer 的字段时
 * 另带 uniqueBySource，只在同一个数据源内查重
 */
export async function publishedPlans(db: Tx | ReturnType<typeof getDb>, tenantId: string, mappingIds?: string[]): Promise<MergeMappingParam[]> {
  if (mappingIds && !mappingIds.length) return [];
  const rows = await db
    .selectDistinctOn([mappingVersions.mappingId], {
      mapping: mappings.id, sourceId: mappings.sourceId, viewId: mappings.sourceViewId, version: mappingVersions.version, plan: mappingVersions.plan,
    })
    .from(mappingVersions)
    .innerJoin(mappings, eq(mappings.id, mappingVersions.mappingId))
    .where(and(eq(mappings.tenantId, tenantId), isNull(mappings.disabledAt), eq(mappingVersions.status, 'published'), mappingIds && inArray(mappings.id, mappingIds)))
    .orderBy(mappingVersions.mappingId, desc(mappingVersions.version));
  const views = await publishedViews(db, tenantId, { viewIds: [...new Set(rows.flatMap(r => (r.viewId ? [r.viewId] : [])))] });
  const uniqueByEntity = uniqueKeys(await publishedCustomEntities(db, tenantId));
  return rows
    .sort((a, b) => a.mapping.localeCompare(b.mapping))
    .map(({ viewId, ...r }) => {
      const view = views.find(v => v.id === viewId);
      const unique = uniqueByEntity.get(r.plan.entity);
      return {
        ...r.plan, mapping: r.mapping, version: r.version, sourceId: r.sourceId,
        ...(view && { sourceView: viewParam(view) }),
        ...(unique && { uniqueKey: unique.key, ...(unique.bySource && { uniqueBySource: true }) }),
      };
    });
}

const ofMerge = (tenantId: string) => and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge'));

/** 租户在排队或运行中的合并（同一租户同时只有一个） */
export async function pendingMerge(db: Tx | ReturnType<typeof getDb>, tenantId: string) {
  const [pending] = await db.select().from(tasks).where(and(ofMerge(tenantId), inArray(tasks.status, ['queued', 'running']))).limit(1);
  return pending;
}

/**
 * 这次合并是否要强制重算身份打通（工作进程只看这次改没改到 customer / event，判断不出下面几种情况）：取本租户最近一次真正跑过打通
 * （结果里有 identities 且不是跳过）或没写结果就结束（崩溃、超时，之前提交的映射可能已改了 customer / event）的合并，
 * 它不存在、没写结果、打通失败了，或它的匹配规则与这次的 identity、属性取舍的名次与这次的 survivorship 不同时强制。多算一次没有坏处，宁可偏向强制
 */
async function mustRecomputeIdentities(db: Tx, tenantId: string, identity: unknown, survivorship: Record<string, number>) {
  const [last] = await db.select({ params: tasks.params, result: tasks.result }).from(tasks)
    .where(and(ofMerge(tenantId), inArray(tasks.status, ['succeeded', 'failed']),
      sql`(${tasks.result} IS NULL OR ${tasks.result} ? 'identities' AND NOT (${tasks.result}->'identities') ? 'skipped')`))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return !last?.result || 'error' in (last.result as { identities: object }).identities
    || JSON.stringify(last.params.identity ?? null) !== JSON.stringify(identity ?? null)
    || JSON.stringify(rankEntries(last.params.survivorship)) !== JSON.stringify(rankEntries(survivorship));
}

/** 属性取舍的名次（ADR-0027）：各已发布 customer 映射里配置的名次，映射 ID → 名次（没配置的映射不在里面） */
const survivorshipPriority = (plans: MergeMappingParam[]): Record<string, number> =>
  Object.fromEntries(plans.filter(p => p.entity === 'customer' && p.survivorship).map(p => [p.mapping, p.survivorship!.priority]));

/** 名次表按映射 ID 排好的键值对，用来比对是否变了（早先的合并参数里没有这一项，等同于空表） */
const rankEntries = (ranks: unknown) => Object.entries((ranks ?? {}) as Record<string, number>).sort(([a], [b]) => a.localeCompare(b));

/**
 * 合并后要统计孤儿的关系：全部已发布关系（内置 ref 与已发布登记上的），带上起点是否敏感（isSensitiveField；标准层里是哈希，不给样例键）
 */
function relationParams(published: Map<string, RegisteredEntity>, plans: MergeMappingParam[]): RelationParam[] {
  return allRelations(published).map(r => ({ ...r, sensitive: isSensitiveField(r.from, e => published.get(e)?.fields, plans) }));
}

/**
 * 实体字段在标准层里是否敏感（ADR-0005，存的是哈希）：标准实体的 pii 字段、自定义实体登记（custom 给出字段）里标成敏感的字段，
 * 或已发布映射里标成敏感的列（x_ 字段，任一映射标了就算）
 */
export function isSensitiveField(
  { entity, field }: EntityRelation['from'],
  custom: (entity: string) => readonly CustomEntityField[] | undefined,
  plans: readonly MergeMappingParam[],
): boolean {
  return !!entityOf(entity)?.fields.find(f => f.name === field)?.pii
    || !!custom(entity)?.find(f => f.name === field)?.sensitive
    || plans.some(p => p.entity === entity && p.columns.some(c => c.name === field && c.sensitive));
}

/** 锁住租户行：入队合并、发布映射与定义、删除定义与自定义实体先拿它，按租户串行 */
export const lockTenant = (tx: Tx, tenantId: string) => tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');

/**
 * 在调用方的事务里为给定映射（不给时为全部已发布映射）的最新已发布版本入队一次合并，返回带上它们的合并任务。
 * 锁住租户行后检查：同一租户同时只有一个合并在排队或运行（两个合并同时写同一张标准层表会冲突）。
 * 已有合并在排队时把映射补进去（同一映射换成最新版本）；已在运行（或补的时候刚被领取）时不入队，返回 null，由定时检查在它之后补上。
 * 给定的映射都没有已发布版本时也不入队。参数里另带身份打通的匹配规则、属性取舍的名次（映射 ID → 名次）与不进 _consumer 的敏感字段，由全部已发布的 customer 映射汇总（重算打通时整表重算，不只看这次的映射），
 * 与要统计孤儿的全部已发布关系（工作进程不读平台库），
 * 以及是否强制重算打通 identityForce（见 mustRecomputeIdentities；补进排队中的合并时，已为真的保留）。
 * opts.rebuild 时给这些映射带上强制重建标记；排队中的映射已带标记时，补进去的同一映射保留它。
 * opts.drop 是要撤下的停用映射（ADR-0031）：带上它时没有已发布的映射也入队；并进排队中的合并时，从它的映射里剔除这些映射、drop 并在一起
 */
export async function enqueueMerge(tx: Tx, tenantId: string, mappingIds?: string[], opts?: { rebuild?: boolean; drop?: MergeDrop[] }) {
  await lockTenant(tx, tenantId);
  const plans = (await publishedPlans(tx, tenantId, mappingIds)).map(p => (opts?.rebuild ? { ...p, rebuild: true } : p));
  const incoming = opts?.drop ?? [];
  if (!plans.length && !incoming.length) return null;
  const pending = await pendingMerge(tx, tenantId);
  const all = mappingIds ? await publishedPlans(tx, tenantId) : plans;
  const identity = identityRules(all, mappingName);
  const survivorship = survivorshipPriority(all);
  const sensitive = consumerSensitive(all);
  const relations = relationParams(await publishedCustomEntities(tx, tenantId), all);
  if (pending?.status === 'running') return null;
  const force = await mustRecomputeIdentities(tx, tenantId, identity, survivorship);
  if (!pending) {
    return insertTask(tx, tenantId, 'silver.merge', {
      mappings: plans, ...(incoming.length > 0 && { drop: incoming }), identity, survivorship, consumerSensitive: sensitive, relations, identityForce: force,
    });
  }
  const queuedDrop = (pending.params.drop ?? []) as MergeDrop[];
  const drop = [...queuedDrop, ...incoming.filter(d => !queuedDrop.some(q => q.mapping === d.mapping))];
  const queued = (pending.params.mappings ?? []) as MergeMappingParam[];
  const merged = [
    ...queued.filter(q => !plans.some(p => p.mapping === q.mapping) && !drop.some(d => d.mapping === q.mapping)),
    ...plans.map(p => (queued.some(q => q.mapping === p.mapping && q.rebuild) ? { ...p, rebuild: true } : p)),
  ].sort((a, b) => a.mapping.localeCompare(b.mapping));
  // 领取合并不锁租户行：只在它仍在排队时改参数
  const [task] = await tx.update(tasks).set({ params: { ...pending.params, mappings: merged, ...(drop.length > 0 && { drop }), identity, survivorship, consumerSensitive: sensitive, relations, identityForce: pending.params.identityForce === true || force } })
    .where(and(eq(tasks.id, pending.id), eq(tasks.status, 'queued'))).returning();
  return task ?? null;
}

/**
 * 同步任务 s 是否给已发布映射 m 的源表写入了变更：同一数据源、同一张表、本批次写进原始层的行数大于 0（删除也算在内）。
 * 输入是源视图的映射看视图最新的已发布版本引用的任一张表。
 * 比对周期里同一张表有两条记录，任意一条有变更即可；失败的记录没有 rows，自然排除（部分失败的任务照样参与判断）。
 * 同步后的合并与定时检查共用这个判断（ADR-0015）
 */
const syncWroteMappingTable = (s: 's', m: 'm') => sql.raw(`${s}.kind = 'source.sync' AND ${s}.params->>'sourceId' = ${m}.source_id::text
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(${s}.result->'tables') r WHERE (r->>'rows')::int > 0 AND r->>'table' = ANY(CASE
    WHEN ${m}.source_view_id IS NULL THEN ARRAY[${m}.table_name]
    ELSE (SELECT vv.tables FROM platform.source_view_versions vv WHERE vv.view_id = ${m}.source_view_id AND vv.status = 'published' ORDER BY vv.version DESC LIMIT 1)
  END))`);

/**
 * 同步结束后合并一次（调度器在同步任务结束时调用）：只为这次同步给源表写入了变更的已发布映射（停用的除外）入队，没有这样的映射时不入队；
 * 租户停用时什么都不做
 */
export async function mergeAfterSync(tenantId: string, syncTaskId: string) {
  return getDb().transaction(async tx => {
    const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId));
    if (!tenant || tenant.suspendedAt) return null;
    const { rows } = await tx.execute<{ id: string }>(sql`
      SELECT m.id FROM ${tasks} s
      JOIN ${mappings} m ON m.tenant_id = s.tenant_id
      WHERE s.id = ${syncTaskId} AND m.disabled_at IS NULL AND ${syncWroteMappingTable('s', 'm')}
        AND EXISTS (SELECT 1 FROM ${mappingVersions} v WHERE v.mapping_id = m.id AND v.status = 'published')`);
    if (!rows.length) return null;
    return enqueueMerge(tx, tenantId, rows.map(r => r.id));
  });
}

/** 成员手动触发一次合并（全部已发布映射）；已有合并在排队时把全部映射补进去，在运行时报错 */
export async function mergeNow(actor: CurrentMember) {
  assertCan(actor, 'sources:write');
  const task = await getDb().transaction(tx => enqueueMerge(tx, actor.tenant.id));
  if (task) return task;
  const pending = await pendingMerge(getDb(), actor.tenant.id);
  throw new MappingError(pending ? '已有一次合并在排队或运行中' : '还没有已发布的映射');
}

/** 成员在映射详情页手动合并这一个映射（最新已发布版本）；已有合并在排队时把它补进去，在运行时报错（之后还有没合并的版本或变更时由定时检查补上） */
export async function mergeMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:write');
  await requireMapping(actor.tenant.id, mappingId);
  return getDb().transaction(async tx => {
    const task = await enqueueMerge(tx, actor.tenant.id, [mappingId]);
    if (task) return task;
    // 在同一个事务里判断原因：排队中的合并恰被领取时，这里读到的是运行中
    if (!(await publishedPlans(tx, actor.tenant.id, [mappingId])).length) throw new MappingError('这个映射还没有已发布的版本');
    throw new MappingError('已有一次合并在运行；它结束后，这个映射还有没合并的版本或变更时由定时检查补上');
  });
}

/**
 * 成员在数据地图上重建合并一张标准层表（漂移检查报告缺列时）：写入实体 entity 的全部已发布映射都带上强制重建标记入队一次合并，
 * 合并时补上缺的列（只补列，不改列类型、不删列，ADR-0015）。已有合并在排队或运行中时报错，不并进去（先锁租户行再查，与入队互斥）
 */
export async function rebuildEntity(actor: CurrentMember, entity: string) {
  assertCan(actor, 'sources:write');
  return getDb().transaction(async tx => {
    await lockTenant(tx, actor.tenant.id);
    const ids = (await publishedPlans(tx, actor.tenant.id)).filter(p => p.entity === entity).map(p => p.mapping);
    if (!ids.length) throw new MappingError('这张表没有已发布的映射写入');
    if (await pendingMerge(tx, actor.tenant.id)) throw new MappingError('已有一次合并在排队或运行中，等它结束后再重建');
    // 锁已持有、没有排队或运行中的合并，入队必定成功
    return (await enqueueMerge(tx, actor.tenant.id, ids, { rebuild: true }))!;
  });
}

/** 合并任务的参数 params 带了映射 mappingId（任一版本） */
const mergeHas = (params: SQL, mappingId: SQL) => sql`${params}->'mappings' @> jsonb_build_array(jsonb_build_object('mapping', ${mappingId}))`;

/**
 * 到期要合并的映射（给了 tenantId 时只看这个租户）：映射已发布且没停用、租户未停用，带它的最近一次合并 last 不在排队，且
 * (a) last 带的不是它最新的已发布版本（还没合并过也算；last 失败了也算带过，不自动重试；读源视图的映射另看 last 带的视图版本，
 *     视图发布时已有合并在运行、入队不了的由此补上），或
 * (b) last 开始之后有同步结束并给它的源表写入了变更（合并运行期间发生的变化由此补上）。
 * 同一租户的合并一个接一个，入队或补映射时都在租户锁里取最新的已发布版本，所以 last 带的就是合并过的最高版本；
 * 按版本而不按发布时间判断 (a)：发布时间是事务开始时间，可能早于并发领取的合并的开始时间。
 * 只找最近一次（按入队时间倒序走索引），不随历史合并增多而变慢
 */
async function dueMappings(db: Tx | ReturnType<typeof getDb>, tenantId?: string) {
  const { rows } = await db.execute<{ tenant_id: string; mapping_id: string }>(sql`
    SELECT m.tenant_id, m.id AS mapping_id FROM ${mappings} m
    JOIN ${tenants} t ON t.id = m.tenant_id AND t.suspended_at IS NULL
    CROSS JOIN LATERAL (SELECT max(version) AS version FROM ${mappingVersions} WHERE mapping_id = m.id AND status = 'published') v
    LEFT JOIN LATERAL (
      SELECT l.status, coalesce(l.started_at, l.created_at) AS at,
        (SELECT (e->>'version')::int FROM jsonb_array_elements(l.params->'mappings') e WHERE e->>'mapping' = m.id::text) AS version,
        (SELECT (e->'sourceView'->>'version')::int FROM jsonb_array_elements(l.params->'mappings') e WHERE e->>'mapping' = m.id::text) AS view_version
      FROM ${tasks} l
      WHERE l.tenant_id = m.tenant_id AND l.kind = 'silver.merge' AND ${mergeHas(sql`l.params`, sql`m.id::text`)}
      ORDER BY l.created_at DESC, l.id DESC LIMIT 1
    ) last ON true
    WHERE v.version IS NOT NULL AND m.disabled_at IS NULL ${tenantId ? sql`AND m.tenant_id = ${tenantId}` : sql``}
      AND last.status IS DISTINCT FROM 'queued'
      AND (
        last.version IS DISTINCT FROM v.version
        OR (m.source_view_id IS NOT NULL AND last.view_version IS DISTINCT FROM
          (SELECT max(version) FROM ${sourceViewVersions} WHERE view_id = m.source_view_id AND status = 'published'))
        OR EXISTS (SELECT 1 FROM ${tasks} s WHERE s.tenant_id = m.tenant_id AND s.finished_at > last.at AND ${syncWroteMappingTable('s', 'm')})
      )
    ORDER BY m.tenant_id, m.id`);
  return rows;
}

/** 为到期的映射入队合并（调度器定期调用），每个租户一个合并；已有合并在排队时补进去。返回入队（或补进）合并的租户 */
export async function enqueueDueMerges() {
  const tenantIds = [...new Set((await dueMappings(getDb())).map(r => r.tenant_id))];
  const enqueued: string[] = [];
  for (const tenantId of tenantIds) {
    try {
      const task = await getDb().transaction(async tx => {
        // 先锁住租户行再算一次（enqueueMerge 里再锁是同一把锁）：查询之后可能已有发布、同步或合并入队
        await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
        return enqueueMerge(tx, tenantId, (await dueMappings(tx, tenantId)).map(r => r.mapping_id));
      });
      if (task) enqueued.push(tenantId);
    } catch (e) {
      console.error(`[调度器] 租户 ${tenantId} 的合并入队失败`, e);
    }
  }
  return enqueued;
}

/** 一个映射最近一次合并的结果，带所属任务 */
export type MergeHistoryEntry = MergeRecord & { taskId: string };

/** 本租户最近一次合并任务（任何状态） */
async function tenantLatestMerge(tenantId: string) {
  const [latest] = await getDb().select().from(tasks).where(ofMerge(tenantId)).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return {
    status: (latest?.status ?? 'none') as TaskStatus | 'none',
    error: latest?.error ?? null,
    attemptedAt: latest?.createdAt ?? null,
    finishedAt: latest?.finishedAt ?? null,
  };
}

/**
 * 本租户最近一次打通成功的摘要（统一消费者数、参与打通的记录数、已归属的设备数，以及本次 ID 合并与拆开的组数，上一版的结果没有这两项时为 null），
 * 带所属任务与时间；只有计数，不带消费者标识。
 * 跳过没有打通的合并（没有 silver.customer）、打通失败的与沿用上次结果而跳过打通的；部分失败的合并任务照样落了 result，也算在内。还没打通过时为 null
 */
export async function latestIdentitySummary(tenantId: string) {
  const [latest] = await getDb().select({ id: tasks.id, createdAt: tasks.createdAt, result: tasks.result }).from(tasks)
    .where(and(ofMerge(tenantId), sql`${tasks.result} ? 'identities' AND NOT (${tasks.result}->'identities') ?| array['error', 'skipped']`))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  if (!latest) return null;
  const { groups, records, devices, merged, split } = (latest.result as { identities: Partial<IdentitySummary> & Pick<IdentitySummary, 'groups' | 'records' | 'devices'> }).identities;
  return { groups, records, devices, merged: merged ?? null, split: split ?? null, taskId: latest.id, at: latest.createdAt };
}

/** 本租户最近一次带关系孤儿统计的合并：各关系的统计与完成时间；还没有时为 null */
export async function latestRelationStats(tenantId: string) {
  const [latest] = await getDb().select({ finishedAt: tasks.finishedAt, result: tasks.result }).from(tasks)
    .where(and(ofMerge(tenantId), sql`${tasks.result} ? 'relations'`))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  if (!latest) return null;
  return { relations: (latest.result as { relations: RelationStat[] }).relations, at: latest.finishedAt };
}

/**
 * 一个实体相关（起点或终点是它）的已发布关系与最近一次合并后的孤儿统计（ADR-0019）。
 * 最近一次合并没有统计到的关系（还没合并过，或合并之后才发布的）为 unmerged
 */
export async function entityRelationStats(tenantId: string, entity: string) {
  const latest = await latestRelationStats(tenantId);
  const relations = allRelations(await publishedCustomEntities(getDb(), tenantId)).filter(r => r.from.entity === entity || r.ref.entity === entity);
  return {
    at: latest?.at ?? null,
    relations: relations.map((r): RelationStat => latest?.relations.find(s => relationText(s) === relationText(r)) ?? { ...r, status: 'unmerged' }),
  };
}

/** 各映射最近一次合并的结果（每个映射分别找带它的最近一次合并任务，不受别的映射合并得多少影响） */
export async function lastMergeByMapping(tenantId: string, mappingIds: string[]) {
  if (!mappingIds.length) return {};
  const { rows } = await getDb().execute<{ mapping_id: string; task_id: string; record: MergeRecord }>(sql`
    SELECT m.id AS mapping_id, r.task_id, r.record FROM unnest(ARRAY[${sql.join(mappingIds.map(id => sql`${id}`), sql`, `)}]::uuid[]) m(id)
    CROSS JOIN LATERAL (
      SELECT t.id AS task_id, rec AS record FROM ${tasks} t, jsonb_array_elements(t.result->'mappings') rec
      WHERE t.tenant_id = ${tenantId} AND t.kind = 'silver.merge' AND rec->>'mapping' = m.id::text
      ORDER BY t.created_at DESC, t.id DESC LIMIT 1
    ) r`);
  return Object.fromEntries(rows.map(r => [r.mapping_id, { ...r.record, taskId: r.task_id } as MergeHistoryEntry]));
}

/**
 * 一个映射的合并状态与历史（新的在前）：只看带这个映射的合并任务。结束了的任务按这个映射自己的结果判断成败，
 * 别的映射合并失败不算在它头上
 */
async function mergesOfMapping(tenantId: string, mappingId: string) {
  const runs = await getDb().select().from(tasks).where(and(ofMerge(tenantId), mergeHas(sql`${tasks.params}`, sql`${mappingId}::text`)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(HISTORY_TASKS);
  const history = runs.flatMap(run => ((run.result?.mappings ?? []) as MergeRecord[])
    .filter(r => r.mapping === mappingId).map(r => ({ ...r, taskId: run.id }) as MergeHistoryEntry));
  const [latest] = runs;
  const own = latest && ((latest.result?.mappings ?? []) as MergeRecord[]).find(r => r.mapping === mappingId);
  const status: TaskStatus | 'none' = !latest ? 'none' : own ? ('error' in own ? 'failed' : 'succeeded') : latest.status;
  return { status, history };
}

/** 本租户的映射：数据源、源表、实体、已发布的最新版本与草稿、源表列差异（没有时为 null），以及最近一次合并的结果 */
export async function listMappings(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const rows = await getDb()
    .select({ mapping: mappings, sourceName: sources.name })
    .from(mappings)
    .innerJoin(sources, eq(sources.id, mappings.sourceId))
    .where(eq(mappings.tenantId, actor.tenant.id))
    .orderBy(mappings.entity, sources.name, mappings.tableName);
  const versions = rows.length
    ? await getDb().select({ mappingId: mappingVersions.mappingId, version: mappingVersions.version, status: mappingVersions.status })
      .from(mappingVersions).where(inArray(mappingVersions.mappingId, rows.map(r => r.mapping.id)))
    : [];
  const merge = await tenantLatestMerge(actor.tenant.id);
  const last = await lastMergeByMapping(actor.tenant.id, rows.map(r => r.mapping.id));
  const drift = await mappingDrift(actor.tenant.id);
  return {
    merge,
    mappings: rows.map(({ mapping, sourceName }) => {
      const mine = versions.filter(v => v.mappingId === mapping.id);
      return {
        ...mapping,
        sourceName,
        published: Math.max(0, ...mine.filter(v => v.status === 'published').map(v => v.version)) || null,
        draft: mine.find(v => v.status === 'draft')?.version ?? null,
        lastMerge: last[mapping.id] ?? null,
        drift: drift.get(mapping.id) ?? null,
      };
    }),
  };
}

/**
 * 映射详情：各版本（新的在前）、当前成员能否发布草稿及原因、本租户有发布权限的成员人数、合并历史，
 * 以及草稿相对最新已发布版本（against，没有时为 null）的差异（没有草稿时为 null；只下发差异，不下发计划），
 * 草稿相对最新已发布版本的键空间变化（from/to，未声明为 null；没变或没有草稿时为 null）与要一起改的同源引用映射（keySpaceFollowers），
 * 以及源表列差异（没有时为 null）
 */
export async function getMapping(actor: CurrentMember, mappingId: string) {
  assertCan(actor, 'sources:read');
  const mapping = await requireMapping(actor.tenant.id, mappingId);
  const [source] = await getDb().select({ id: sources.id, name: sources.name, kind: sources.kind }).from(sources).where(eq(sources.id, mapping.sourceId));
  const versions = await getDb().select().from(mappingVersions).where(eq(mappingVersions.mappingId, mappingId)).orderBy(desc(mappingVersions.version));
  const merge = await mergesOfMapping(actor.tenant.id, mappingId);
  const draft = versions.find(v => v.status === 'draft');
  const live = versions.find(v => v.status === 'published');
  return {
    ...mapping,
    source,
    publishers: await publisherCount(actor.tenant.id),
    versions: versions.map(v => ({
      version: v.version,
      status: v.status,
      yaml: v.yaml,
      authors: v.authors,
      lastEditor: v.lastEditor,
      publishedBy: v.publishedByEmail,
      publishedAt: v.publishedAt,
      updatedAt: v.updatedAt,
      publishBlocker: publishBlocker(actor, v),
    })),
    draftDiff: draft ? { against: live?.version ?? null, ...diffPlans(live?.plan ?? null, draft.plan) } : null,
    keySpaceChange: draft && draft.plan.keySpace !== live?.plan.keySpace ? { from: live?.plan.keySpace ?? null, to: draft.plan.keySpace ?? null } : null,
    keySpaceFollowers: draft ? await keySpaceFollowers(getDb(), actor.tenant.id, mapping, draft.plan, live?.plan) : [],
    drift: (await mappingDrift(actor.tenant.id, [mappingId])).get(mappingId) ?? null,
    merge,
  };
}
