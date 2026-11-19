// app/.server/metric-parse.ts —— 一句话解析成指标表单（#516，ADR-0035）：模型把一句话解析成 MetricSpec（#514 的指标表单那一侧），
// 补全 `->` 路径、转 YAML 后须过 checkMetric，再转成表单（formToYaml 兜底再校验）返回；只返回、不保存（之后照常保存草稿、双人发布）。
// 同时带回逐项解析说明（items，path 用 spec 里的位置）、认不出的词（unknowns）与不支持的说法（unsupported），由提示词保证（model-draft.ts 的解析说明）。
// 模型看不到 Schema，常把定义平铺在顶层（#959）：先按宽松 Schema 放行再收进 spec（normalizeParseOutput），仍按 METRIC_PARSE_SCHEMA 严格校验。
// 上下文取自本租户的语义目录（ADR-0041），敏感字段不进上下文（ADR-0005）；检索与起草同一条路（draftSearch，#853：按成员权限的目录，
// 租户开 hybrid_search 时带向量一路，ADR-0047、0049），句子有歧义时照常解析、带回歧义词与候选（ADR-0056）由页面提示成员；
// 表单取自 YAML（ADR-0017：YAML 仍是唯一格式，ADR-0025）。
// 失败记审计 definition.metric_parse_failed（stage / error / 问题数与位置，不含原句、解析说明与取值），成功不记审计
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { draftSearch, type DraftAmbiguity } from './catalog/draft-search';
import { getDb } from './db/client';
import { dslContext } from './dsl-definitions';
import { chatJson, LlmError, resolveProvider, schemaErrors, validatorFor } from './llm';
import { yamlToForm, formToYaml, type MetricForm } from '../lib/metric-form';
import { completeDraftPaths, definitionOutputToYaml, METRIC_PARSE_LENIENT_SCHEMA, METRIC_PARSE_SCHEMA, metricParseMessages, normalizeParseOutput, SEARCH_LIMIT } from './pipeline/dsl/model-draft';
import { checkMetric, fieldsFor, type DslIssue, type MetricSpec } from './pipeline/dsl/metric-spec';

/** 句子最多的字数 */
export const MAX_SENTENCE = 500;

/** 可以展示给成员的错误；解析出的定义校验不通过时带上按行列的问题 */
export class MetricParseError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 422, readonly issues?: DslIssue[]) { super(message); }
}

/** 模型对一句话的解析输出（已按 METRIC_PARSE_SCHEMA 校验） */
interface ParseOutput {
  spec: object;
  items: { path: string; reason: string }[];
  unknowns: string[];
  unsupported: string[];
}

/**
 * 用模型把一句话解析成指标表单：需要 definitions:draft；空句子或超过 MAX_SENTENCE 字 400；
 * 没配置模型服务 409、不发请求；模型失败或转出的定义不过校验时记审计 definition.metric_parse_failed（不含原句）并抛 422。
 * 模型把定义平铺在顶层时先收进 spec 再按 METRIC_PARSE_SCHEMA 严格校验（#959），返回与失败审计都带 normalized
 */
export async function parseMetricSentence(actor: CurrentMember, sentence: string): Promise<
  { form: MetricForm; items: { path: string; reason: string }[]; unknowns: string[]; unsupported: string[]; ambiguity: DraftAmbiguity | null; normalized: boolean }
> {
  assertCan(actor, 'definitions:draft');
  if (!sentence.trim()) throw new MetricParseError('请先写一句话', 400);
  if (sentence.length > MAX_SENTENCE) throw new MetricParseError(`一句话最多 ${MAX_SENTENCE} 字`, 400);
  const tenantId = actor.tenant.id;
  if (!(await resolveProvider(tenantId))) throw new MetricParseError('未配置模型服务：请让租户管理员在「模型服务」页配置，或由平台配置默认模型服务', 409);
  const ctx = await dslContext(getDb(), tenantId);
  const failed = (detail: Record<string, unknown>) => recordAudit(getDb(), {
    tenantId, actor, action: 'definition.metric_parse_failed', targetType: 'definition', detail,
  });
  // 检索与起草同一条路（draftSearch，#853）：按成员权限的目录与条目，句子有歧义时照常解析、带回提示
  const { catalog, entries, ambiguity } = await draftSearch(actor, sentence, SEARCH_LIMIT);
  let out: Record<string, unknown>;
  try {
    // 宽松 Schema（#959）：llm_calls.schema_valid 记的是它的结果，平铺在顶层的输出也记 true
    out = await chatJson<Record<string, unknown>>(tenantId, 'metric_parse', metricParseMessages(sentence, catalog, entries), METRIC_PARSE_LENIENT_SCHEMA);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    await failed({ stage: 'model', error: e.message.slice(0, 200) });
    throw new MetricParseError(`解析失败：${e.message}`, 422);
  }
  // 收拢平铺在顶层的输出（有 spec 键原样返回）后仍按 METRIC_PARSE_SCHEMA 严格校验：收拢只归位键，完全不像定义的输出照旧失败
  const { output, normalized } = normalizeParseOutput(out);
  const validate = validatorFor(METRIC_PARSE_SCHEMA);
  if (!validate(output)) {
    const message = `模型返回的 JSON 不符合 Schema：${schemaErrors(validate)}`;
    await failed({ stage: 'model', error: message.slice(0, 200), ...(normalized && { normalized: true }) });
    throw new MetricParseError(`解析失败：${message}`, 422);
  }
  const parsed = output as ParseOutput;
  const reject = async (stage: 'definition' | 'form', issues: DslIssue[]): Promise<never> => {
    await failed({ stage, issues: issues.length, paths: issues.slice(0, 10).map(i => i.path), ...(normalized && { normalized: true }) });
    throw new MetricParseError(`解析出的指标定义有 ${issues.length} 处问题，未采用（行号指模型生成的那份）`, 422, issues);
  };
  const spec = completeDraftPaths('metric', parsed.spec) as MetricSpec;
  const yaml = definitionOutputToYaml('metric', spec);
  const checked = checkMetric(yaml, ctx);
  if (!checked.ok) await reject('definition', checked.issues);
  const fields = fieldsFor(spec.base, ctx) ?? [];
  const form = yamlToForm(yaml, fields);
  const formChecked = checkMetric(formToYaml(form, fields), ctx);
  if (!formChecked.ok) await reject('form', formChecked.issues);
  return { form, items: parsed.items, unknowns: parsed.unknowns, unsupported: parsed.unsupported, ambiguity, normalized };
}
