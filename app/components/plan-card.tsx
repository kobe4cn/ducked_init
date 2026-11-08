// app/components/plan-card.tsx —— 助手答复下的分析计划卡（#452 P4⑯a、#453 P4⑯b，ADR-0050）：纯展示组件，卡片数据由
// /assistant 路由按读者自己的目录在读时组装（planCardView），发给模型的历史（content）不带卡片。侧栏里不嵌套卡片
// （docs/agents/ui.md），用一块带边框的小面板；状态色照 ui.md 配图标和文字（颜色不是唯一信号）：通过 emerald 配对勾，
// 追问澄清 amber、做不到 red、过期不配色，后三者都配警告三角。读者看不到的条目服务端已裁掉名称与说明，这里只渲染 id。
// 分支按优先级（#453）：做不到（reason 与每条问题的可行下一步，加「新建定义」链接）> 追问澄清（questions、每条问题的
// message 与 next，提示在下方输入框回答）> 通过（按 mode 给下一步入口：reuse_result 链到所选条目的结果页 resultHref、
// draft_definition 给「存草稿」、draft_query 有 workbenchSql 给「填入工作台」链接、没有给按钮；按钮只替本人发一句固定
// 续写 onFollowUp，存草稿与填入工作台都会在助手工具里重新校验；不传 onFollowUp（被分享人只读）时不渲染按钮，链接照样
// 渲染）> 过期（只提示重新提问，不给任何执行入口）
import type { PlanCardView } from '~/.server/assistant/plan-card';
import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

const MODE_LABEL: Record<PlanCardView['mode'], string> = {
  reuse_result: '复用现有结果',
  draft_definition: '起草新定义',
  draft_query: '起草工作台查询',
  clarify: '追问澄清',
  unsupported: '做不到',
};

/** 续写的固定文字：让助手走带重新校验的工具（save_definition_draft / prefill_workbench，见 tools.ts），不新增路由 */
const DRAFT_FOLLOW_UP = '请把这个计划存成定义草稿';
const WORKBENCH_FOLLOW_UP = '请按这个计划生成 SQL 填入工作台';

export function PlanCard({ card, workbenchSql, onFollowUp }: { card: PlanCardView; workbenchSql?: string; onFollowUp?: (text: string) => void }) {
  const ok = card.status === 'valid';
  // 分支顺序（#453）：做不到（red）> 追问澄清（amber）> 通过（按 mode 给下一步入口）> 过期（只提示重新提问）；
  // mode 是 clarify 时状态一定是 needs_clarification、mode 是 unsupported 时一定是 unsupported（catalog/plan.ts）
  const unsupported = card.mode === 'unsupported' || card.status === 'unsupported';
  const clarify = !unsupported && (card.mode === 'clarify' || card.status === 'needs_clarification');
  // 整卡的颜色与标题跟着分支走（颜色不是唯一信号，标题与图标同时区分）
  let tone = '';
  let title = '计划需要重新确认';
  if (unsupported) { tone = 'border-red-200 bg-red-50 text-red-600'; title = '这个要求做不到'; }
  else if (clarify) { tone = 'border-amber-200 bg-amber-50 text-amber-700'; title = '计划需要补充信息'; }
  else if (ok) { title = '计划已通过校验'; }
  return (
    <div data-plan-card data-status={card.status} className={`mt-2 space-y-2 rounded-lg border p-3 text-xs ${tone}`}>
      <p className={`flex items-center gap-1.5 font-medium ${unsupported ? 'text-red-600' : ok ? 'text-emerald-600' : 'text-amber-700'}`}>
        {ok ? <CheckCircle2 className="size-4 shrink-0" /> : <AlertTriangle className="size-4 shrink-0" />}
        {title}
      </p>
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
      {unsupported ? (
        <>
          {/* 做不到：说明原因与每条问题的可行下一步，链到新建定义（表达不了时先定义） */}
          {card.reason && <p>原因：{card.reason}</p>}
          {card.issues.some(i => i.next) && (
            <ul className="list-disc space-y-0.5 pl-5">
              {card.issues.filter(i => i.next).map((i, j) => <li key={j}>{i.next}</li>)}
            </ul>
          )}
          <Link to="/analytics/definitions/new" data-next="new-definition" className="underline">新建定义</Link>
        </>
      ) : clarify ? (
        <>
          {card.issues.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-amber-700">
              {card.issues.map((i, j) => <li key={j}>{i.next ? `${i.message}（${i.next}）` : i.message}</li>)}
            </ul>
          )}
          {/* 要回答的问题（mode 是 clarify 时计划一定带）；提示在下方输入框回答 */}
          {card.questions.length > 0 && (
            <div>
              <h4 className="text-slate-400">待澄清</h4>
              <ul className="mt-0.5 list-disc space-y-0.5 pl-5">
                {card.questions.map((q, j) => <li key={j}>{q}</li>)}
              </ul>
            </div>
          )}
          <p>请在下方输入框回答</p>
        </>
      ) : ok ? (
        <>
          {/* 下一步入口（#453）：通过时按 mode 给（按钮只替本人发续写）；存草稿与填入工作台都会在助手工具里重新校验 */}
          {card.mode === 'reuse_result' && card.resultHref && (
            <Link to={card.resultHref} data-next="result" className="underline">查看已有结果</Link>
          )}
          {card.mode === 'draft_definition' && onFollowUp && (
            <button type="button" data-next="draft" onClick={() => onFollowUp(DRAFT_FOLLOW_UP)} className="underline">存草稿</button>
          )}
          {card.mode === 'draft_query' && (workbenchSql
            ? <Link to={`/workbench?sql=${encodeURIComponent(workbenchSql)}`} data-prefill data-next="workbench" className="underline">填入工作台</Link>
            : onFollowUp && <button type="button" data-next="workbench" onClick={() => onFollowUp(WORKBENCH_FOLLOW_UP)} className="underline">填入工作台</button>)}
        </>
      ) : (
        <>
          {card.issues.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-amber-700">
              {card.issues.map((i, j) => <li key={j}>{i.next ? `${i.message}（${i.next}）` : i.message}</li>)}
            </ul>
          )}
          <p>计划已过期或不再适用，请重新提问</p>
        </>
      )}
    </div>
  );
}
