// app/.server/exports.ts —— 人群导出（ADR-0040）：外部系统按标签条件发起导出，入队时定下每个标签用哪张快照，
// 由工作进程的 export.tags 写文件。导出 ID 就是任务 ID；一律限定在调用方的租户内
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { ApiCaller } from './api-auth';
import { recordAudit } from './audit';
import { getDb } from './db/client';
import { snapshots, tasks } from './db/schema';
import { DSL_KEY_PATTERN } from './dsl-definitions';
import { EXPORT_FORMATS, type ExportCondition, type ExportFormat } from './pipeline/handlers';
import { getSnapshot } from './snapshots';
import { insertTask, TaskError } from './tasks';

export const MAX_EXPORT_CONDITIONS = 5;
export const MAX_TAG_VALUE_LENGTH = 200;

/** 请求不合法（400），信息可以原样返回给调用方 */
export class ExportError extends Error {}

/** 请求里的一个条件（还没定下快照表） */
type RequestedCondition = Omit<ExportCondition, 'table'>;

interface ExportRequest { conditions: RequestedCondition[]; snapshots: Record<string, string>; format: ExportFormat }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 校验请求体：1–5 个条件、标签键合法且不重复、取值是 1–200 字符的字符串；snapshots 只能给条件里的标签；format 默认 parquet */
function parseRequest(body: unknown): ExportRequest {
  if (!isObject(body)) throw new ExportError('请求体必须是 JSON 对象');
  const { conditions, snapshots: requested = {}, format = 'parquet' } = body;
  if (!Array.isArray(conditions) || conditions.length === 0 || conditions.length > MAX_EXPORT_CONDITIONS) {
    throw new ExportError(`conditions 必须是 1 到 ${MAX_EXPORT_CONDITIONS} 个 { tag, value }`);
  }
  const seen = new Set<string>();
  for (const c of conditions) {
    if (!isObject(c) || typeof c.tag !== 'string' || !DSL_KEY_PATTERN.test(c.tag)) throw new ExportError(`标签键不合法：${JSON.stringify(isObject(c) ? c.tag : c)}`);
    if (seen.has(c.tag)) throw new ExportError(`标签 ${c.tag} 重复`);
    seen.add(c.tag);
    if (typeof c.value !== 'string' || c.value.length === 0 || c.value.length > MAX_TAG_VALUE_LENGTH) {
      throw new ExportError(`标签 ${c.tag} 的 value 必须是 1 到 ${MAX_TAG_VALUE_LENGTH} 个字符的字符串`);
    }
  }
  if (!isObject(requested) || !Object.entries(requested).every(([tag, id]) => seen.has(tag) && typeof id === 'string')) {
    throw new ExportError('snapshots 必须是 { <条件里的标签>: <快照 ID> }');
  }
  if (!EXPORT_FORMATS.includes(format as ExportFormat)) throw new ExportError(`format 只能是 ${EXPORT_FORMATS.join(' / ')}`);
  return {
    conditions: (conditions as RequestedCondition[]).map(({ tag, value }) => ({ tag, value })),
    snapshots: requested as Record<string, string>, format: format as ExportFormat,
  };
}

/**
 * 这个标签要用的快照：指定了就用它（须是本租户、这个标签的、未过期的，别的租户的与不存在的同样报错），
 * 否则取最新一张未过期的（按登记时间、ID 倒序）。返回快照 ID 与不带 schema 的表名
 */
async function pickSnapshot(tenantId: string, tag: string, id: string | undefined) {
  const template = `tag:${tag}`;
  const live = (s: { expiredAt: Date | null; expiresAt: Date }) => !s.expiredAt && s.expiresAt > new Date();
  const snapshot = id === undefined
    ? (await getDb().select().from(snapshots)
      .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.template, template), isNull(snapshots.expiredAt), gt(snapshots.expiresAt, new Date())))
      .orderBy(desc(snapshots.createdAt), desc(snapshots.id)).limit(1))[0]
    : await getSnapshot(tenantId, id);
  const table = snapshot && /^gold\.(tag__[0-9a-f-]{36})$/.exec(snapshot.table)?.[1];
  if (!snapshot || !table || snapshot.template !== template || !live(snapshot)) {
    throw new ExportError(id === undefined ? `标签 ${tag} 还没有可用的快照` : `标签 ${tag} 指定的快照不存在、已过期或不是这个标签的`);
  }
  return { id: snapshot.id, table };
}

/** 发起一次人群导出：校验、定下每个标签的快照后入队 export.tags，同一事务里记审计。校验不通过时抛 ExportError（400），不入队 */
export async function createExport({ tenantId, prefix }: ApiCaller, body: unknown) {
  const request = parseRequest(body);
  const picked: Record<string, string> = {};
  const conditions: ExportCondition[] = [];
  for (const { tag, value } of request.conditions) {
    const { id, table } = await pickSnapshot(tenantId, tag, request.snapshots[tag]);
    picked[tag] = id;
    conditions.push({ tag, value, table });
  }
  try {
    const task = await getDb().transaction(async tx => {
      const queued = await insertTask(tx, tenantId, 'export.tags', { format: request.format, conditions, snapshots: picked });
      await recordAudit(tx, {
        tenantId, system: true, action: 'export.requested', targetType: 'task', targetId: queued.id,
        detail: { keyPrefix: prefix, conditions: request.conditions, snapshots: picked, format: request.format },
      });
      return queued;
    });
    return { id: task.id, status: task.status, snapshots: picked };
  } catch (e) {
    if (e instanceof TaskError) throw new ExportError(e.message);
    throw e;
  }
}

/** 本租户的一次人群导出：状态、格式、所用快照与行数（跑完之前为 null），失败时带错误；不存在、别的租户的或不是导出任务时为 null */
export async function getExport(tenantId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [task] = await getDb().select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId), eq(tasks.kind, 'export.tags')));
  if (!task) return null;
  const params = task.params as { format: ExportFormat; snapshots: Record<string, string> };
  const rowCount = task.status === 'succeeded' ? (task.result as { rows: number }).rows : null;
  return {
    id: task.id, status: task.status, format: params.format, snapshots: params.snapshots, rowCount,
    ...(task.status === 'failed' && { error: task.error }),
  };
}
