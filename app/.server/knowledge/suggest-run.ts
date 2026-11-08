// app/.server/knowledge/suggest-run.ts —— 按主题生成知识提案的服务（ADR-0046 入口③，#512）：suggestForSubject 把 #511 的纯函数
// 接上模型与库。顺序定死：查权限 → 找主题 → 查模型服务（没配 409、不发请求）→ 取依据快照（必须在调模型前，生成期间依据变了的目标
// 落成 stale 而不是脏提案）→ 取 restricted 投影的输入 → 查代次（同样的输入与生成器版本已经生成过就不再调模型，返回没有新内容）→
// 事务外调 chatJson（llm_calls 由它自己记，调用方回滚时调用记录也留下）→ 事务里 proposeMany、写 knowledge_generations 与审计。
// 模型失败记 generate_failed 审计（只记阶段与错误摘要，不放提示词与输出原文）后 422；失败不记代次行，再点还会调模型。
// 本票只提供服务，路由与页面在之后的票接
import { and, eq } from 'drizzle-orm';
import { assertCan } from '../access';
import { recordAudit } from '../audit';
import type { CurrentMember } from '../auth';
import { tenantCatalog } from '../catalog/load';
import { getDb } from '../db/client';
import { knowledgeGenerations } from '../db/schema';
import { chatJson, LlmError, resolveProvider } from '../llm';
import { currentBases, KnowledgeError } from './basis';
import { proposeMany } from './proposals';
import {
  outputToProposals, subjectInput, suggestMessages, SUGGEST_GENERATOR_VERSION, SUGGEST_SCHEMA, type SuggestOutput,
} from './suggest';
import { listSubjects } from './subjects';

/** 可以展示给成员的错误：未配置模型服务 409，模型失败 422 */
export class SuggestError extends Error {
  constructor(message: string, readonly status: 409 | 422) { super(message); }
}

/** 一次生成的结果：fresh: false 是同样的输入已经生成过、没有新内容；其余是各类计数（新建 / 已有 / 已拒绝 / 不合法 / 依据已变） */
export type SuggestResult =
  | { fresh: false }
  | { fresh: true; created: number; existing: number; rejected: number; invalid: number; stale: number };

/**
 * 按主题生成一批知识提案（要 definitions:draft）。同样的 (租户, 主题, 输入, 生成器版本) 已经生成过时不调模型，
 * 返回 { fresh: false }；否则调模型、把合法的输出经 proposeMany 写进提案（按生成前的依据快照跳过已变的目标），并记一代
 */
export async function suggestForSubject(actor: CurrentMember, subjectId: string): Promise<SuggestResult> {
  assertCan(actor, 'definitions:draft');
  const tenantId = actor.tenant.id;
  const subject = (await listSubjects(getDb(), tenantId)).find(s => s.id === subjectId);
  if (!subject) throw new KnowledgeError('没有这个主题');
  // 放在代次查询之前：没配模型服务时无论生成过没有都点不动（与 AC1 一致）
  if (!(await resolveProvider(tenantId))) throw new SuggestError('未配置模型服务：请在「模型服务」页填写端点、模型与 API Key，或由平台配置默认模型服务', 409);

  const bases = await currentBases(getDb(), tenantId);
  const input = subjectInput(await tenantCatalog(tenantId), { id: subject.id, name: subject.name });
  const [generated] = await getDb().select({ id: knowledgeGenerations.id }).from(knowledgeGenerations)
    .where(and(
      eq(knowledgeGenerations.tenantId, tenantId),
      eq(knowledgeGenerations.subjectId, subject.id),
      eq(knowledgeGenerations.inputHash, input.inputHash),
      eq(knowledgeGenerations.generatorVersion, SUGGEST_GENERATOR_VERSION),
    ));
  if (generated) return { fresh: false };

  let output: SuggestOutput;
  try {
    output = await chatJson<SuggestOutput>(tenantId, 'knowledge_proposal', suggestMessages(input), SUGGEST_SCHEMA);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    // 失败审计写在事务外（用 getDb）：没有可回滚的写入，审计也一定留下；detail 不放消息与输出原文
    await recordAudit(getDb(), {
      tenantId, actor, action: 'knowledge_proposal.generate_failed', targetType: 'analysis_subject', targetId: subject.id,
      detail: { subjectId: subject.id, stage: 'model', error: e.message.slice(0, 200) },
    });
    throw new SuggestError(`按主题生成提案失败：${e.message}`, 422);
  }

  // 不合法的条目（引用输入外、目标不在集合、类型取值不配对、空白超上限）在这里就被丢掉，proposeMany 的 invalid 只是库里再拦下的
  const inputs = outputToProposals(output, input);
  const result = await getDb().transaction(async tx => {
    const r = await proposeMany(tx, tenantId, inputs, { expectedBases: bases });
    // 并发重复点击时唯一索引兜底：插不上就当这一代已经记过
    await tx.insert(knowledgeGenerations).values({
      tenantId, subjectId: subject.id, inputHash: input.inputHash, generatorVersion: SUGGEST_GENERATOR_VERSION,
      proposalCount: r.created.length, createdByEmail: actor.email,
    }).onConflictDoNothing();
    const invalid = output.proposals.length - inputs.length + r.invalid.length;
    await recordAudit(tx, {
      tenantId, actor, action: 'knowledge_proposal.generated', targetType: 'analysis_subject', targetId: subject.id,
      detail: { subjectId: subject.id, created: r.created.length, existing: r.existing, rejected: r.rejected, invalid, stale: r.stale },
    });
    return { ...r, invalid };
  });
  return {
    fresh: true, created: result.created.length, existing: result.existing,
    rejected: result.rejected, invalid: result.invalid, stale: result.stale,
  };
}
