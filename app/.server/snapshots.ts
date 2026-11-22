// app/.server/snapshots.ts —— 结果快照：分析模板（与指标、标签）任务成功后，调度器把它写进结果层的那张表登记到平台元数据（模板、参数、任务、表名、行数，
// 创建后 90 天过期）；数据仍只在租户数据湖里（ADR-0002）。分析页列出本租户的快照，打开时在请求内只读挂载本租户的数据湖读取，
// 快照表只有 consumer_id 与分值，没有明文（ADR-0005）。登记时模板读到的实体有已发布映射在任务开始前最近一次合并失败的，照常登记，
// 但在快照上记下这些映射（数据不完整），原因只留摘要、不带源端取值。到期后调度器为每个租户入队 gold.expire 删表并清理湖里的旧文件，成功后标记 expiredAt。
// 一律限定在给定租户内
import { and, desc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { Tx } from './audit';
import { getDb } from './db/client';
import { SNAPSHOT_TRIGGERS, snapshots, tasks, tenants, type IncompleteMapping, type SnapshotTrigger } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { publishedPlans } from './mappings';
import { openTenantLake } from './pipeline/lake-engine';
import type { MergeRecord } from './pipeline/merge-engine';
import { insertTask } from './tasks';
import { readResult } from './pipeline/task-contracts';
import { TEMPLATES } from './pipeline/templates';
import { CHANNELS } from '../lib/canonical-model';
import type { RfmParams } from './pipeline/templates/rfm';
import type { CohortParams } from './pipeline/templates/cohort';
import { isDslKind, type DslKind } from './pipeline/dsl';

export type SnapshotTemplate = keyof typeof TEMPLATES;
export type Snapshot = typeof snapshots.$inferSelect;
// 快照来源的联合类型：详情页要在组件里按界面语言翻译来源名（#1050），路由层也用得到
export type { SnapshotTrigger } from './db/schema';

/** 快照 template（`metric:<键>` / `tag:<键>`）里的 DSL 种类；不是指标或标签快照时为 null */
export const dslKindOf = (template: string): DslKind | null => {
  const kind = template.split(':', 1)[0];
  return kind !== template && isDslKind(kind) ? kind : null;
};

/** 快照从创建起保留的天数 */
export const SNAPSHOT_RETENTION_DAYS = 90;

/** 快照来源在页面上的说法；老快照没记来源（null）时显示「—」 */
export const triggerLabel = (trigger: SnapshotTrigger | null) =>
  trigger ? ({ publish: '发布', backfill: '回刷', scheduled: '定时刷新', manual: '手动' } satisfies Record<SnapshotTrigger, string>)[trigger] : '—';

export const CONSUMER_PAGE_SIZE = 50;

/** 读一张快照用的计算资源 */
const READ_LIMITS = { memoryLimitMb: 256, threads: 1 };

/** 可以展示给成员的业务错误 */
export class SnapshotError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/**
 * 分析模板任务成功后登记它的快照（任务结果里的 table、rows、params，任务参数里的模板定义版本 definitionVersion 与来源 trigger），
 * 并记下任务开始前模板读到的实体里最近一次合并失败的映射（incompleteMappings）；任务没有成功（如已被判为中断）或已登记过时什么也不做
 */
export const registerSnapshot = (tenantId: string, taskId: string, template: SnapshotTemplate) =>
  registerTaskSnapshot(tenantId, taskId, () => ({ template, entities: TEMPLATES[template].entities }));

/**
 * 结果层任务成功后登记它的快照：describe 由任务参数给出快照的 template 与读到的实体，其余同 registerSnapshot。
 * 每次只新增这一张，已有的快照不变
 */
export async function registerTaskSnapshot(
  tenantId: string, taskId: string, describe: (params: Record<string, unknown>) => { template: string; entities: readonly string[] },
) {
  const db = getDb();
  const [task] = await db.select({ status: tasks.status, params: tasks.params, result: tasks.result, startedAt: tasks.startedAt }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));
  if (task?.status !== 'succeeded' || !task.result) return;
  // 登记的既有 gold.dsl 也有模板任务（gold.rfm/…）：只借 gold.dsl 的结果类型读，不带 kind（#477）
  const { table, rows, params } = readResult('gold.dsl', { result: task.result })!;
  const { definitionVersion, trigger } = task.params as { definitionVersion?: unknown; trigger?: unknown };
  const { template, entities } = describe(task.params as Record<string, unknown>);
  const incomplete = await incompleteMappings(tenantId, entities, task.startedAt ?? new Date());
  const createdAt = new Date();
  await db.insert(snapshots).values({
    tenantId, template, taskId, table, params, rowCount: rows, createdAt,
    incomplete: incomplete.length ? incomplete : null,
    definitionVersion: Number.isInteger(definitionVersion) ? definitionVersion as number : null,
    trigger: SNAPSHOT_TRIGGERS.includes(trigger as SnapshotTrigger) ? trigger as SnapshotTrigger : null,
    expiresAt: new Date(createdAt.getTime() + SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  }).onConflictDoNothing({ target: snapshots.taskId });
}

/**
 * 这些实体的已发布映射里，在 before 之前结束的合并中最近一次（跳过的不算，也不盖掉之前的结果）失败了的映射，
 * 带原因摘要与这个映射最近一次成功合并的任务的结束时间。按每个映射自己的记录判断，不看任务状态；没有 result.mappings 的合并任务不算
 */
export async function incompleteMappings(tenantId: string, entities: readonly string[], before: Date): Promise<IncompleteMapping[]> {
  const ids = (await publishedPlans(getDb(), tenantId)).filter(p => entities.includes(p.entity)).map(p => p.mapping);
  if (!ids.length) return [];
  // 映射 m.id 在 before 之前结束的合并里最近一条满足 recordFilter 的记录（FROM 起的子查询主体）
  const latestRecordWhere = (recordFilter: SQL) => sql`
    FROM ${tasks} t, jsonb_array_elements(t.result->'mappings') rec
    WHERE t.tenant_id = ${tenantId} AND t.kind = 'silver.merge' AND t.finished_at <= ${before.toISOString()}::timestamptz
      AND rec->>'mapping' = m.id::text AND ${recordFilter}
    ORDER BY t.created_at DESC, t.id DESC LIMIT 1`;
  const { rows } = await getDb().execute<{ record: MergeRecord & { error: string }; last_success_at: string | Date | null }>(sql`
    SELECT f.record, s.finished_at AS last_success_at FROM unnest(ARRAY[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::uuid[]) m(id)
    CROSS JOIN LATERAL (SELECT rec AS record ${latestRecordWhere(sql`NOT rec ? 'skipped'`)}) f
    LEFT JOIN LATERAL (SELECT t.finished_at ${latestRecordWhere(sql`rec ? 'rows'`)}) s ON true
    WHERE f.record ? 'error'
    ORDER BY m.id`);
  return rows.map(({ record: { mapping, entity, table, error }, last_success_at }) => ({
    mapping, entity, table, error: summarizeMergeError(error),
    lastSuccessAt: last_success_at === null ? null : new Date(last_success_at).toISOString(),
  }));
}

/**
 * 合并报错的摘要：只留第一个全角冒号之前的部分（冒号后是取值，如主键冲突时没有引号的键值、值字典缺失的取值），
 * 截到 120 字。原文写进任务前已在工作进程里 redact 过，这里再去掉取值
 */
export function summarizeMergeError(message: string) {
  const colon = message.indexOf('：');
  return (colon < 0 ? message : message.slice(0, colon)).slice(0, 120);
}

/**
 * 为有到期快照（expiresAt 已到、还没标记过期）的租户各入队一个 gold.expire，参数是到期快照的表名；
 * 本租户已有排队或运行中的 gold.expire 时跳过（下一次检查再补上），多个调度器同时检查也不会重复入队。返回入队了的租户
 */
export async function enqueueDueExpiries(now = new Date()) {
  const due = (db: Tx | ReturnType<typeof getDb>, tenantId?: string) => db
    .select({ tenantId: snapshots.tenantId, table: snapshots.table }).from(snapshots)
    .innerJoin(tenants, and(eq(tenants.id, snapshots.tenantId), isNull(tenants.suspendedAt)))
    .where(and(lte(snapshots.expiresAt, now), isNull(snapshots.expiredAt), tenantId ? eq(snapshots.tenantId, tenantId) : undefined))
    .orderBy(snapshots.tenantId, snapshots.table);
  const enqueued: string[] = [];
  for (const tenantId of [...new Set((await due(getDb())).map(d => d.tenantId))]) {
    try {
      const task = await getDb().transaction(async tx => {
        // 先锁住租户行再查一次：查询之后可能已有调度器入队过期、甚至已执行完
        await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
        const [pending] = await tx.select({ id: tasks.id }).from(tasks)
          .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'gold.expire'), inArray(tasks.status, ['queued', 'running']))).limit(1);
        const tables = (await due(tx, tenantId)).map(d => d.table);
        if (pending || !tables.length) return null;
        return insertTask(tx, tenantId, 'gold.expire', { tables });
      });
      if (task) enqueued.push(tenantId);
    } catch (e) {
      console.error(`[调度器] 租户 ${tenantId} 的快照过期入队失败`, e);
    }
  }
  return enqueued;
}

/** gold.expire 成功后把它删掉的表对应的快照标记为已过期；任务没有成功时什么也不做 */
export async function markExpired(tenantId: string, taskId: string) {
  const db = getDb();
  const [task] = await db.select({ status: tasks.status, params: tasks.params }).from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));
  if (task?.status !== 'succeeded') return;
  const { tables } = task.params as { tables: string[] };
  await db.update(snapshots).set({ expiredAt: new Date() })
    .where(and(eq(snapshots.tenantId, tenantId), inArray(snapshots.table, tables), isNull(snapshots.expiredAt)));
}

/** 「最新快照」的共用排序：统计日（params->>'asOf'，YYYY-MM-DD 按字符串排即按日期排）从新到旧，同一统计日按登记时间、ID 从新到旧。
 *  DESC 要写 NULLS LAST：PG 的 DESC 默认 NULLS FIRST，没有统计日的老快照（与测试里 params 为空的快照）不能排在最前 */
export const newestFirst: SQL[] = [
  sql`${snapshots.params}->>'asOf' DESC NULLS LAST`,
  desc(snapshots.createdAt),
  desc(snapshots.id),
];

/** 本租户的全部快照（给 template 时只取这个模板的，如一个定义的全部历史快照），按 newestFirst 从新到旧 */
export async function listSnapshots(tenantId: string, template?: string) {
  return getDb().select().from(snapshots)
    .where(template ? and(eq(snapshots.tenantId, tenantId), eq(snapshots.template, template)) : eq(snapshots.tenantId, tenantId))
    .orderBy(...newestFirst);
}

/** 本租户的一张快照；不存在或属于其他租户时为 null */
export async function getSnapshot(tenantId: string, id: string): Promise<Snapshot | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await getDb().select().from(snapshots).where(and(eq(snapshots.id, id), eq(snapshots.tenantId, tenantId)));
  return row ?? null;
}

/**
 * 校验快照（未过期、表名前缀与快照类型对得上）后只读挂载本租户的数据湖，返回会话与带引号的表名；调用方负责关闭会话。
 * 模板快照的表名是 gold."<模板 ID>__<任务 ID>"，指标与标签（DSL）快照是 gold."<kind>__<任务 ID>"；
 * 前缀都经过校验（登记过的模板只含小写字母与数字、kind 在 DSL 注册表里）才拼进正则
 */
async function openSnapshotTable(snapshot: Snapshot) {
  if (snapshot.expiredAt) throw new SnapshotError('快照已过期', 404);
  const dsl = dslKindOf(snapshot.template);
  // template 带「:」却不是 DSL 种类的（历史脏数据）在这里挡下，不把没校验过的字符串拼进正则
  const prefix = dsl ?? (snapshot.template.includes(':') ? null : snapshot.template);
  if (!prefix) throw new SnapshotError('不是模板快照', 404);
  const match = new RegExp(`^gold\\.(${prefix}__[0-9a-f-]{36})$`).exec(snapshot.table);
  if (!match) throw new SnapshotError('快照表名不合法', 404);
  const lake = await lakeRow(snapshot.tenantId);
  if (!lake || !lakeReady(lake)) throw new SnapshotError('本租户的数据湖还没有初始化');
  const session = await openTenantLake(lakeSpecOf(lake), READ_LIMITS, undefined, { readOnly: true });
  return { session, table: `gold."${match[1]}"` };
}

export interface RfmSegmentSummary { name: string; consumers: number; monetary: string }
export interface RfmConsumer { consumer_id: string; segment: string; r: number; f: number; m: number; recency_days: number; frequency: number; monetary: string }

/**
 * 只读挂载本租户的数据湖，读出 RFM 快照：各人群的人数与金额（按定义里的人群顺序，没有消费者的人群为 0），
 * 以及按 consumer_id 排序的第 page 页消费者明细
 */
export async function readRfmSnapshot(snapshot: Snapshot, { page, pageSize = CONSUMER_PAGE_SIZE }: { page: number; pageSize?: number }) {
  if (snapshot.template !== 'rfm') throw new SnapshotError('不是 RFM 快照', 404);
  const { session, table } = await openSnapshotTable(snapshot);
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const totals = await read<{ segment: string; consumers: string; monetary: string }>(
      `SELECT segment, count(*) AS consumers, sum(monetary)::VARCHAR AS monetary FROM ${table} GROUP BY segment`);
    const offset = (page - 1) * pageSize;
    const consumers = await read<RfmConsumer>(`
      SELECT consumer_id, segment, r, f, m, recency_days, frequency, monetary::VARCHAR AS monetary
      FROM ${table} ORDER BY consumer_id LIMIT ${pageSize} OFFSET ${offset}`);
    const segments: RfmSegmentSummary[] = (snapshot.params as unknown as RfmParams).segments.map(({ name }) => {
      const t = totals.find(x => x.segment === name);
      return { name, consumers: Number(t?.consumers ?? 0), monetary: t?.monetary ?? '0.00' };
    });
    return { segments, consumers: consumers.map(c => ({ ...c, r: Number(c.r), f: Number(c.f), m: Number(c.m), recency_days: Number(c.recency_days), frequency: Number(c.frequency) })) };
  } finally {
    session.close();
  }
}

/** 流失预警快照明细里的一位消费者：silence_ratio 是沉默天数超过平均间隔的倍数 */
export interface ChurnConsumer { consumer_id: string; orders: number; avg_gap_days: number; recency_days: number; silence_ratio: number; at_risk: boolean }

/**
 * 只读挂载本租户的数据湖，读出流失预警快照：总人数与有风险（at_risk）人数，以及按 silence_ratio 从高到低
 * （同值按 consumer_id）的第 page 页明细；filter 为 'at-risk' 时只看有风险的。分页总数按筛选后的行数算，
 * 传入的 page 超出时停在最后一页（返回夹过的 page 与 pages），调用方不用为算页数先开一次湖
 */
export async function readChurnSnapshot(
  snapshot: Snapshot,
  { page, filter, pageSize = CONSUMER_PAGE_SIZE }: { page: number; filter: 'at-risk' | 'all'; pageSize?: number },
) {
  if (snapshot.template !== 'churn') throw new SnapshotError('不是流失预警快照', 404);
  const { session, table } = await openSnapshotTable(snapshot);
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const [totals] = await read<{ total: string; at_risk: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE at_risk) AS at_risk FROM ${table}`);
    const total = Number(totals?.total ?? 0);
    const atRisk = Number(totals?.at_risk ?? 0);
    const filteredCount = filter === 'at-risk' ? atRisk : total;
    const pages = Math.max(1, Math.ceil(filteredCount / pageSize));
    const clamped = Math.min(pages, Math.max(1, page));
    const rows = await read<Record<string, unknown>>(`
      SELECT consumer_id, orders, avg_gap_days, recency_days, silence_ratio, at_risk FROM ${table}
      ${filter === 'at-risk' ? 'WHERE at_risk' : ''}
      ORDER BY silence_ratio DESC NULLS LAST, consumer_id
      LIMIT ${pageSize} OFFSET ${(clamped - 1) * pageSize}`);
    return {
      page: clamped, pages, total, atRisk, filteredCount,
      rows: rows.map((r): ChurnConsumer => ({
        consumer_id: String(r.consumer_id), orders: Number(r.orders), avg_gap_days: Number(r.avg_gap_days),
        recency_days: Number(r.recency_days), silence_ratio: Number(r.silence_ratio), at_risk: r.at_risk === true,
      })),
    };
  } finally {
    session.close();
  }
}

/**
 * 只读挂载本租户的数据湖，读出复购快照：总人数与复购人数、到第二单天数的中位数（median 自动跳过 NULL，没人有第二单时为 null），
 * 以及按 consumer_id 排序的第 page 页明细（列取快照表的全部列，同通用明细）
 */
export async function readRepurchaseSnapshot(snapshot: Snapshot, { page, pageSize = CONSUMER_PAGE_SIZE }: { page: number; pageSize?: number }) {
  if (snapshot.template !== 'repurchase') throw new SnapshotError('不是复购快照', 404);
  const { session, table } = await openSnapshotTable(snapshot);
  try {
    const [summary] = (await session.con.runAndReadAll(
      `SELECT count(*) AS total, count(*) FILTER (WHERE repurchased) AS repurchased, median(days_to_second) AS median_days_to_second FROM ${table}`,
    )).getRowObjectsJson() as { total: string; repurchased: string; median_days_to_second: number | null }[];
    const result = await session.con.runAndReadAll(
      `SELECT * FROM ${table} ORDER BY consumer_id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    return {
      total: Number(summary?.total ?? 0),
      repurchased: Number(summary?.repurchased ?? 0),
      medianDaysToSecond: summary?.median_days_to_second ?? null,
      columns: result.columnNames(),
      rows: result.getRowObjectsJson() as Record<string, unknown>[],
    };
  } finally {
    session.close();
  }
}

/** CLV 快照十档分布里的一档：decile 从 1（clv 最高的 10%）起 */
export interface ClvDecile { decile: number; consumers: number; clv: string }

/**
 * 只读挂载本租户的数据湖，读出 CLV 快照：clv 总额、前 10%（第 1 档）贡献的占比（总 clv 为 0 时不除零，为 null）、
 * 按 clv 从高到低（同值按 consumer_id）ntile(10) 分档的每档人数与合计（只列有人的档），以及按 consumer_id 排序的第 page 页明细
 */
export async function readClvSnapshot(snapshot: Snapshot, { page, pageSize = CONSUMER_PAGE_SIZE }: { page: number; pageSize?: number }) {
  if (snapshot.template !== 'clv') throw new SnapshotError('不是 CLV 快照', 404);
  const { session, table } = await openSnapshotTable(snapshot);
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const decileRows = await read<{ decile: number; consumers: string; clv: string | null }>(`
      SELECT decile, count(*) AS consumers, sum(clv)::VARCHAR AS clv FROM (
        SELECT ntile(10) OVER (ORDER BY clv DESC, consumer_id) AS decile, clv FROM ${table}
      ) GROUP BY decile ORDER BY decile`);
    const [totals] = await read<{ total_clv: string }>(`SELECT coalesce(sum(clv), 0)::VARCHAR AS total_clv FROM ${table}`);
    const totalClv = totals?.total_clv ?? '0';
    const top = decileRows.find(d => Number(d.decile) === 1);
    const topShare = Number(totalClv) > 0 && top ? Number(top.clv ?? 0) / Number(totalClv) : null;
    const result = await session.con.runAndReadAll(
      `SELECT * FROM ${table} ORDER BY consumer_id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    return {
      totalClv,
      topShare,
      deciles: decileRows.map((d): ClvDecile => ({ decile: Number(d.decile), consumers: Number(d.consumers), clv: d.clv ?? '0.00' })),
      columns: result.columnNames(),
      rows: result.getRowObjectsJson() as Record<string, unknown>[],
    };
  } finally {
    session.close();
  }
}

/** 同期群留存矩阵里的一行：cohort_start（YYYY-MM-DD）与第 0…periods-1 期各期有下单的人数（没人下单的期为 0） */
export interface CohortRow { cohortStart: string; counts: number[] }

/**
 * 只读挂载本租户的数据湖，读出同期群快照：留存矩阵（每行一个 cohort_start、按日期升序，counts[k] 是 active_periods
 * 含偏移 k 的人数，按快照 params.periods 补齐、湖上没有的期补 0，超出 periods 的偏移丢弃）与粒度 granularity，
 * 以及按 consumer_id 排序的第 page 页明细（列取快照表的全部列，同通用明细）。
 * active_periods 的首单周期是 0，所以 counts[0] 就是这个群的人数（留存率的分母）
 */
export async function readCohortSnapshot(snapshot: Snapshot, { page, pageSize = CONSUMER_PAGE_SIZE }: { page: number; pageSize?: number }) {
  if (snapshot.template !== 'cohort') throw new SnapshotError('不是同期群快照', 404);
  const { session, table } = await openSnapshotTable(snapshot);
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const { periods, granularity } = snapshot.params as unknown as CohortParams;
    const grouped = await read<{ cohort_start: string; p: number; consumers: string }>(
      `SELECT cohort_start::VARCHAR AS cohort_start, p, count(*) AS consumers FROM (SELECT cohort_start, unnest(active_periods) AS p FROM ${table}) GROUP BY ALL ORDER BY ALL`);
    // GROUP BY ALL + ORDER BY ALL 已按 cohort_start、p 升序；这里按 periods 补齐成每行等长的 counts
    const countsOf = new Map<string, number[]>();
    for (const g of grouped) {
      const counts = countsOf.get(g.cohort_start) ?? Array.from({ length: periods }, () => 0);
      const p = Number(g.p);
      if (p < periods) counts[p] = Number(g.consumers);
      countsOf.set(g.cohort_start, counts);
    }
    const matrix = [...countsOf].map(([cohortStart, counts]): CohortRow => ({ cohortStart, counts }));
    const result = await session.con.runAndReadAll(
      `SELECT * FROM ${table} ORDER BY consumer_id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    return { matrix, granularity, columns: result.columnNames(), rows: result.getRowObjectsJson() as Record<string, unknown>[] };
  } finally {
    session.close();
  }
}

/** 用户 360 汇总里各渠道的同意人数（按 CHANNELS 顺序） */
export interface User360ConsentSummary { channel: string; consumers: number }

/**
 * 只读挂载本租户的数据湖，读出用户 360 快照：一句 count 的汇总（总人数、有订单人数 orders > 0、各渠道同意人数），
 * 按 consumer_id 查单人一行，以及按 consumer_id 排序的第 page 页明细（列取快照表的全部列，同通用明细）。
 * consumerId 为空时不查；先过白名单（长度与字符集）再参数绑定取行，两道都过才落到 lookup——
 * 没过白名单记 invalid，过了但没有这一行记 missing。汇总与明细两个标签都读（卡片要用），不按标签省查询
 */
export async function readUser360Snapshot(snapshot: Snapshot, { page, consumerId, pageSize = CONSUMER_PAGE_SIZE }: { page: number; consumerId: string | null; pageSize?: number }) {
  if (snapshot.template !== 'user360') throw new SnapshotError('不是用户 360 快照', 404);
  const { session, table } = await openSnapshotTable(snapshot);
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    // 列名只来自 CHANNELS 常量；count(*) 是 BIGINT，读出来是字符串，一律 Number()
    const [summary] = await read<Record<string, string>>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE orders > 0) AS with_orders, ${
        CHANNELS.map(c => `count(*) FILTER (WHERE consent_${c}) AS consent_${c}`).join(', ')} FROM ${table}`);
    // 单人：id 先过白名单（长度与字符集），再参数绑定查一行，不把 id 拼进 SQL
    const idOk = !!consumerId && /^[0-9A-Za-z_-]{1,80}$/.test(consumerId);
    const lookup = consumerId && idOk
      ? (await session.con.runAndReadAll(`SELECT * FROM ${table} WHERE consumer_id = $1`, [consumerId])).getRowObjectsJson()[0] ?? null
      : null;
    let lookupError: 'invalid' | 'missing' | null = null;
    if (consumerId && !idOk) lookupError = 'invalid';
    else if (consumerId && !lookup) lookupError = 'missing';
    const result = await session.con.runAndReadAll(
      `SELECT * FROM ${table} ORDER BY consumer_id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    return {
      total: Number(summary?.total ?? 0),
      withOrders: Number(summary?.with_orders ?? 0),
      consents: CHANNELS.map((c): User360ConsentSummary => ({ channel: c, consumers: Number(summary?.[`consent_${c}`] ?? 0) })),
      lookup,
      lookupError,
      columns: result.columnNames(),
      rows: result.getRowObjectsJson() as Record<string, unknown>[],
    };
  } finally {
    session.close();
  }
}

/** 标签快照各取值的人数（tagSummary），NULL 取值的 value 为 null */
export interface TagValueSummary { value: string | null; consumers: number }

/**
 * 只读挂载本租户的数据湖，读出任一已登记模板或指标 / 标签（DSL）快照（列不做筛选：这些快照表不带明文，ADR-0004、0005）：
 * 快照表的全部列名（按表里的顺序），以及第 page 页明细（取值按 JSON 读出）。模板快照按 consumer_id 排序；
 * DSL 快照按全部列排序（带维度的指标每个消费者有多行，只按 consumer_id 排翻页会重复或漏行）。
 * 标签快照在同一个会话里多查一次各取值人数的汇总 tagSummary（非标签快照没有这个字段）
 */
export async function readTemplateSnapshot(snapshot: Snapshot, { page, pageSize = CONSUMER_PAGE_SIZE }: { page: number; pageSize?: number }) {
  const dsl = dslKindOf(snapshot.template);
  if (!Object.hasOwn(TEMPLATES, snapshot.template) && !dsl) throw new SnapshotError('不是模板快照', 404);
  const { session, table } = await openSnapshotTable(snapshot);
  try {
    const result = await session.con.runAndReadAll(
      `SELECT * FROM ${table} ${dsl ? 'ORDER BY ALL' : 'ORDER BY consumer_id'} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
    const tagSummary = dsl === 'tag'
      ? (await session.con.runAndReadAll(`SELECT tag_value::VARCHAR AS value, count(*) AS consumers FROM ${table} GROUP BY 1 ORDER BY 2 DESC, 1`))
        .getRowObjectsJson()
        .map((t): TagValueSummary => ({ value: t.value === null ? null : String(t.value), consumers: Number(t.consumers) }))
      : null;
    return {
      columns: result.columnNames(),
      rows: result.getRowObjectsJson() as Record<string, unknown>[],
      ...(tagSummary ? { tagSummary } : {}),
    };
  } finally {
    session.close();
  }
}
