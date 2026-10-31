// app/.server/workbench-ai.ts —— 工作台 AI 起草 SQL（ADR-0043）：按成员此刻能读的目录（listCatalog：表、字段与类型，不含取值）请模型写一条只读 SQL，
// 在只读挂载上按工作台白名单校验（checkDraftedSql，不执行），通过后只交给页面填进编辑框，由成员自己执行。
// 审计 workbench.ai_drafted 记 SQL 与是否通过校验，不记需求原文；不自动重试。
// 结果解读：成员确认后服务端按 SQL 重新执行（不信客户端传来的行），把前 INTERPRET_ROWS 行发给模型服务；结果列无法回溯到字段，
// 所以按列名与取值保守剔除系统列、名字像敏感字段的列与取值里有 64 位十六进制哈希的列。审计 workbench.result_interpreted 不记取值；
// 解读连同 SQL、行数与发送的列名存进本人的助手对话（appendInterpretation），不存结果行
import { assertCan } from './access';
import { appendInterpretation, assertOwnConversation } from './assistant/conversations';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { isSystemColumn } from './catalog';
import { getDb } from './db/client';
import { chatJson, LlmError, resolveProvider, type LlmMessage } from './llm';
import { normalizeWorkbenchSql, type WorkbenchResult } from './pipeline/workbench-engine';
import { checkDraftedSql, listCatalog, runQuery, WorkbenchError, type QueryOutcome, type WorkbenchCatalog } from './workbench';
import { looksSensitive } from '../lib/sensitive';

/** 可以展示给成员的错误 */
export class WorkbenchAiError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 422 | 429) { super(message); }
}

/** 需求最多的字数 */
export const MAX_REQUEST = 2000;
/** 目录在提示里最多占的字数，超出的表略去 */
const MAX_CATALOG = 30_000;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sql'],
  properties: { sql: { type: 'string', minLength: 1 } },
};

/** 目录写进提示：每张表一行「引用(字段 类型, …)」 */
function catalogText(catalog: WorkbenchCatalog): string {
  const line = (t: { ref: string; columns: { name: string; type: string }[] }) => `${t.ref}(${t.columns.map(c => `${c.name} ${c.type}`).join(', ')})`;
  const lines = [
    ...[...catalog.silver, ...catalog.gold, ...catalog.mine, ...catalog.shared].map(line),
    ...catalog.raw.flatMap(s => s.tables.map(line)),
  ];
  const text = lines.join('\n');
  return text.length > MAX_CATALOG ? `${text.slice(0, MAX_CATALOG)}\n…（目录太长，后面的表略去）` : text;
}

function draftMessages(request: string, catalog: WorkbenchCatalog): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你为 DuckDB 写一条只读查询 SQL，回答 JSON 对象 {"sql": "..."}。',
        '只写一条 SELECT（可以带 WITH），不写 INSERT / UPDATE / DELETE / CREATE / DROP 等写语句，不写多条语句。',
        '只能读下面列出的表，表名照列出的引用写（带 schema 或数据源名与引号），不要编造表或字段。',
        '能读的表（引用(字段 类型, …)）：',
        catalogText(catalog) || '（没有能读的表）',
      ].join('\n'),
    },
    { role: 'user', content: request },
  ];
}

/**
 * 按需求起草一条工作台 SQL，通过白名单校验后返回，不执行（ADR-0043）。
 * 需求为空或超过 MAX_REQUEST 字时 400；没配置模型服务时 409（都不发请求）；模型失败或 SQL 没通过校验时 422（没通过时审计 valid: false）；
 * 同租户已有查询在运行时 429
 */
export async function draftWorkbenchSql(actor: CurrentMember, request: string): Promise<{ sql: string }> {
  assertCan(actor, 'sandbox');
  if (!request.trim()) throw new WorkbenchAiError('请先写下要查什么', 400);
  if (request.length > MAX_REQUEST) throw new WorkbenchAiError(`需求最多 ${MAX_REQUEST} 字`, 400);
  const tenantId = actor.tenant.id;
  if (!(await resolveProvider(tenantId))) throw new WorkbenchAiError('未配置模型服务：请让租户管理员在「模型服务」页配置，或由平台配置默认模型服务', 409);
  try {
    const catalog = await listCatalog(actor);
    let drafted: string;
    try {
      ({ sql: drafted } = await chatJson<{ sql: string }>(tenantId, 'workbench_draft', draftMessages(request, catalog), SCHEMA));
    } catch (e) {
      if (e instanceof LlmError) throw new WorkbenchAiError(`模型起草 SQL 失败：${e.message}`, 422);
      throw e;
    }
    const { sql, problem } = await checkDraftedSql(actor, drafted);
    if (problem) throw new WorkbenchAiError(`AI 起草的 SQL 没有通过校验：${problem}`, 422);
    return { sql };
  } catch (e) {
    // 目录读取、校验时挂载出错或已有查询在运行：照原状态码给出
    if (e instanceof WorkbenchError) throw new WorkbenchAiError(e.message, e.status);
    throw e;
  }
}

/** 解读时发给模型服务的行数 */
export const INTERPRET_ROWS = 50;
/** 每格最多的字数与解读最多的字数 */
export const MAX_CELL = 200;
const MAX_INTERPRETATION = 4000;
/** 平台的哈希（加盐 sha256）：取值里出现就剔除整列，拼接、取子串等改写也躲不过 */
const HASH = /[0-9a-f]{64}/i;

const INTERPRET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretation'],
  properties: { interpretation: { type: 'string', minLength: 1 } },
};

/** 单元格转成字符串（BigInt、日期、列表与结构体都能转），NULL 保持 null */
const cellText = (v: unknown): string | null =>
  v === null || v === undefined ? null
    : typeof v === 'object' ? JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
      : String(v);

/** 每列发不发：系统列、名字像敏感字段的列、前 limit 行里有取值含哈希的列都不发（按位置，重名的列也不会取错） */
const sendable = (result: WorkbenchResult, limit = INTERPRET_ROWS): boolean[] => {
  const rows = result.rows.slice(0, limit);
  return result.columns.map(({ name }, i) =>
    !isSystemColumn(name) && !looksSensitive({ name }) && !rows.some(row => HASH.test(cellText(row[i]) ?? '')));
};

/** 要发送与剔除的列名 */
export function pickColumns(result: WorkbenchResult, keep = sendable(result)): { sent: string[]; dropped: string[] } {
  return {
    sent: result.columns.filter((_, i) => keep[i]).map(c => c.name),
    dropped: result.columns.filter((_, i) => !keep[i]).map(c => c.name),
  };
}

/**
 * 剔除后交出去的结果：前 limit 行里没被剔除的列，单元格转成字符串、每格最多 MAX_CELL 字；dropped 是剔除的列名。
 * 哈希按交出去的这些行判断：解读只发前 INTERPRET_ROWS 行，MCP 的 run_query 交出全部行（limit 传 Infinity）
 */
export function redactResult(result: WorkbenchResult, limit = INTERPRET_ROWS): { columns: WorkbenchResult['columns']; rows: (string | null)[][]; dropped: string[] } {
  const keep = sendable(result, limit);
  const indexes = keep.flatMap((k, i) => (k ? [i] : []));
  return {
    columns: indexes.map(i => result.columns[i]),
    rows: result.rows.slice(0, limit).map(row => indexes.map(i => cellText(row[i])?.slice(0, MAX_CELL) ?? null)),
    dropped: pickColumns(result, keep).dropped,
  };
}

/** 发给模型服务的行数 */
const sentRows = (result: WorkbenchResult) => Math.min(result.rows.length, INTERPRET_ROWS);

/** 查询出错（SQL 不合规、超时、已有查询在运行）照原状态码给出 */
async function rerun(actor: CurrentMember, sql: string): Promise<QueryOutcome> {
  try {
    return await runQuery(actor, sql);
  } catch (e) {
    if (e instanceof WorkbenchError) throw new WorkbenchAiError(e.message, e.status);
    throw e;
  }
}

/** 解读前的确认：按 SQL 重新执行，给出将发送的行数与列、剔除的列，不请求模型；result 是这次执行的结果，页面照常显示表格 */
export async function previewInterpretation(
  actor: CurrentMember, sql: string,
): Promise<{ rows: number; sent: string[]; dropped: string[]; result: QueryOutcome }> {
  assertCan(actor, 'sandbox');
  const result = await rerun(actor, sql);
  return { rows: sentRows(result), ...pickColumns(result), result };
}

function interpretMessages({ columns, rows }: ReturnType<typeof redactResult>): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你帮数据分析师解读一条 SQL 查询的结果，回答 JSON 对象 {"interpretation": "..."}，用中文写几段简短的文字。',
        '只描述聚合规律与分布（总体趋势、占比、集中与离散、异常的分组），不要复述或点名任何单个个人，不要逐行引用取值。',
        `下面是结果的前 ${rows.length} 行（敏感列已剔除，每格最多 ${MAX_CELL} 字）。`,
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify({ columns, rows }) },
  ];
}

/**
 * 成员确认后解读结果（ADR-0043）：没确认时 400，没配置模型服务时 409（都不发请求）；按 SQL 重新执行，
 * 只发前 INTERPRET_ROWS 行里没被剔除的列，全部被剔除时 400；模型失败时 422。
 * 解读存进本人的助手对话 conversationId（null 时新建；不是自己的对话时 404，不发请求），返回对话 id。
 * 审计 workbench.result_interpreted { sql, rows, columns, dropped }，不记取值与解读。result 是这次执行的结果，只给页面显示表格，不进审计
 */
export async function interpretResult(
  actor: CurrentMember, sql: string, confirmed: boolean, conversationId: string | null,
): Promise<{ text: string; rows: number; columns: string[]; dropped: string[]; result: QueryOutcome; conversationId: string }> {
  assertCan(actor, 'sandbox');
  if (!confirmed) throw new WorkbenchAiError('请先确认要发送给模型服务的列', 400);
  const tenantId = actor.tenant.id;
  if (!(await resolveProvider(tenantId))) throw new WorkbenchAiError('未配置模型服务：请让租户管理员在「模型服务」页配置，或由平台配置默认模型服务', 409);
  if (conversationId !== null) await assertOwnConversation(actor, conversationId);
  const result = await rerun(actor, sql);
  const redacted = redactResult(result);
  const { dropped } = redacted;
  const sent = redacted.columns.map(c => c.name);
  if (!sent.length) throw new WorkbenchAiError('没有可以发送的列：结果里的列都是系统列、敏感列或哈希', 400);
  let interpretation: string;
  try {
    const messages = interpretMessages(redacted);
    ({ interpretation } = await chatJson<{ interpretation: string }>(tenantId, 'workbench_interpret', messages, INTERPRET_SCHEMA));
  } catch (e) {
    if (e instanceof LlmError) throw new WorkbenchAiError(`模型解读结果失败：${e.message}`, 422);
    throw e;
  }
  const rows = sentRows(result);
  const text = interpretation.slice(0, MAX_INTERPRETATION);
  const normalized = normalizeWorkbenchSql(sql);
  const savedConversationId = await appendInterpretation(actor, conversationId, { sql: normalized, rows, columns: sent }, text);
  await recordAudit(getDb(), {
    tenantId, actor, action: 'workbench.result_interpreted', targetType: 'workbench',
    detail: { sql: normalized, rows, columns: sent, dropped },
  });
  return { text, rows, columns: sent, dropped, result, conversationId: savedConversationId };
}
