// app/.server/sources.ts —— 数据源：登记、修改与轮换凭据、测试连接、列出表、选定同步范围、采集列统计、确认水位线字段。一律限定在操作者所属租户内。
// 登记与修改时平台探测账号写权限，可写即拒绝；凭据用租户数据密钥加密保存，任何界面与接口都不回显。
// 列出表在平台进程里进行（与测试连接相同，不读任何行），表清单、成员选定的同步范围（ADR-0013）与确认的水位线字段、业务主键、软删除字段保存在 source_tables。
// 列统计由采集任务（source.profile）在工作进程里产出，只采集同步范围内的表，保存在任务结果中。
// 同步见 source-sync.ts
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb, isUniqueViolation } from './db/client';
import { mappings, mappingVersions, sources, sourceTables, sourceViews, sourceViewVersions, tasks, type TaskStatus } from './db/schema';
import { crossSourceReferrers, lockTenant, pendingMerge } from './mappings';
import {
  inspectSource, isKeyType, isSoftDeleteType, mongoReadGrant, SOFT_DELETE_NAME, type ListedTable, type SourceSpec, type TableProfile,
  type WriteGrant,
} from './pipeline/source-engine';
import type { TaskKind } from './pipeline/handlers';
import type { SyncTableParam } from './pipeline/sync-engine';
import type { SyncMode } from '../lib/sources';
import { decryptForTenant, encryptForTenant } from './secrets';
import {
  credentialsContext, isSourceKind, loadSourceSpec, parseSourceInput, requireSource, resolveSourceSpec, SourceError, type SourceInput,
} from './source-config';
import { enqueueKeyCheck } from './source-key-check';
import { ofSource } from './source-sync';
import { insertTask } from './tasks';
import { looksSensitive } from '../lib/sensitive';

export { SourceError, type SourceInput } from './source-config';

/** 平台进程里探测数据源（登记、修改、测试连接）时 DuckDB 的资源上限 */
const PROBE_LIMITS = { memoryLimitMb: 256, threads: 1 };

/** 没有水位线字段、行数达到这个值的大表全量比对时默认每天同步一次，而不是每小时（SOURCE_LARGE_TABLE_ROWS，默认 1000 万） */
const largeTableRows = () => Number(process.env.SOURCE_LARGE_TABLE_ROWS ?? 10_000_000);
/** 数据源的同步周期（SOURCE_SYNC_INTERVAL_MINUTES，默认 60 分钟）：水位线表增量同步，其余表全量比对 */
export const syncIntervalMinutes = () => Number(process.env.SOURCE_SYNC_INTERVAL_MINUTES ?? 60);
/** 全量比对的大表多久同步一次（SOURCE_LARGE_TABLE_SYNC_HOURS，默认 24 小时） */
export const largeTableSyncHours = () => Number(process.env.SOURCE_LARGE_TABLE_SYNC_HOURS ?? 24);

/** 列出可写对象时最多举几个例子 */
const GRANT_EXAMPLES = 5;

function describeWriteGrants(user: string | undefined, grants: WriteGrant[]) {
  const shown = grants.slice(0, GRANT_EXAMPLES).map(g => `${g.object}（${g.privileges.join('、')}）`).join('；');
  const more = grants.length > GRANT_EXAMPLES ? `等 ${grants.length} 项` : '';
  return `账号${user ? ` ${user} ` : ''}对数据源可写，平台只接受只读账号：${shown}${more}。请换用只读账号，或收回这些权限后重试`;
}

/** 一张源表都读不了时的说明，附上需要授予的权限 */
function describeNoReadGrants(spec: SourceSpec, unreadable: string[], schemas: string[]) {
  const user = 'user' in spec ? spec.user : '';
  const grants = spec.kind === 'mongodb'
    ? mongoReadGrant(spec)
    : schemas.map(s => `GRANT USAGE ON SCHEMA ${s} TO ${user}; GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${user};`).join(' ');
  return `账号 ${user} 没有读权限，${unreadable.length} 张源表都读不了。请在源库授予：${grants}`;
}

/**
 * 连接数据源、列出表（不读任何行）并探测读写权限：连不上、账号可写或一张表都读不了时抛出 SourceError。
 * 部分表没有读权限时照常通过，返回这些表（不能选入同步范围）
 */
async function probe(spec: SourceSpec) {
  const { tables, unreadable, unreadableSchemas, listed, writable } = await inspectSource(spec, PROBE_LIMITS).catch(e => {
    throw new SourceError(`无法连接数据源：${(e as Error).message}`);
  });
  const user = 'user' in spec ? spec.user : undefined;
  if (writable.length) throw new SourceError(describeWriteGrants(user, writable));
  if (!tables.length && unreadable.length) throw new SourceError(describeNoReadGrants(spec, unreadable, unreadableSchemas));
  return { tables, unreadable, listed };
}

/**
 * 把列出表的结果记进 source_tables：新出现的表默认不在同步范围内；源端已经没有的表记下发现的时间，
 * 不移出范围（又出现时清空）。同步范围与成员确认的设置都不变
 */
async function recordListing(tx: Tx, sourceId: string, listed: ListedTable[]) {
  if (listed.length) {
    await tx.insert(sourceTables)
      .values(listed.map(t => ({ sourceId, tableName: t.name, tableSchema: t.schema, readable: t.readable, estimatedRows: t.estimatedRows })))
      .onConflictDoUpdate({
        target: [sourceTables.sourceId, sourceTables.tableName],
        set: { tableSchema: sql`excluded.table_schema`, readable: sql`excluded.readable`, estimatedRows: sql`excluded.estimated_rows`, goneAt: null },
      });
  }
  await tx.update(sourceTables).set({ goneAt: new Date() }).where(and(
    eq(sourceTables.sourceId, sourceId),
    isNull(sourceTables.goneAt),
    ...(listed.length ? [notInArray(sourceTables.tableName, listed.map(t => t.name))] : []),
  ));
}

/** 同步范围内、源端仍在且可读的表：采集与同步的对象 */
const isSyncable = (t: typeof sourceTables.$inferSelect) => t.inScope && !t.goneAt && t.readable;

/** 为同步范围内的表提交一次采集任务（修改连接、重新列出表后）；范围内没有表时不提交，返回 null */
async function enqueueScopedProfile(tx: Tx, tenantId: string, sourceId: string) {
  const scoped = (await tx.select().from(sourceTables).where(eq(sourceTables.sourceId, sourceId)).orderBy(sourceTables.tableName))
    .filter(isSyncable).map(t => t.tableName);
  return scoped.length ? insertTask(tx, tenantId, 'source.profile', { sourceId, tables: scoped }) : null;
}

/** 名称重复时给出业务错误 */
async function uniqueName<T>(name: string, write: () => Promise<T>) {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e)) throw new SourceError(`数据源名称已存在：${name}`);
    throw e;
  }
}

const parseName = (raw: string | undefined) => {
  const name = (raw ?? '').trim();
  if (!name) throw new SourceError('请填写数据源名称');
  return name;
};

/** 登记数据源：校验连接与只读后加密保存凭据，记下列出的表。所有表都不在同步范围内，等成员选表后才采集与同步 */
export async function registerSource(actor: CurrentMember, input: SourceInput) {
  assertCan(actor, 'sources:write');
  const kind = input.kind ?? '';
  if (!isSourceKind(kind)) throw new SourceError('请选择数据源类型');
  const name = parseName(input.name);
  const { config, credentials } = await parseSourceInput(actor.tenant.id, kind, input);
  const { tables, unreadable, listed } = await probe(await resolveSourceSpec(actor.tenant.id, kind, config, credentials));

  const id = randomUUID();
  const sealed = await encryptForTenant(actor.tenant.id, credentialsContext(id), credentials);
  await uniqueName(name, () => getDb().transaction(async tx => {
    await tx.insert(sources).values({ id, tenantId: actor.tenant.id, spaceId: actor.space.id, name, kind, config, credentials: sealed });
    await recordListing(tx, id, listed);
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source.registered',
      targetType: 'source',
      targetId: id,
      detail: { name, kind, tables: tables.length },
    });
  }));
  return { id, tables, unreadable };
}

/** 没有水位线、行数达到大表阈值的表：全量比对默认每天一次 */
const isLarge = (table: TableProfile, watermark: string | null) => !watermark && !table.watermarkCandidates.length && table.rows >= largeTableRows();

/** 同步频率的说法：每小时、每天、每 N 分钟 / 小时 */
const every = (minutes: number) =>
  (minutes === 60 ? '每小时' : minutes === 1440 ? '每天' : minutes % 60 ? `每 ${minutes} 分钟` : `每 ${minutes / 60} 小时`);

/**
 * 表的同步方式：成员确认了水位线字段 → 水位线增量；有候选未确认 → 待确认；
 * 没有候选的表 → 全量比对（大表默认每天一次，其余随数据源每小时一次，见 ADR-0010）
 */
function syncModeOf(table: TableProfile, watermark: string | null): { syncMode: SyncMode; syncModeNote: string } {
  const interval = every(syncIntervalMinutes());
  if (watermark) return { syncMode: 'watermark', syncModeNote: `按 ${watermark} ${interval}增量同步` };
  if (table.watermarkCandidates.length) return { syncMode: 'needs_confirmation', syncModeNote: '平台找到了可用的水位线字段，请确认' };
  if (!isLarge(table, watermark)) return { syncMode: 'full_compare', syncModeNote: `没有更新时间或自增主键：${interval}全量比对一次` };
  return {
    syncMode: 'full_compare',
    syncModeNote: `没有更新时间或自增主键，行数达到 ${largeTableRows().toLocaleString('zh-CN')}（大表）：${every(largeTableSyncHours() * 60)}全量比对一次`,
  };
}

/**
 * 数据源最近一次采集任务（任何状态），以及给定各表最近一次成功采集到的列统计（每次采集只覆盖当时选入的表，
 * 各表取各自最近的一次）与其中最晚的完成时间
 */
async function latestProfiles(tenantId: string, sourceId: string, names: string[]) {
  const ofSource = and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'source.profile'), sql`${tasks.params}->>'sourceId' = ${sourceId}`);
  const [latest]: (typeof tasks.$inferSelect | undefined)[] = await getDb().select().from(tasks).where(ofSource).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  const { rows } = names.length
    ? await getDb().execute<{ profile: TableProfile; finished_at: string }>(sql`
        SELECT DISTINCT ON (p->>'name') p AS profile, t.finished_at
        FROM ${tasks} t CROSS JOIN LATERAL jsonb_array_elements(t.result->'tables') p
        WHERE t.tenant_id = ${tenantId} AND t.kind = 'source.profile' AND t.status = 'succeeded' AND t.params->>'sourceId' = ${sourceId}
          AND p->>'name' = ANY(${sql.param(names)}::text[])
        ORDER BY p->>'name', t.created_at DESC, t.id DESC`)
    : { rows: [] };
  const finished = rows.map(r => new Date(r.finished_at).getTime());
  return {
    latest,
    profiles: new Map(rows.map(r => [r.profile.name, r.profile])),
    profiledAt: finished.length ? new Date(Math.max(...finished)) : null,
  };
}

export async function listSources(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const rows = await getDb()
    .select({ id: sources.id, name: sources.name, kind: sources.kind, config: sources.config, createdAt: sources.createdAt })
    .from(sources)
    .where(and(eq(sources.tenantId, actor.tenant.id), isNull(sources.deletedAt)))
    .orderBy(sources.createdAt, sources.name);
  return rows;
}

/**
 * 表清单（按表名），以及同步范围内、源端仍在且可读、已经采集过的各表的列统计，带成员确认且仍然有效的水位线字段（没有时为 null）
 * 及其种类、业务主键与软删除字段。
 * 采集后水位线字段不再是候选（被删除、改名、出现空值），业务主键的列不在了或源表有了主键，软删除字段不在了或表没有了主键时，
 * 之前的确认不再生效
 */
export async function confirmedTables(tenantId: string, sourceId: string) {
  const listing = await getDb().select().from(sourceTables).where(eq(sourceTables.sourceId, sourceId)).orderBy(sourceTables.tableName);
  const syncable = listing.filter(isSyncable);
  const { latest, profiles, profiledAt } = await latestProfiles(tenantId, sourceId, syncable.map(t => t.tableName));
  const tables = syncable.flatMap(c => {
    const t = profiles.get(c.tableName);
    if (!t) return [];
    const candidate = c.watermarkColumn ? t.watermarkCandidates.find(w => w.column === c.watermarkColumn) : undefined;
    const has = (column: string, type: (t: string) => boolean) => t.columns.some(col => col.name === column && type(col.type));
    // 旧的采集结果里没有主键信息
    const key = c.keyColumns?.length && !t.primaryKey?.length && c.keyColumns.every(k => has(k, isKeyType)) ? c.keyColumns : null;
    const softDelete = c.softDeleteColumn && (t.primaryKey?.length || key) && has(c.softDeleteColumn, isSoftDeleteType) ? c.softDeleteColumn : null;
    return [{
      table: t,
      watermark: candidate ?? null,
      confirmedBy: candidate ? c.confirmedByEmail : null,
      key,
      keyConfirmedBy: key ? c.keyConfirmedByEmail : null,
      softDelete,
      softDeleteConfirmedBy: softDelete ? c.softDeleteConfirmedByEmail : null,
    }];
  });
  return { latest, listing, tables, profiledAt };
}

/**
 * 要同步的表：同步范围内、已经采集过的表中，成员确认了水位线字段（且该字段在最近一次采集中仍是候选）的按水位线增量同步，
 * 没有水位线候选的全量比对；有候选、待确认的表不同步。源端已不存在、账号读不了的表不同步。
 * 带成员声明的业务主键与软删除字段，以及是否是全量比对的大表（默认每天同步一次）
 */
export async function syncTables(tenantId: string, sourceId: string): Promise<{ param: SyncTableParam; large: boolean }[]> {
  const { tables } = await confirmedTables(tenantId, sourceId);
  return tables.flatMap(({ table, watermark, key, softDelete }) => {
    if (!watermark && table.watermarkCandidates.length) return [];
    const param: SyncTableParam = {
      name: table.name,
      ...(watermark && { column: watermark.column, kind: watermark.kind }),
      ...(key && { key }),
      ...(softDelete && { softDelete }),
    };
    return [{ param, large: isLarge(table, watermark?.column ?? null) }];
  });
}

/**
 * 数据源详情：连接参数（不含凭据）、最近一次采集的状态、表清单与同步范围（账号读不了的表、源端已不存在的范围内的表、
 * 有几张新表未选），以及范围内各表的列统计、水位线候选与同步方式。
 * 新表：不在范围内、在成员最近一次修改同步范围之后才列出的表（成员还没看过）
 */
export async function getSource(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:read');
  const { credentials: _sealed, ...row } = await requireSource(actor.tenant.id, sourceId);
  const { latest, listing, tables, profiledAt } = await confirmedTables(actor.tenant.id, sourceId);
  const reviewedAt = Math.max(0, ...listing.map(t => t.scopedAt?.getTime() ?? 0));
  // 源端已不存在、不在范围内的表不再列出
  const listed = listing.filter(t => t.inScope || !t.goneAt).map(t => ({
    name: t.tableName,
    schema: t.tableSchema,
    readable: t.readable,
    estimatedRows: t.estimatedRows,
    inScope: t.inScope,
    scopedBy: t.scopedByEmail,
    scopedAt: t.scopedAt,
    gone: !!t.goneAt,
    isNew: !t.inScope && !t.goneAt && t.discoveredAt.getTime() > reviewedAt,
  }));
  return {
    ...row,
    profile: {
      status: (latest?.status ?? 'none') as TaskStatus | 'none',
      error: latest?.error ?? null,
      /** 最近一次采集（任何状态）提交的时间：重新采集后即便结果相同，成员也能看出是新的一次 */
      attemptedAt: latest?.createdAt ?? null,
      /** 账号没有读权限的表（不能选入同步范围） */
      unreadable: listed.filter(t => !t.readable && !t.gone).map(t => t.name),
      profiledAt,
    },
    listing: listed,
    newTables: listed.filter(t => t.isNew).length,
    tables: tables.map(({ table, watermark, confirmedBy, key, keyConfirmedBy, softDelete, softDeleteConfirmedBy }) => ({
      ...table,
      // 旧的采集结果里没有主键信息
      primaryKey: table.primaryKey ?? [],
      keyCandidates: table.keyCandidates ?? [],
      /** 可以组成业务主键的列（整数、文本与 UUID） */
      keyEligibleColumns: table.columns.filter(c => isKeyType(c.type)).map(c => c.name),
      watermark: watermark?.column ?? null,
      confirmedBy,
      key,
      keyConfirmedBy,
      /** 软删除字段候选：按命名是删除标记的布尔、整数、日期与时间列 */
      softDeleteCandidates: table.columns.filter(c => isSoftDeleteType(c.type) && SOFT_DELETE_NAME.test(c.name)).map(c => c.name),
      softDelete,
      softDeleteConfirmedBy,
      ...syncModeOf(table, watermark?.column ?? null),
    })),
  };
}

/** 成员从平台给出的候选中确认某张表的水位线字段 */
export async function confirmWatermark(actor: CurrentMember, sourceId: string, tableName: string, column: string) {
  assertCan(actor, 'sources:write');
  const row = await requireSource(actor.tenant.id, sourceId);
  const table = await profiledTable(actor.tenant.id, sourceId, tableName);
  if (!table.watermarkCandidates.some(c => c.column === column)) throw new SourceError(`${column} 不是 ${tableName} 的水位线候选字段`);
  await getDb().transaction(async tx => {
    const values = { watermarkColumn: column, confirmedByEmail: actor.email, confirmedAt: new Date() };
    await tx.insert(sourceTables).values({ sourceId, tableName, ...values })
      .onConflictDoUpdate({ target: [sourceTables.sourceId, sourceTables.tableName], set: values });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source.watermark_confirmed',
      targetType: 'source',
      targetId: sourceId,
      detail: { name: row.name, table: tableName, column },
    });
  });
}

/** 同步范围内的某张表最近一次成功采集到的列统计 */
async function profiledTable(tenantId: string, sourceId: string, tableName: string) {
  const { listing, tables } = await confirmedTables(tenantId, sourceId);
  const table = tables.find(t => t.table.name === tableName)?.table;
  if (table) return table;
  const listed = listing.find(t => t.tableName === tableName);
  if (!listed) throw new SourceError(`数据源中没有表 ${tableName}`, 404);
  if (!listed.inScope) throw new SourceError(`${tableName} 不在同步范围内，请先选入`);
  throw new SourceError(`${tableName} 还没有采集到列统计，请等采集完成`);
}

/**
 * 成员为没有主键的表声明业务主键（一列或多列的组合，平台给出的候选只是样本中唯一的单列）：同步据此区分新增与更新，并发现删除。
 * 这里只校验字段，随即入队一次全表检查（source.keycheck，source-key-check.ts），返回任务；检查通过后才写回声明并记审计，
 * 不通过时原有声明不变。每次同步前还会在读到的行上再校验一次
 */
export async function confirmKey(actor: CurrentMember, sourceId: string, tableName: string, columns: string[]) {
  assertCan(actor, 'sources:write');
  await requireSource(actor.tenant.id, sourceId);
  const table = await profiledTable(actor.tenant.id, sourceId, tableName);
  if (table.primaryKey?.length) throw new SourceError(`${tableName} 已有主键 ${table.primaryKey.join('、')}，不需要业务主键`);
  if (!columns.length) throw new SourceError('请选择组成业务主键的字段');
  if (new Set(columns).size !== columns.length) throw new SourceError('业务主键的字段不能重复');
  const chosen = columns.map(column => {
    const c = table.columns.find(p => p.name === column);
    if (!c) throw new SourceError(`${tableName} 中没有字段 ${column}`);
    if (!isKeyType(c.type)) throw new SourceError(`${column} 的类型 ${c.type} 不能作业务主键（只支持整数、文本与 UUID）`);
    return c;
  });
  return getDb().transaction(tx => enqueueKeyCheck(tx, actor.tenant.id, {
    sourceId, tableName, keyColumns: columns, sensitive: chosen.some(looksSensitive), memberId: actor.memberId, email: actor.email,
  }));
}

/**
 * 成员为有主键（源端主键或业务主键）的表声明软删除字段：取值为真（布尔）、非零（整数）或非空（日期与时间）的行按源端已删除处理，
 * 同步时产出删除记录。没有主键的表不能声明：删除记录要靠主键指明删的是哪一行
 */
export async function confirmSoftDelete(actor: CurrentMember, sourceId: string, tableName: string, column: string) {
  assertCan(actor, 'sources:write');
  const row = await requireSource(actor.tenant.id, sourceId);
  const table = await profiledTable(actor.tenant.id, sourceId, tableName);
  const { tables } = await confirmedTables(actor.tenant.id, sourceId);
  if (!table.primaryKey?.length && !tables.find(t => t.table.name === tableName)?.key) {
    throw new SourceError(`${tableName} 没有主键，请先声明业务主键，再声明软删除字段`);
  }
  const profiled = table.columns.find(c => c.name === column);
  if (!profiled) throw new SourceError(`${tableName} 中没有字段 ${column}`);
  if (!isSoftDeleteType(profiled.type)) throw new SourceError(`${column} 的类型 ${profiled.type} 不能作软删除字段（只支持布尔、整数、日期与时间）`);
  await getDb().transaction(async tx => {
    const values = { softDeleteColumn: column, softDeleteConfirmedByEmail: actor.email };
    await tx.insert(sourceTables).values({ sourceId, tableName, ...values })
      .onConflictDoUpdate({ target: [sourceTables.sourceId, sourceTables.tableName], set: values });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source.soft_delete_confirmed',
      targetType: 'source',
      targetId: sourceId,
      detail: { name: row.name, table: tableName, column },
    });
  });
}

/**
 * 成员修改同步范围：add 中的表选入，remove 中的表移出（已经在 / 不在范围内的忽略），记下成员与时间并记入审计。
 * 只能选入源端仍在、账号可读的表；选入的表随即入队一次采集。移出只停止采集与同步，原始层、主键状态与镜像都保留。
 * 已被已发布映射引用的表不能移出（ADR-0013）
 */
export async function setSyncScope(actor: CurrentMember, sourceId: string, { add = [], remove = [] }: { add?: string[]; remove?: string[] }) {
  assertCan(actor, 'sources:write');
  const row = await requireSource(actor.tenant.id, sourceId);
  return getDb().transaction(async tx => {
    const listing = new Map((await tx.select().from(sourceTables).where(eq(sourceTables.sourceId, sourceId)).for('update')).map(t => [t.tableName, t]));
    for (const name of [...add, ...remove]) {
      const t = listing.get(name);
      if (!t || (t.goneAt && !t.inScope)) throw new SourceError(`数据源中没有表 ${name}`);
    }
    for (const t of add.map(name => listing.get(name)!).filter(t => !t.inScope)) {
      const name = t.tableName;
      if (t.goneAt) throw new SourceError(`源端已不存在表 ${name}，不能选入同步范围`);
      if (!t.readable) throw new SourceError(`账号没有表 ${name} 的读权限，不能选入同步范围。请在源端授予后重新列出表`);
    }
    const added = [...listing.values()].filter(t => add.includes(t.tableName) && !t.inScope).map(t => t.tableName);
    const removed = [...listing.values()].filter(t => remove.includes(t.tableName) && !add.includes(t.tableName) && t.inScope).map(t => t.tableName);
    // 已被已发布映射引用的表不能移出范围：标准层还要从它的变更批次合并。停用的映射不算（ADR-0031），恢复前要先选回范围
    const mapped = removed.length
      ? await tx.selectDistinct({ table: mappings.tableName }).from(mappings)
        .innerJoin(mappingVersions, and(eq(mappingVersions.mappingId, mappings.id), eq(mappingVersions.status, 'published')))
        .where(and(eq(mappings.sourceId, sourceId), isNull(mappings.disabledAt), inArray(mappings.tableName, removed)))
      : [];
    if (mapped.length) throw new SourceError(`${mapped.map(m => m.table).join('、')} 已被已发布的映射引用，不能移出同步范围`);
    if (!added.length && !removed.length) return { added, removed, task: null };
    const scoped = { scopedByEmail: actor.email, scopedAt: new Date() };
    const named = (names: string[]) => and(eq(sourceTables.sourceId, sourceId), inArray(sourceTables.tableName, names));
    if (added.length) await tx.update(sourceTables).set({ inScope: true, ...scoped }).where(named(added));
    if (removed.length) await tx.update(sourceTables).set({ inScope: false, ...scoped }).where(named(removed));
    const task = added.length ? await insertTask(tx, actor.tenant.id, 'source.profile', { sourceId, tables: added }) : null;
    // 审计放在入队之后：记目录版本拿的锁要是事务里最后一个锁（见 catalog/versions.ts）
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source.scope_changed',
      targetType: 'source',
      targetId: sourceId,
      detail: { name: row.name, added, removed },
    });
    return { added, removed, task };
  });
}

/** 重新列出表（源端加了表、删了表或改了权限后），并重新采集同步范围内的表（源表结构变化后）。范围内没有表时只列出表 */
export async function relistSource(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:write');
  const { listed } = await probe(await loadSourceSpec(actor.tenant.id, sourceId));
  return getDb().transaction(async tx => {
    await recordListing(tx, sourceId, listed);
    return enqueueScopedProfile(tx, actor.tenant.id, sourceId);
  });
}

/** 测试连接：用保存的凭据连接数据源，列出表并再次探测读写权限 */
export async function testSource(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:write');
  return probe(await loadSourceSpec(actor.tenant.id, sourceId));
}

/**
 * 修改连接参数或轮换凭据：凭据字段留空表示沿用原有的（连接目标变了时须重新填写）。
 * 与登记一样先校验连接与只读，通过后才保存，随即重新列出表并采集同步范围内的表
 */
export async function updateSource(actor: CurrentMember, sourceId: string, input: SourceInput) {
  assertCan(actor, 'sources:write');
  const row = await requireSource(actor.tenant.id, sourceId);
  const name = parseName(input.name);
  const previous = await decryptForTenant(actor.tenant.id, credentialsContext(row.id), row.credentials);
  const { config, credentials } = await parseSourceInput(actor.tenant.id, row.kind, input, { config: row.config, credentials: previous });
  const { listed } = await probe(await resolveSourceSpec(actor.tenant.id, row.kind, config, credentials));

  const rotated = JSON.stringify(credentials) !== JSON.stringify(previous);
  const changed = Object.keys({ ...row.config, ...config }).filter(k => row.config[k] !== config[k]);
  await uniqueName(name, () => getDb().transaction(async tx => {
    await tx.update(sources).set({
      name,
      config,
      ...(rotated && { credentials: await encryptForTenant(actor.tenant.id, credentialsContext(row.id), credentials), credentialsRotatedAt: new Date() }),
      updatedAt: new Date(),
    }).where(and(eq(sources.id, row.id), eq(sources.tenantId, actor.tenant.id)));
    await recordListing(tx, row.id, listed);
    await enqueueScopedProfile(tx, actor.tenant.id, row.id);
    // 审计放在入队之后：记目录版本拿的锁要是事务里最后一个锁（见 catalog/versions.ts）
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source.updated',
      targetType: 'source',
      targetId: row.id,
      detail: { name, ...(name !== row.name && { renamedFrom: row.name }), changed, credentialsRotated: rotated },
    });
  }));
}

/** 删除前要等它们结束的源任务（ADR-0044） */
const SOURCE_TASK_LABELS: Partial<Record<TaskKind, string>> = {
  'source.profile': '采集', 'source.sync': '同步', 'source.verify': '核对', 'source.keycheck': '业务主键检查',
};

/**
 * 不能删除数据源的全部原因（ADR-0044），可以删时为空：有已发布且没停用的映射（先走双人停用，ADR-0031）、
 * 被别的数据源跨源引用（ADR-0030）、有排队中或运行中的源任务或合并任务
 */
export async function deleteBlockers(tx: Tx, tenantId: string, sourceId: string): Promise<string[]> {
  const reasons: string[] = [];
  const live = await tx.selectDistinct({ table: mappings.tableName, entity: mappings.entity }).from(mappings)
    .innerJoin(mappingVersions, eq(mappingVersions.mappingId, mappings.id))
    .where(and(eq(mappings.sourceId, sourceId), eq(mappings.tenantId, tenantId), isNull(mappings.disabledAt), eq(mappingVersions.status, 'published')))
    .orderBy(mappings.tableName, mappings.entity);
  if (live.length) reasons.push(`有已发布且没停用的映射：${live.map(m => `${m.table} → ${m.entity}`).join('、')}，先停用它们`);

  const referrers = (await crossSourceReferrers(tx, tenantId, sourceId)).filter(r => r.sourceId !== sourceId);
  if (referrers.length) {
    const names = new Map((await tx.select({ id: sources.id, name: sources.name }).from(sources)
      .where(inArray(sources.id, referrers.map(r => r.sourceId)))).map(row => [row.id, row.name]));
    reasons.push(`被别的数据源跨源引用：${referrers.map(r => `${names.get(r.sourceId)} 的 ${r.mapping}（${r.columns.join('、')}）`).join('；')}，先改掉或停用它们`);
  }

  const kinds = Object.keys(SOURCE_TASK_LABELS) as TaskKind[];
  const pending = await tx.selectDistinct({ kind: tasks.kind }).from(tasks)
    .where(and(ofSource(tenantId, sourceId, kinds), inArray(tasks.status, ['queued', 'running'])));
  if (pending.length) reasons.push(`有排队中或运行中的任务：${kinds.filter(k => pending.some(p => p.kind === k)).map(k => SOURCE_TASK_LABELS[k]).join('、')}`);
  if (await pendingMerge(tx, tenantId)) reasons.push('有排队中或运行中的合并任务');
  return reasons;
}

/**
 * 删除数据源（ADR-0044）：有发布权限的成员，deleteBlockers 没有原因时才能删（否则 400 并列出原因）。
 * 只软删：丢弃没发布过的映射与映射草稿、再丢弃没发布过的源视图与源视图草稿（映射引用源视图，顺序不能反），清空同步范围，
 * 凭据写成空串，打上删除标记；已停用的映射与已发布版本保留。原始层的清理不在这里
 */
export async function deleteSource(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'publish');
  const tenantId = actor.tenant.id;
  await requireSource(tenantId, sourceId);
  await getDb().transaction(async tx => {
    // 先锁源表行（与修改同步范围、恢复映射同序，不死锁），再锁数据源行（与入队同步、核对同一把锁），最后锁租户行（与发布、停用、入队合并互斥）
    await tx.select({ table: sourceTables.tableName }).from(sourceTables).where(eq(sourceTables.sourceId, sourceId)).for('update');
    const [row] = await tx.select().from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.tenantId, tenantId), isNull(sources.deletedAt))).for('update');
    if (!row) throw new SourceError('数据源不存在', 404);
    await lockTenant(tx, tenantId);
    const reasons = await deleteBlockers(tx, tenantId, sourceId);
    if (reasons.length) throw new SourceError(`不能删除数据源「${row.name}」：${reasons.join('；')}`);

    const publishedMapping = sql`exists (select 1 from ${mappingVersions} v where v.mapping_id = ${mappings.id} and v.status = 'published')`;
    await tx.delete(mappings).where(and(eq(mappings.sourceId, sourceId), sql`not ${publishedMapping}`));
    await tx.delete(mappingVersions).where(and(eq(mappingVersions.status, 'draft'),
      inArray(mappingVersions.mappingId, tx.select({ id: mappings.id }).from(mappings).where(eq(mappings.sourceId, sourceId)))));
    const publishedView = sql`exists (select 1 from ${sourceViewVersions} v where v.view_id = ${sourceViews.id} and v.status = 'published')`;
    await tx.delete(sourceViews).where(and(eq(sourceViews.sourceId, sourceId), sql`not ${publishedView}`));
    await tx.delete(sourceViewVersions).where(and(eq(sourceViewVersions.status, 'draft'),
      inArray(sourceViewVersions.viewId, tx.select({ id: sourceViews.id }).from(sourceViews).where(eq(sourceViews.sourceId, sourceId)))));
    await tx.delete(sourceTables).where(eq(sourceTables.sourceId, sourceId));
    await tx.update(sources).set({ credentials: '', deletedAt: new Date(), deletedByEmail: actor.email, updatedAt: new Date() })
      .where(eq(sources.id, sourceId));
    await recordAudit(tx, {
      tenantId, actor, action: 'source.deleted', targetType: 'source', targetId: sourceId, detail: { name: row.name, kind: row.kind },
    });
  });
}
