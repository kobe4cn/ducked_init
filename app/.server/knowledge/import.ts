// app/.server/knowledge/import.ts —— 把知识来源解析成知识提案的服务（ADR-0046 入口③，#526）：importFromSource 把纯函数接上模型与库。
// 顺序定死：查权限 → 读来源 → 查模型服务（没配 409、不发请求）→ 取依据快照（必须在调模型前，解析期间依据变了的目标落成 stale
// 而不是脏提案）→ 事务外调 chatJson（llm_calls 由它自己记，调用方回滚时调用记录也留下；长来源按段落分块逐块调、合并去重，任何一块
// 失败都按整次失败处理，被截断且不止一段的块对半拆块重试 #1275）→ 模型失败时事务外记 knowledge_source.parse_failed 审计再 422（detail 只有标题、种类、版本、stage 与
// 错误摘要，不记原文）→ dropKnown 丢掉和调模型前已生效知识相同的提案（#948）→ 事务里 proposeMany 与审计
// knowledge_source.parsed（detail 只有标题、种类、版本、各类计数与被丢条目的目标与原因，不记段落原文、提示词与提案内容）。
// 客户端中止（外部 signal，#1251）：422「解析来源失败：请求已取消」，不写提案与任何审计（含 parse_failed——中止不是模型失败），
// 分块时中止后不再发后续块的请求（已发出的那次照常记 llm_calls，已经计费）；来源在调模型之前就已保存，中止不影响。
// 来源只是待解析的数据，SQL 与文本绝不执行：本文件不 import 工作台、pipeline 与 DuckDB 相关模块。
// 同一来源再解析会再调一次模型，重复提案靠指纹去重（不建代次表）；路由与页面在 #527 接
import { assertCan } from '../access';
import { recordAudit } from '../audit';
import type { CurrentMember } from '../auth';
import { tenantCatalog } from '../catalog/load';
import { getDb } from '../db/client';
import { chatJson, LlmError, resolveProvider, throwIfAborted } from '../llm';
import { currentBases } from './basis';
import { chunkParagraphs, IMPORT_SCHEMA, importInput, importMessages, mergeOutputs, outputToProposals, type ImportOutput } from './import-draft';
import { dropKnown } from './known';
import { proposeMany } from './proposals';
import { getKnowledgeSource, type SourceParagraph } from './sources';

/** 可以展示给成员的错误：未配置模型服务 409，模型失败 422 */
export class ImportError extends Error {
  constructor(message: string, readonly status: 409 | 422) { super(message); }
}

/** 一次解析的结果：各类计数（新建 / 已有 / 已拒绝 / 不合法 / 依据已变 / 与已生效知识相同）与分块后的实际调用次数 */
export interface ImportResult {
  created: number;
  existing: number;
  rejected: number;
  invalid: number;
  stale: number;
  skipped: number;
  /** 实际成功调用模型的次数：长来源按段落分块后大于 1，被截断的块对半拆块重试（#1275）、截断的那次不计
   *  （不进 parsed 审计的 detail，键集合保持不变） */
  chunks: number;
}

/**
 * 把一个来源的段落交给模型，解析成业务说明、别名、口径声明提案（要 definitions:draft）。模型只给段号，
 * 证据 ref 由代码拼成 source:<id>#p<段号> 并带读取时的来源版本；段落合计超过 IMPORT_CHUNK_CHARS 时按段落分块
 * 逐块调用、各块输出合并去重（#1274），任何一块失败都按整次失败处理（某块输出被截断且不止一段时对半拆块重试，
 * 只有单段一块仍被截断才算整次失败，#1275）；不合 IMPORT_SCHEMA 的输出整次 422 并在
 * 事务外记 parse_failed 审计（只记 stage 与错误摘要），合 Schema 但不合法的单条丢弃、计入 invalid 并把目标与
 * 原因记进审计（#955），与调模型前已生效知识相同的丢掉、计入 skipped（#948），剩下的经 proposeMany 写进提案
 * （按解析前的依据快照跳过已变的目标），审计只记计数。signal 是外部中止（#1251）：中止时 422「解析来源失败：请求已取消」，
 * 不写提案与任何审计（含 parse_failed），分块时中止后不再发后续块的请求
 */
export async function importFromSource(actor: CurrentMember, sourceId: unknown, signal?: AbortSignal): Promise<ImportResult> {
  assertCan(actor, 'definitions:draft');
  const tenantId = actor.tenant.id;
  const source = await getKnowledgeSource(actor, sourceId);
  if (!(await resolveProvider(tenantId))) throw new ImportError('未配置模型服务：请在「模型服务」页填写端点、模型与 API Key，或由平台配置默认模型服务', 409);

  const bases = await currentBases(getDb(), tenantId);
  const catalog = await tenantCatalog(tenantId);
  const input = importInput(source, catalog);
  // 长来源按段落分块（一段不拆开、段号是原来的段号），按顺序串行逐块调模型；除截断外任何一块失败都按整次失败处理：
  // 已成功的块只攒在内存里、还没写库，失败时走 catch 抛走，不留提案。某块输出被截断（finish_reason === 'length'）且
  // 这块不止一段时对半拆块重试（#1275），其他块照常；只有单段一块仍被截断才走整次失败
  const chunks = chunkParagraphs(input.paragraphs);
  const outputs: ImportOutput[] = [];
  // 单块调一次模型返回它的输出：被截断且不止一段时从段数中点切开、串行递归重试，两边的输出拼起来返回；其他错误原样抛出
  const callChunk = async (chunk: SourceParagraph[]): Promise<ImportOutput[]> => {
    try {
      // 每块只换段落、条目整份照带（模型要认得目标）；合并去重后段号仍是整份来源的段号，段号校验针对整份来源
      const out = await chatJson<ImportOutput>(tenantId, 'knowledge_import', importMessages({ ...input, paragraphs: chunk }), IMPORT_SCHEMA, { signal });
      // 模型回复到手时客户端可能已中止（途中中止的请求已发出并计费，llm_calls 留着）：拦下来，不进提案与审计（#1251）
      throwIfAborted(signal);
      return [out];
    } catch (e) {
      // 判断截断只认 truncated 字段，不匹配错误消息文本；单段截断不再拆，从外层 catch 按整次失败处理。
      // 递归保持串行，每次尝试后都经 throwIfAborted 拦中止（中止后不再发后续请求）；深度受段数限制，不用另设上限
      if (!(e instanceof LlmError && e.truncated && chunk.length > 1)) throw e;
      const mid = Math.ceil(chunk.length / 2);
      return [...await callChunk(chunk.slice(0, mid)), ...await callChunk(chunk.slice(mid))];
    }
  };
  let output: ImportOutput;
  try {
    for (const chunk of chunks) outputs.push(...await callChunk(chunk));
    output = mergeOutputs(outputs);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    // 失败审计写在事务外（用 getDb）：整次失败没有可回滚的写入，审计也一定留下（照 suggest-run 先例）；
    // detail 只记阶段与错误摘要（Key 已由 llm.ts 抹掉），不放段落原文、提示词与模型输出。
    // 客户端中止（#1251）不是模型失败：不记 parse_failed，只走同一条 422（来源已保存，再提交同标题同正文是安全的重试）
    if (!e.aborted) {
      await recordAudit(getDb(), {
        tenantId, actor, action: 'knowledge_source.parse_failed', targetType: 'knowledge_source', targetId: source.id,
        detail: {
          sourceId: source.id, title: source.title, kind: source.kind, version: source.version,
          stage: 'model', error: e.message.slice(0, 200),
        },
      });
    }
    throw new ImportError(`解析来源失败：${e.message}`, 422);
  }

  // 不合法的条目（段号越界、没有证据、目标不在输入里、类型取值不配对、空白超上限）在这里就被丢掉并记下目标与原因，
  // proposeMany 的 invalid 只是库里再拦下的
  const { inputs, dropped } = outputToProposals(output, input, source);
  // invalid 按丢已知之前的条数算（被丢掉的不再同时计进 invalid），已知部分不再交给 proposeMany
  const { inputs: toPropose, skipped } = dropKnown(inputs, catalog.entries);
  return getDb().transaction(async tx => {
    const r = await proposeMany(tx, tenantId, toPropose, { expectedBases: bases });
    const invalid = output.proposals.length - inputs.length + r.invalid.length;
    // 被丢条目只记目标与原因（最多前 20 条），不记提案内容；没有丢弃时不写 dropped 这个键
    const detail: Record<string, unknown> = {
      sourceId: source.id, title: source.title, kind: source.kind, version: source.version,
      created: r.created.length, existing: r.existing, rejected: r.rejected, invalid, stale: r.stale, skipped,
    };
    if (dropped.length > 0) detail.dropped = dropped.slice(0, 20);
    await recordAudit(tx, {
      tenantId, actor, action: 'knowledge_source.parsed', targetType: 'knowledge_source', targetId: source.id, detail,
    });
    return { created: r.created.length, existing: r.existing, rejected: r.rejected, invalid, stale: r.stale, skipped, chunks: outputs.length };
  });
}
