// app/.server/pipeline/assertion-fallback.ts —— 断言建议的两条退路（ADR-0035）：没配模型服务时按规则出基础断言，
// 模型建议的断言个别不过映射校验时去掉这些、采用其余。纯函数，不查库
import { customAssertionName, type CustomAssertion } from './custom-assertions';
import type { MappingIssue, MergePlan } from './mapping-spec';
import { assertionsToYaml, type AssertionDraft, type DraftItem } from './model-draft';
import type { TableProfile } from './source-engine';

const finite = (v: string | null) => {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 按规则出的基础断言：主键字段 not_null（error），主键只有一个字段时再加 unique（error）；
 * 不敏感、不是主键、表达式就是源列名的整数 / 小数字段，按列统计的 min / max 出 range（warn，范围来自当前样本）。日期范围与 in 不出
 */
export function ruleAssertions(plan: MergePlan, profile: TableProfile | null): CustomAssertion[] {
  const out: CustomAssertion[] = plan.key.map(field => ({ field, check: 'not_null', level: 'error' }));
  if (plan.key.length === 1) out.push({ field: plan.key[0], check: 'unique', level: 'error' });
  for (const c of plan.columns) {
    if ((c.type !== 'integer' && c.type !== 'decimal') || c.sensitive || plan.key.includes(c.name)) continue;
    const col = profile?.columns.find(p => p.name === c.expr.trim());
    if (!col) continue;
    const min = finite(col.min), max = finite(col.max);
    if (min === null || max === null) continue;
    out.push({ field: c.name, check: 'range', level: 'warn', min, max });
  }
  return out;
}

/**
 * 模型建议的断言里去掉有校验问题的那些，其余按原顺序写回 base：问题都要定位到 assertions.<序号>，有定位不到的、或全部被丢时返回 null。
 * items 先是留下的（位置是新序号），末尾是被丢的（位置是断言名，dropped 是问题消息）；dropped 是被丢的断言名
 */
export function dropAssertions(
  base: string, out: AssertionDraft, issues: MappingIssue[],
): { yaml: string; items: DraftItem[]; dropped: string[] } | null {
  const byIndex = new Map<number, string[]>();
  for (const issue of issues) {
    const m = /^assertions\.(\d+)(\.|$)/.exec(issue.path);
    if (!m || Number(m[1]) >= out.assertions.length) return null;
    const i = Number(m[1]);
    byIndex.set(i, [...(byIndex.get(i) ?? []), issue.message]);
  }
  if (byIndex.size >= out.assertions.length) return null;
  const kept = out.assertions.filter((_, i) => !byIndex.has(i));
  const { yaml, items } = assertionsToYaml(base, { assertions: kept });
  const gone = [...byIndex.keys()].sort((a, b) => a - b).map(i => ({ a: out.assertions[i], messages: byIndex.get(i)! }));
  return {
    yaml,
    items: [...items, ...gone.map(({ a, messages }) => ({ path: customAssertionName(a), confidence: a.confidence, reason: a.reason, dropped: messages.join('；') }))],
    dropped: gone.map(({ a }) => customAssertionName(a)),
  };
}
