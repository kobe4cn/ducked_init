// app/.server/assistant/plan-card.ts —— 助手答复下计划卡的视图（#452，分析计划 P4⑯a，ADR-0050 / 0043 / 0005）：带 plan 的
// assistant 消息在读时（POST 返回与 ?id= 读回）按读者自己的目录组装一张卡片：不存状态、用当前元数据重新 validatePlan 一次
// （selected 都当作检索过，拦下来的只有依赖变了与看不到所选条目），列出校验结果、所选条目（名称、说明、数据截至）、依据、
// 窗口 / 粒度 / 维度 / 人群与模式。读者看不到的条目（expand 返回 null，目录按角色过滤，ADR-0005）只留 id、不带名称与说明，
// 状态按重新校验的结果给出（不是 valid）、不报错。卡片只进响应：不写库（sealed 里存的是 plan 本身），也不拼进发给模型的
// content（ADR-0043）。questions / reason 原样带上；重新校验通过且 mode 是 reuse_result 时给 resultHref——所选条目里第一个
// 有结果页的条目（模板 / 指标 / 标签，实体与源表没有结果页，路由见 app/routes.ts），找不到就不给（#453）。纯函数：
// 同一份目录与计划每次相同
import { expand, type Catalog, type CatalogEntry, type MetricEntry } from '../catalog';
import { validatePlan, type AnalysisPlan, type PlanMode, type PlanStatus } from '../catalog/plan';

/** 计划卡视图：字段从计划与重新校验的结果组装，客户端组件（app/components/plan-card.tsx）只读 */
export interface PlanCardView {
  status: PlanStatus;
  mode: PlanMode;
  selected: { id: string; name?: string; description?: string; asOf?: string }[];
  assumptions: { text: string; confirmed: boolean }[];
  request: { windowDays?: number; grain?: string; dimensions: string[]; population?: string };
  issues: { message: string; next?: string }[];
  questions: string[];
  reason?: string;
  /** 重新校验通过且 reuse_result 时链到现有结果页；所选条目都没有结果页或没通过时不带 */
  resultHref?: string;
}

/** 条目的数据截至：模板取快照时间，实体取最近一次合并时间，源表取采样时间，指标与其他条目或没有快照时写「暂无快照」 */
const asOfOf = (e: CatalogEntry): string => {
  if (e.kind === 'template') return e.snapshot?.at ?? '暂无快照';
  if (e.kind === 'entity' || e.kind === 'table') return e.stats?.at ?? '暂无快照';
  return '暂无快照';
};

export function planCardView(catalog: Catalog, plan: AnalysisPlan): PlanCardView {
  // 重新校验的写法照 tools.ts 存草稿前那次：selected 都当作检索过，只看当前目录里还成不成立
  const check = validatePlan(plan, { catalog, retrieved: new Set(plan.selected.map(s => s.id)) });
  // request 没写窗口时取所选指标声明的窗口（第一个带窗口的指标）
  const metricWindow = plan.selected
    .map(s => expand(catalog, s.id))
    .find((e): e is MetricEntry => e?.kind === 'metric' && e.window !== undefined)?.window;
  const windowDays = plan.request.windowDays ?? metricWindow?.days;
  const r = plan.request;
  // 现有结果的入口：只在重新校验通过且 reuse_result 时给，取所选条目里第一个有结果页的（模板 / 指标 / 标签）；
  // 实体与源表没有结果页、读者看不到的条目（expand 为 null）都跳过，跳完还没有就不给
  let resultHref: string | undefined;
  if (check.status === 'valid' && plan.mode === 'reuse_result') {
    for (const s of plan.selected) {
      const e = expand(catalog, s.id);
      if (e === null) continue;
      if (e.kind === 'template') { resultHref = `/analytics/templates/${e.template}`; break; }
      if (e.kind === 'metric' || e.kind === 'tag') { resultHref = `/analytics/definitions/${e.kind}/${e.key}`; break; }
    }
  }
  return {
    status: check.status,
    mode: plan.mode,
    selected: plan.selected.map(s => {
      const e = expand(catalog, s.id);
      // 看不到的条目只留 id（重新校验已给出不是 valid 的状态与问题，这里不报错）
      return e === null ? { id: s.id } : { id: s.id, name: e.name, description: e.description, asOf: asOfOf(e) };
    }),
    assumptions: plan.assumptions.map(a => ({ text: a.text, confirmed: a.confirmed })),
    request: {
      ...(windowDays !== undefined ? { windowDays } : {}),
      ...(r.grain !== undefined ? { grain: r.grain } : {}),
      dimensions: r.dimensions,
      ...(r.population !== undefined ? { population: r.population } : {}),
    },
    issues: check.issues.map(i => ({ message: i.message, ...(i.next ? { next: i.next } : {}) })),
    questions: plan.questions,
    ...(plan.reason ? { reason: plan.reason } : {}),
    ...(resultHref ? { resultHref } : {}),
  };
}
