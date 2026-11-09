// app/.server/knowledge/import.ts —— 把知识来源解析成知识提案的服务（ADR-0046 入口③，#526）：importFromSource 把纯函数接上模型与库。
// 顺序定死：查权限 → 读来源 → 查模型服务（没配 409、不发请求）→ 取依据快照（必须在调模型前，解析期间依据变了的目标落成 stale
// 而不是脏提案）→ 事务外调 chatJson（llm_calls 由它自己记，调用方回滚时调用记录也留下）→ 事务里 proposeMany 与审计
// knowledge_source.parsed（detail 只有标题、种类、版本与各类计数，不记段落原文与提示词）。
// 来源只是待解析的数据，SQL 与文本绝不执行：本文件不 import 工作台、pipeline 与 DuckDB 相关模块。
// 同一来源再解析会再调一次模型，重复提案靠指纹去重（不建代次表）；路由与页面在 #527 接
import { assertCan } from '../access';
import { recordAudit } from '../audit';
import type { CurrentMember } from '../auth';
import { tenantCatalog } from '../catalog/load';
import { getDb } from '../db/client';
import { chatJson, LlmError, resolveProvider } from '../llm';
import { currentBases } from './basis';
import { IMPORT_SCHEMA, importInput, importMessages, outputToProposals, type ImportOutput } from './import-draft';
import { proposeMany } from './proposals';
import { getKnowledgeSource } from './sources';

/** 可以展示给成员的错误：未配置模型服务 409，模型失败 422 */
export class ImportError extends Error {
  constructor(message: string, readonly status: 409 | 422) { super(message); }
}

/** 一次解析的结果：各类计数（新建 / 已有 / 已拒绝 / 不合法 / 依据已变） */
export interface ImportResult {
  created: number;
  existing: number;
  rejected: number;
  invalid: number;
  stale: number;
}

/**
 * 把一个来源的段落交给模型，解析成业务说明、别名、口径声明提案（要 definitions:draft）。模型只给段号，
 * 证据 ref 由代码拼成 source:<id>#p<段号> 并带读取时的来源版本；不合法的输出整条丢弃、计入 invalid，
 * 合法的经 proposeMany 写进提案（按解析前的依据快照跳过已变的目标），审计只记计数
 */
export async function importFromSource(actor: CurrentMember, sourceId: unknown): Promise<ImportResult> {
  assertCan(actor, 'definitions:draft');
  const tenantId = actor.tenant.id;
  const source = await getKnowledgeSource(actor, sourceId);
  if (!(await resolveProvider(tenantId))) throw new ImportError('未配置模型服务：请在「模型服务」页填写端点、模型与 API Key，或由平台配置默认模型服务', 409);

  const bases = await currentBases(getDb(), tenantId);
  const input = importInput(source, await tenantCatalog(tenantId));
  let output: ImportOutput;
  try {
    output = await chatJson<ImportOutput>(tenantId, 'knowledge_import', importMessages(input), IMPORT_SCHEMA);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    throw new ImportError(`解析来源失败：${e.message}`, 422);
  }

  // 不合法的条目（段号越界、没有证据、目标不在输入里、类型取值不配对、空白超上限）在这里就被丢掉，proposeMany 的 invalid 只是库里再拦下的
  const inputs = outputToProposals(output, input, source);
  return getDb().transaction(async tx => {
    const r = await proposeMany(tx, tenantId, inputs, { expectedBases: bases });
    const invalid = output.proposals.length - inputs.length + r.invalid.length;
    await recordAudit(tx, {
      tenantId, actor, action: 'knowledge_source.parsed', targetType: 'knowledge_source', targetId: source.id,
      detail: {
        sourceId: source.id, title: source.title, kind: source.kind, version: source.version,
        created: r.created.length, existing: r.existing, rejected: r.rejected, invalid, stale: r.stale,
      },
    });
    return { created: r.created.length, existing: r.existing, rejected: r.rejected, invalid, stale: r.stale };
  });
}
