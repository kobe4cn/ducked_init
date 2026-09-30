// app/.server/sources.ts —— 数据源：登记、修改与轮换凭据、测试连接、采集表清单与列统计、确认水位线字段。一律限定在操作者所属租户内。
// 登记与修改时平台探测账号写权限，可写即拒绝；凭据用租户数据密钥加密保存，任何界面与接口都不回显。
// 列统计由采集任务（source.profile）在工作进程里产出，保存在任务结果中；成员确认的水位线字段保存在 source_tables
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { getDb, isUniqueViolation } from './db/client';
import { sources, sourceTables, tasks, type TaskStatus } from './db/schema';
import { inspectSource, type SourceSpec, type TableProfile, type WriteGrant } from './pipeline/source-engine';
import type { SyncMode } from '../lib/sources';
import { decryptForTenant, encryptForTenant } from './secrets';
import {
  credentialsContext, isSourceKind, loadSourceSpec, parseSourceInput, requireSource, resolveSourceSpec, SourceError, type SourceInput,
} from './source-config';
import { enqueueTask } from './tasks';

export { SourceError, type SourceInput } from './source-config';

/** 平台进程里探测数据源（登记、修改、测试连接）时 DuckDB 的资源上限 */
const PROBE_LIMITS = { memoryLimitMb: 256, threads: 1 };

/** 没有水位线字段、行数达到这个值的大表全量比对时默认每天同步一次，而不是每小时（SOURCE_LARGE_TABLE_ROWS，默认 1000 万） */
const largeTableRows = () => Number(process.env.SOURCE_LARGE_TABLE_ROWS ?? 10_000_000);

/** 列出可写对象时最多举几个例子 */
const GRANT_EXAMPLES = 5;

function describeWriteGrants(user: string | undefined, grants: WriteGrant[]) {
  const shown = grants.slice(0, GRANT_EXAMPLES).map(g => `${g.object}（${g.privileges.join('、')}）`).join('；');
  const more = grants.length > GRANT_EXAMPLES ? `等 ${grants.length} 项` : '';
  return `账号${user ? ` ${user} ` : ''}对数据源可写，平台只接受只读账号：${shown}${more}。请换用只读账号，或收回这些权限后重试`;
}

/** 一张源表都读不了时的说明，附上需要授予的权限 */
function describeNoReadGrants(user: string, unreadable: string[], schemas: string[]) {
  const grants = schemas.map(s => `GRANT USAGE ON SCHEMA ${s} TO ${user}; GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${user};`).join(' ');
  return `账号 ${user} 没有读权限，${unreadable.length} 张源表都读不了。请在源库授予：${grants}`;
}

/**
 * 连接数据源、列出表并探测读写权限：连不上、账号可写或一张表都读不了时抛出 SourceError。
 * 部分表没有读权限时照常通过，返回这些表（采集时跳过）
 */
async function probe(spec: SourceSpec) {
  const { tables, unreadable, unreadableSchemas, writable } = await inspectSource(spec, PROBE_LIMITS).catch(e => {
    throw new SourceError(`无法连接数据源：${(e as Error).message}`);
  });
  const user = 'user' in spec ? spec.user : undefined;
  if (writable.length) throw new SourceError(describeWriteGrants(user, writable));
  if (!tables.length && unreadable.length) throw new SourceError(describeNoReadGrants(user ?? '', unreadable, unreadableSchemas));
  return { tables, unreadable };
}

/** 提交一次采集任务（登记、修改后与成员手动重新采集） */
const enqueueProfile = (tenantId: string, sourceId: string) => enqueueTask(tenantId, 'source.profile', { sourceId });

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

/** 登记数据源：校验连接与只读后加密保存凭据，随即提交一次采集任务 */
export async function registerSource(actor: CurrentMember, input: SourceInput) {
  assertCan(actor, 'sources:write');
  const kind = input.kind ?? '';
  if (!isSourceKind(kind)) throw new SourceError('请选择数据源类型');
  const name = parseName(input.name);
  const { config, credentials } = await parseSourceInput(actor.tenant.id, kind, input);
  const { tables, unreadable } = await probe(await resolveSourceSpec(actor.tenant.id, kind, config, credentials));

  const id = randomUUID();
  const sealed = await encryptForTenant(actor.tenant.id, credentialsContext(id), credentials);
  await uniqueName(name, () => getDb().transaction(async tx => {
    await tx.insert(sources).values({ id, tenantId: actor.tenant.id, spaceId: actor.space.id, name, kind, config, credentials: sealed });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source.registered',
      targetType: 'source',
      targetId: id,
      detail: { name, kind, tables: tables.length },
    });
  }));
  await enqueueProfile(actor.tenant.id, id);
  return { id, tables, unreadable };
}

/**
 * 表的同步方式：成员确认了水位线字段 → 水位线增量；有候选未确认 → 待确认；
 * 没有候选的表 → 全量比对（大表默认每天一次，见 ADR-0010）
 */
function syncModeOf(table: TableProfile, watermark: string | null): { syncMode: SyncMode; syncModeNote: string } {
  if (watermark) return { syncMode: 'watermark', syncModeNote: `按 ${watermark} 增量同步` };
  if (table.watermarkCandidates.length) return { syncMode: 'needs_confirmation', syncModeNote: '平台找到了可用的水位线字段，请确认' };
  const note = '没有更新时间或自增主键，每次全量拉取并与上一版比对';
  const threshold = largeTableRows();
  if (table.rows < threshold) return { syncMode: 'full_compare', syncModeNote: note };
  return { syncMode: 'full_compare', syncModeNote: `${note}；行数达到 ${threshold.toLocaleString('zh-CN')}（大表，默认每天同步一次）` };
}

/** 数据源最近一次采集任务（任何状态），以及最近一次成功的采集结果 */
async function latestProfiles(tenantId: string, sourceId: string) {
  const ofSource = and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'source.profile'), sql`${tasks.params}->>'sourceId' = ${sourceId}`);
  const [latest]: (typeof tasks.$inferSelect | undefined)[] = await getDb().select().from(tasks).where(ofSource).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  const [succeeded]: (typeof tasks.$inferSelect | undefined)[] = latest?.status === 'succeeded'
    ? [latest]
    : await getDb().select().from(tasks).where(and(ofSource, eq(tasks.status, 'succeeded'))).orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return {
    latest,
    tables: (succeeded?.result?.tables ?? []) as TableProfile[],
    unreadable: (succeeded?.result?.unreadable ?? []) as string[],
    profiledAt: succeeded?.finishedAt ?? null,
  };
}

export async function listSources(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const rows = await getDb()
    .select({ id: sources.id, name: sources.name, kind: sources.kind, config: sources.config, createdAt: sources.createdAt })
    .from(sources)
    .where(eq(sources.tenantId, actor.tenant.id))
    .orderBy(sources.createdAt, sources.name);
  return rows;
}

/** 数据源详情：连接参数（不含凭据）、最近一次采集的状态（及跳过的无读权限的表）、各表的列统计、水位线候选与同步方式 */
export async function getSource(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:read');
  const { credentials: _sealed, ...row } = await requireSource(actor.tenant.id, sourceId);
  const { latest, tables, unreadable, profiledAt } = await latestProfiles(actor.tenant.id, sourceId);
  const confirmed = new Map(
    (await getDb().select().from(sourceTables).where(eq(sourceTables.sourceId, sourceId))).map(t => [t.tableName, t]),
  );
  return {
    ...row,
    profile: {
      status: (latest?.status ?? 'none') as TaskStatus | 'none',
      error: latest?.error ?? null,
      /** 最近一次采集（任何状态）提交的时间：重新采集后即便结果相同，成员也能看出是新的一次 */
      attemptedAt: latest?.createdAt ?? null,
      unreadable,
      profiledAt,
    },
    tables: tables.map(t => {
      const c = confirmed.get(t.name);
      // 采集后字段不再是候选（被删除、改名或出现空值）时，之前的确认不再生效
      const watermark = c?.watermarkColumn && t.watermarkCandidates.some(w => w.column === c.watermarkColumn) ? c.watermarkColumn : null;
      return { ...t, watermark, confirmedBy: watermark ? c!.confirmedByEmail : null, ...syncModeOf(t, watermark) };
    }),
  };
}

/** 成员从平台给出的候选中确认某张表的水位线字段 */
export async function confirmWatermark(actor: CurrentMember, sourceId: string, tableName: string, column: string) {
  assertCan(actor, 'sources:write');
  const row = await requireSource(actor.tenant.id, sourceId);
  const { tables } = await latestProfiles(actor.tenant.id, sourceId);
  const table = tables.find(t => t.name === tableName);
  if (!table) throw new SourceError(`数据源中没有表 ${tableName}`, 404);
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

/** 重新采集表清单与列统计（源表结构变化后） */
export async function refreshSourceProfile(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:write');
  await requireSource(actor.tenant.id, sourceId);
  return enqueueProfile(actor.tenant.id, sourceId);
}

/** 测试连接：用保存的凭据连接数据源，列出表并再次探测读写权限 */
export async function testSource(actor: CurrentMember, sourceId: string) {
  assertCan(actor, 'sources:write');
  return probe(await loadSourceSpec(actor.tenant.id, sourceId));
}

/**
 * 修改连接参数或轮换凭据：凭据字段留空表示沿用原有的（连接目标变了时须重新填写）。
 * 与登记一样先校验连接与只读，通过后才保存，随即重新采集
 */
export async function updateSource(actor: CurrentMember, sourceId: string, input: SourceInput) {
  assertCan(actor, 'sources:write');
  const row = await requireSource(actor.tenant.id, sourceId);
  const name = parseName(input.name);
  const previous = await decryptForTenant(actor.tenant.id, credentialsContext(row.id), row.credentials);
  const { config, credentials } = await parseSourceInput(actor.tenant.id, row.kind, input, { config: row.config, credentials: previous });
  await probe(await resolveSourceSpec(actor.tenant.id, row.kind, config, credentials));

  const rotated = JSON.stringify(credentials) !== JSON.stringify(previous);
  const changed = Object.keys({ ...row.config, ...config }).filter(k => row.config[k] !== config[k]);
  await uniqueName(name, () => getDb().transaction(async tx => {
    await tx.update(sources).set({
      name,
      config,
      ...(rotated && { credentials: await encryptForTenant(actor.tenant.id, credentialsContext(row.id), credentials), credentialsRotatedAt: new Date() }),
      updatedAt: new Date(),
    }).where(and(eq(sources.id, row.id), eq(sources.tenantId, actor.tenant.id)));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'source.updated',
      targetType: 'source',
      targetId: row.id,
      detail: { name, ...(name !== row.name && { renamedFrom: row.name }), changed, credentialsRotated: rotated },
    });
  }));
  await enqueueProfile(actor.tenant.id, row.id);
}
