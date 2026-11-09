// app/.server/metric-parse.ts —— 一句话解析成指标表单（#516，ADR-0035）：模型把一句话解析成 MetricSpec（#514 的指标表单那一侧），
// 补全 `->` 路径、转 YAML 后须过 checkMetric，再转成表单（formToYaml 兜底再校验）返回；只返回、不保存（之后照常保存草稿、双人发布）。
// 同时带回逐项解析说明（items，path 用 spec 里的位置）、认不出的词（unknowns）与不支持的说法（unsupported），由提示词保证（model-draft.ts 的解析说明）。
// 上下文取自本租户的语义目录（ADR-0041），敏感字段不进上下文（ADR-0005）；表单取自 YAML（ADR-0017：YAML 仍是唯一格式，ADR-0025）。
// 失败记审计 definition.metric_parse_failed（stage / error / 问题数与位置，不含原句、解析说明与取值），成功不记审计
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { tenantCatalog } from './catalog/load';
import { getDb } from './db/client';
import { dslContext } from './dsl-definitions';
import { chatJson, LlmError, resolveProvider } from './llm';
import { yamlToForm, formToYaml, type MetricForm } from '../lib/metric-form';
import { completeDraftPaths, definitionOutputToYaml, METRIC_PARSE_SCHEMA, metricParseMessages } from './pipeline/dsl/model-draft';
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
 * 没配置模型服务 409、不发请求；模型失败或转出的定义不过校验时记审计 definition.metric_parse_failed（不含原句）并抛 422
 */
export async function parseMetricSentence(actor: CurrentMember, sentence: string): Promise<
  { form: MetricForm; items: { path: string; reason: string }[]; unknowns: string[]; unsupported: string[] }
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
  let out: ParseOutput;
  try {
    out = await chatJson<ParseOutput>(tenantId, 'metric_parse', metricParseMessages(sentence, await tenantCatalog(tenantId)), METRIC_PARSE_SCHEMA);
  } catch (e) {
    if (!(e instanceof LlmError)) throw e;
    await failed({ stage: 'model', error: e.message.slice(0, 200) });
    throw new MetricParseError(`解析失败：${e.message}`, 422);
  }
  const reject = async (stage: 'definition' | 'form', issues: DslIssue[]): Promise<never> => {
    await failed({ stage, issues: issues.length, paths: issues.slice(0, 10).map(i => i.path) });
    throw new MetricParseError(`解析出的指标定义有 ${issues.length} 处问题，未采用（行号指模型生成的那份）`, 422, issues);
  };
  const spec = completeDraftPaths('metric', out.spec) as MetricSpec;
  const yaml = definitionOutputToYaml('metric', spec);
  const checked = checkMetric(yaml, ctx);
  if (!checked.ok) await reject('definition', checked.issues);
  const fields = fieldsFor(spec.base, ctx) ?? [];
  const form = yamlToForm(yaml, fields);
  const formChecked = checkMetric(formToYaml(form, fields), ctx);
  if (!formChecked.ok) await reject('form', formChecked.issues);
  return { form, items: out.items, unknowns: out.unknowns, unsupported: out.unsupported };
}
