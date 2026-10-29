// app/.server/workbench-ai.ts —— 工作台 AI 起草 SQL（ADR-0043）：按成员此刻能读的目录（listCatalog：表、字段与类型，不含取值）请模型写一条只读 SQL，
// 在只读挂载上按工作台白名单校验（checkDraftedSql，不执行），通过后只交给页面填进编辑框，由成员自己执行。
// 审计 workbench.ai_drafted 记 SQL 与是否通过校验，不记需求原文；不自动重试
import { assertCan } from './access';
import type { CurrentMember } from './auth';
import { chatJson, LlmError, resolveProvider, type LlmMessage } from './llm';
import { checkDraftedSql, listCatalog, WorkbenchError, type WorkbenchCatalog } from './workbench';

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
