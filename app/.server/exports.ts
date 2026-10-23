// app/.server/exports.ts —— 人群导出（ADR-0040）：外部系统按标签条件发起导出，入队时定下每个标签用哪张快照，
// 由工作进程的 export.tags 写文件。导出 ID 就是任务 ID；一律限定在调用方的租户内。
// 成功后每次查询签发一个 15 分钟的下载链接（只存令牌哈希），凭令牌下载；文件在任务结束 24 小时后由调度器删掉
import { open, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { and, desc, eq, gt, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { ApiCaller } from './api-auth';
import { recordAudit } from './audit';
import { newToken, sha256 } from './auth';
import { getDb } from './db/client';
import { exportLinks, snapshots, tasks } from './db/schema';
import { DSL_KEY_PATTERN } from './dsl-definitions';
import { lakeRow, lakeSpecOf } from './lake';
import { isS3 } from './lake-storage';
import { EXPORT_FORMATS, type ExportCondition, type ExportFormat } from './pipeline/handlers';
import { platformS3 } from './s3-accounts';
import { deleteObject, getObjectIfExists } from './s3-client';
import { getSnapshot } from './snapshots';
import { insertTask, TaskError } from './tasks';

export const MAX_EXPORT_CONDITIONS = 5;
export const MAX_TAG_VALUE_LENGTH = 200;
export const EXPORT_LINK_TTL_MS = 15 * 60_000;
export const EXPORT_RETENTION_MS = 24 * 60 * 60_000;

/** 结束时间早于它的导出文件已过保留期（已被或即将被清理） */
const retentionCutoff = () => new Date(Date.now() - EXPORT_RETENTION_MS);

/** export.tags 成功后的结果：行数、相对存储前缀的文件路径（清理后去掉）与格式 */
interface ExportResult { rows: number; path?: string; format: ExportFormat }
const resultOf = (task: { result: unknown }) => task.result as ExportResult;

const CONTENT_TYPES: Record<ExportFormat, string> = { parquet: 'application/vnd.apache.parquet', csv: 'text/csv; charset=utf-8' };

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

/**
 * 本租户的一次人群导出：状态、格式、所用快照与行数（跑完之前为 null），失败时带错误；不存在、别的租户的或不是导出任务时为 null。
 * 成功且文件还在保留期内时签发一个新的下载链接（不让之前的失效）；过了保留期状态为 expired、没有链接
 */
export async function getExport(tenantId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [task] = await getDb().select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId), eq(tasks.kind, 'export.tags')));
  if (!task) return null;
  const params = task.params as { format: ExportFormat; snapshots: Record<string, string> };
  const rowCount = task.status === 'succeeded' ? resultOf(task).rows : null;
  const expired = task.status === 'succeeded' && task.finishedAt! < retentionCutoff();
  return {
    id: task.id, status: expired ? 'expired' as const : task.status, format: params.format, snapshots: params.snapshots, rowCount,
    ...(task.status === 'failed' && { error: task.error }),
    ...(task.status === 'succeeded' && !expired && { download: await issueLink(tenantId, task.id) }),
  };
}

/** 签发一个下载链接：库里只存令牌的 SHA-256，明文只出现在返回的 url 里 */
async function issueLink(tenantId: string, taskId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + EXPORT_LINK_TTL_MS);
  await getDb().insert(exportLinks).values({ tenantId, taskId, tokenHash: sha256(token), expiresAt });
  return { url: `/api/v1/exports/${taskId}/download?token=${token}`, expiresAt: expiresAt.toISOString() };
}

/**
 * 凭下载链接的令牌下载导出文件（流式），每次下载记审计 export.downloaded。令牌不存在或不是这个导出的 404；
 * 令牌已到期、文件过了保留期或已不在 410
 */
export async function openExportDownload(id: string, token: string | null): Promise<Response> {
  const notFound = () => Response.json({ error: '下载链接不存在' }, { status: 404 });
  const gone = () => Response.json({ error: '下载链接已过期，请重新查询导出状态获取新链接' }, { status: 410 });
  if (!token) return notFound();
  const [found] = await getDb().select({ link: exportLinks, task: tasks }).from(exportLinks)
    .innerJoin(tasks, eq(tasks.id, exportLinks.taskId))
    .where(eq(exportLinks.tokenHash, sha256(token)));
  if (!found || found.task.id !== id) return notFound();
  const { link, task } = found;
  const { path, format } = resultOf(task);
  const lake = await lakeRow(task.tenantId);
  if (link.expiresAt <= new Date() || task.finishedAt! < retentionCutoff() || !path || !lake) return gone();

  const file = lake.dataPath + path;
  // 文件不在（例如湖迁移后，_exports/ 不复制）时 410
  const body = isS3(file)
    ? await getObjectIfExists(lakeSpecOf(lake).s3!, file)
    : await open(file).then(
      h => Readable.toWeb(h.createReadStream()) as ReadableStream<Uint8Array>,
      (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (!body) return gone();
  await recordAudit(getDb(), { tenantId: task.tenantId, system: true, action: 'export.downloaded', targetType: 'task', targetId: id, detail: { id } });
  return new Response(body, {
    headers: { 'Content-Type': CONTENT_TYPES[format], 'Content-Disposition': `attachment; filename="export-${id}.${format}"` },
  });
}

/**
 * 调度器定期调用：删掉结束超过 24 小时的导出文件（文件不在也不报错），删掉后从任务结果里去掉 path，下次不再处理；
 * 再删掉这些导出已到期的下载链接（过了保留期的导出不再签发链接，它的链接最晚 15 分钟后到期，到期前下载 410）。
 * 保留期内的导出到期的链接不删，下载照旧 410
 */
export async function cleanupExpiredExports() {
  const db = getDb();
  const due = await db.select({ id: tasks.id, tenantId: tasks.tenantId, result: tasks.result }).from(tasks).where(and(
    eq(tasks.kind, 'export.tags'), eq(tasks.status, 'succeeded'), lt(tasks.finishedAt, retentionCutoff()),
    sql`${tasks.result} ->> 'path' IS NOT NULL`,
  ));
  for (const task of due) {
    try {
      const lake = await lakeRow(task.tenantId);
      if (lake) {
        const file = lake.dataPath + resultOf(task).path;
        await (isS3(file) ? deleteObject(platformS3(), file) : rm(file, { force: true }));
      }
      await db.update(tasks).set({ result: sql`${tasks.result} - 'path'` }).where(eq(tasks.id, task.id));
    } catch (e) {
      // 一个删不掉不耽误别的，下一轮再试
      console.error(`[人群导出] 删除导出文件 ${task.id} 出错`, e);
    }
  }
  const pastRetention = db.select({ id: tasks.id }).from(tasks).where(lt(tasks.finishedAt, retentionCutoff()));
  await db.delete(exportLinks).where(and(lte(exportLinks.expiresAt, new Date()), inArray(exportLinks.taskId, pastRetention)));
}
