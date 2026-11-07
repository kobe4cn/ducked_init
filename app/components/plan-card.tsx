// app/components/plan-card.tsx —— 助手答复下的分析计划卡（#452，分析计划 P4⑯a，ADR-0050）：纯展示组件，卡片数据由
// /assistant 路由按读者自己的目录在读时组装（planCardView），发给模型的历史（content）不带卡片。侧栏里不嵌套卡片
// （docs/agents/ui.md），用一块带边框的小面板；状态色照 ui.md 配图标和文字（颜色不是唯一信号）：通过 emerald 配对勾，
// 不通过 amber 配警告三角。读者看不到的条目服务端已裁掉名称与说明，这里只渲染 id
import type { PlanCardView } from '~/.server/assistant/plan-card';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

const MODE_LABEL: Record<PlanCardView['mode'], string> = {
  reuse_result: '复用现有结果',
  draft_definition: '起草新定义',
  draft_query: '起草工作台查询',
  clarify: '追问澄清',
  unsupported: '做不到',
};

export function PlanCard({ card }: { card: PlanCardView }) {
  const ok = card.status === 'valid';
  return (
    <div data-plan-card data-status={card.status} className="mt-2 space-y-2 rounded-lg border p-3 text-xs">
      <p className={`flex items-center gap-1.5 font-medium ${ok ? 'text-emerald-600' : 'text-amber-600'}`}>
        {ok ? <CheckCircle2 className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
        {ok ? '计划已通过校验' : '计划需要重新确认'}
      </p>
      {card.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-amber-700">
          {card.issues.map((i, j) => <li key={j}>{i.message}</li>)}
        </ul>
      )}
      {card.selected.length > 0 && (
        <div>
          <h4 className="text-slate-400">所选条目</h4>
          <ul className="mt-0.5 space-y-1">
            {card.selected.map(s => (
              <li key={s.id}>
                <span className="font-medium text-slate-700">{s.name ?? s.id}</span>
                {s.description && <span className="text-slate-500">：{s.description}</span>}
                {s.asOf && <span className="text-slate-400">（数据截至 {s.asOf}）</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.assumptions.length > 0 && (
        <div>
          <h4 className="text-slate-400">依据</h4>
          <ul className="mt-0.5 space-y-0.5">
            {card.assumptions.map((a, j) => (
              <li key={j}>{a.text}<span className="text-slate-400">（{a.confirmed ? '已确认' : '未确认'}）</span></li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-slate-500">
        {`模式：${MODE_LABEL[card.mode]}`}
        {card.request.windowDays !== undefined && `；窗口：近 ${card.request.windowDays} 天`}
        {card.request.grain && `；粒度：${card.request.grain}`}
        {`；维度：${card.request.dimensions.length ? card.request.dimensions.join('、') : '全体'}`}
        {card.request.population && `；人群：${card.request.population}`}
      </p>
      {card.questions.length > 0 && <p className="text-slate-500">待澄清：{card.questions.join('；')}</p>}
      {card.reason && <p className="text-slate-500">原因：{card.reason}</p>}
    </div>
  );
}
