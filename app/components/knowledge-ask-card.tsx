// app/components/knowledge-ask-card.tsx —— 助手答复下的「记为知识提案」卡片（⑥-4，ADR-0046 / 0056）：点选歧义候选后
// 由服务端确定性组装（askCardFor，不是模型生成的），这里只渲染与提交：确认后生成一条待复核的词的默认指向提案，
// 接受前不进目录（ADR-0046）。只给本人渲染（被分享人只读，见 assistant-panel）；「不用」只在本地隐藏、不写库；
// 成功后显示「已提交，待复核」（amber，待确认），出错在卡片里用 role="alert" 说明原因（如同词已有待复核提案）
import { useState } from 'react';
import { useFetcher } from 'react-router';
import { Button } from '~/components/ui/button';
import type { AskCard } from '~/.server/assistant/knowledge-ask';

/** /assistant 的 knowledge.propose 提交结果：成功 { ok, proposalId }，出错 { error } */
type ProposeResult = { ok?: true; proposalId?: string; error?: string };

const JSON_POST = { method: 'post', action: '/assistant', encType: 'application/json' } as const;

export function KnowledgeAskCard({ card, conversationId }: { card: AskCard; conversationId: string }) {
  const [dismissed, setDismissed] = useState(false);
  const propose = useFetcher<ProposeResult>();
  if (dismissed) return null;
  return (
    <div data-ask-card className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs">
      <p className="font-medium text-slate-700">{`把『${card.term}』默认指向 〈${card.name}〉？`}</p>
      {propose.data?.ok ? (
        // 已提交：等成员在 /knowledge 复核（接受前不进目录），不再给提交入口
        <p className="text-amber-600">已提交，待复核</p>
      ) : (
        <>
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              disabled={propose.state !== 'idle'}
              // 只发对话与下标：词与条目由服务端从存下的 chosen 里取，不收客户端传来的值（ADR-0046）
              onClick={() => propose.submit({ intent: 'knowledge.propose', conversationId, index: card.index }, JSON_POST)}
            >记为知识提案</Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setDismissed(true)}>不用</Button>
          </div>
          {propose.data?.error && <p role="alert" className="text-red-600">{propose.data.error}</p>}
        </>
      )}
    </div>
  );
}
