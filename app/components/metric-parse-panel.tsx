// app/components/metric-parse-panel.tsx —— 一句话解析结果面板（#517，ADR-0035）：逐项说明、没认出的说法、支持不了的说法与和当前表单的差异。
// 不支持的说法只带原话（#516 的接口），原因用一段固定说明列出 DSL 的三条限制（issue #517 评论代拍板的选项 A）；
// 差异只在展示（「确认覆盖」按钮和隐藏字段 parsed 在路由里，与本面板同一个表单），成员确认前构建器不动
import { AlertTriangle } from 'lucide-react';

/** 一句话解析的展示内容：#516 的三个数组加构建器装不下、没填入的维度名（builderFormOf 把 dimensions 清空） */
export interface MetricParseResult {
  items: { path: string; reason: string }[];
  unknowns: string[];
  unsupported: string[];
  dropped: string[];
}

/** 和当前表单的差异：一句话会被替换的摘要句子（原来 → 解析后） */
export interface FormDiff { before: string; after: string }

/** 解析说明里的位置转中文：measure.* → 计算什么，filter.N → 条件第 N+1 行，window → 时间窗口，numerator / denominator → 分子 / 分母，其余原样 */
const pathText = (path: string): string => {
  const cond = path.match(/^filter\.(\d+)$/);
  if (cond) return `条件第 ${Number(cond[1]) + 1} 行`;
  if (path === 'measure' || path.startsWith('measure.')) return '计算什么';
  if (path === 'window') return '时间窗口';
  if (path === 'numerator' || path.startsWith('numerator.')) return '分子';
  if (path === 'denominator' || path.startsWith('denominator.')) return '分母';
  return path;
};

/**
 * 解析结果面板：四块各有 data-* 方便测试断言。空着的块不显示；差异（diff）只在成员确认覆盖前展示，
 * 由路由传入（没有 diff 时不渲染这一块）
 */
export function MetricParsePanel({ parse, diff }: { parse: MetricParseResult; diff?: readonly FormDiff[] }) {
  return (
    <div className="space-y-3 text-sm" data-metric-parse-panel>
      {parse.items.length > 0 && (
        <div data-parse-items>
          <p className="font-medium">逐项说明</p>
          <ul className="list-disc space-y-0.5 pl-5 text-slate-600">
            {parse.items.map((it, i) => <li key={i}>{`${pathText(it.path)}：${it.reason}`}</li>)}
          </ul>
        </div>
      )}
      {parse.unknowns.length > 0 && (
        <div data-parse-unknowns>
          <p className="font-medium">没认出的说法</p>
          <ul className="list-disc space-y-0.5 pl-5 text-amber-600">
            {parse.unknowns.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
          <p className="text-slate-500">这些词没对应到本租户的字段，解析时没有采用。</p>
        </div>
      )}
      {parse.dropped.length > 0 && (
        <p data-parse-dropped className="text-amber-600">{`以下维度构建器不支持，没有填入：${parse.dropped.join('、')}。要按维度拆开，请在 YAML 模式里写。`}</p>
      )}
      {parse.unsupported.length > 0 && (
        <div data-parse-unsupported className="space-y-1 rounded-xl border border-red-200 p-4">
          <p className="flex items-center gap-1.5 font-medium text-red-600"><AlertTriangle className="size-4" aria-hidden />支持不了的说法</p>
          <ul className="list-disc space-y-0.5 pl-5 text-red-600">
            {parse.unsupported.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
          <p className="text-slate-500">为什么不能做：时间窗口只支持「近 N 天」；「或」只能是同一个字段的多个取值（in）；比例的分母为 0 时结果记为空，不能算成 0。其余是模型判断现有指标定义表达不了这句话。</p>
        </div>
      )}
      {diff && diff.length > 0 && (
        <div data-parse-diff>
          <p className="font-medium">和当前表单的差异（点「确认覆盖」才会替换）</p>
          <ul className="list-disc space-y-0.5 pl-5 text-slate-600">
            {diff.map((d, i) => <li key={i}>{`${d.before || '（空）'} → ${d.after}`}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
