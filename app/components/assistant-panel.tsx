// app/components/assistant-panel.tsx —— 顶栏的「AI 助手」按钮与右侧侧栏（ADR-0043）：多轮问答，助手只能用目录等注册表里的工具。
// 可用性与答复都走 /assistant 资源路由（客户端组件不能 import .server 模块）；对话只存在组件 state 里，刷新即丢。
// 每次发送带上当前页面的路径与标题，答复下面列出本轮用过的工具
import { useEffect, useRef, useState } from 'react';
import { Link, useFetcher, useLocation } from 'react-router';
import { AlertTriangle, Send, Sparkles, X } from 'lucide-react';
import { Button } from '~/components/ui/button';

interface Message { role: 'user' | 'assistant'; content: string; toolsUsed?: string[] }
type Availability = { configured: boolean; tools: string[] };
type TurnResult = { reply: string; toolsUsed: string[] } | { error: string };

/** 服务端每条消息最多收 4000 字：更长的答复带回去时截断，免得之后每轮都被拒 */
const MAX_CONTENT = 4000;

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const availability = useFetcher<Availability>();
  const turn = useFetcher<TurnResult>();
  const { pathname } = useLocation();
  const handledResult = useRef<TurnResult | undefined>(undefined);
  const scrollEnd = useRef<HTMLDivElement>(null);

  // 每次打开都重新取：管理员可能刚在「模型服务」页配置好
  useEffect(() => {
    if (open) availability.load('/assistant');
  }, [open]);

  useEffect(() => {
    const data = turn.data;
    if (turn.state !== 'idle' || !data || handledResult.current === data) return;
    handledResult.current = data;
    if ('error' in data) {
      // 没答上的问题放回输入框，免得下次发送时出现两条连续的提问
      setError(data.error);
      setMessages(m => m.slice(0, -1));
      setInput(current => current || messages.at(-1)?.content || '');
    } else setMessages(m => [...m, { role: 'assistant', content: data.reply, toolsUsed: data.toolsUsed }]);
  }, [turn.state, turn.data]);

  useEffect(() => { scrollEnd.current?.scrollIntoView({ block: 'end' }); }, [messages, error, turn.state]);

  const busy = turn.state !== 'idle';
  const configured = availability.data?.configured;

  function send() {
    const question = input.trim();
    if (!question || busy || !configured) return;
    const history = [...messages, { role: 'user' as const, content: question }];
    setMessages(history);
    setInput('');
    setError(null);
    turn.submit(
      { history: history.map(({ role, content }) => ({ role, content: content.slice(0, MAX_CONTENT) })), page: { path: pathname, title: document.title } },
      { method: 'post', action: '/assistant', encType: 'application/json' },
    );
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <Sparkles data-icon="inline-start" />
        AI 助手
      </Button>
      {open && (
        <aside data-testid="assistant-panel" className="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l bg-white text-sm text-slate-700 shadow-lg">
          <div className="flex h-16 items-center justify-between border-b px-4">
            <span className="flex items-center gap-2 font-semibold text-slate-900"><Sparkles className="size-4 text-violet-500" />AI 助手</span>
            <div className="flex items-center gap-1">
              {messages.length > 0 && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setMessages([]); setError(null); }}>新对话</Button>
              )}
              <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭 AI 助手" onClick={() => setOpen(false)}><X /></Button>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {!availability.data ? (
              <p className="text-slate-500">加载中…</p>
            ) : !configured ? (
              <p data-assistant="unconfigured" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>未配置模型服务，AI 助手暂时不能用。请管理员到<Link to="/model-provider" className="mx-0.5 underline">「模型服务」</Link>页配置。</span>
              </p>
            ) : messages.length === 0 ? (
              <p className="text-slate-500">可以问我目录里有哪些实体、字段、指标与标签，以及它们的含义。我只读目录，不执行查询、不发布。</p>
            ) : null}
            {messages.map((m, i) => (
              <div key={i} data-role={m.role} className={m.role === 'user' ? 'self-end max-w-[85%] rounded-2xl bg-slate-900 px-3 py-2 text-white' : 'max-w-[95%]'}>
                <p className="whitespace-pre-wrap">{m.content}</p>
                {m.toolsUsed && m.toolsUsed.length > 0 && (
                  <p data-tools-used className="mt-1 text-xs text-slate-400">用过的工具：{[...new Set(m.toolsUsed)].join('、')}</p>
                )}
              </div>
            ))}
            {busy && <p className="text-slate-500">思考中…</p>}
            {error && (
              <p data-role="error" className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-600">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </p>
            )}
            <div ref={scrollEnd} />
          </div>
          <form className="flex items-end gap-2 border-t p-3" onSubmit={e => { e.preventDefault(); send(); }}>
            <textarea
              aria-label="向 AI 助手提问"
              rows={2}
              value={input}
              disabled={!configured}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
              placeholder="问点什么，Enter 发送，Shift+Enter 换行"
              className="min-h-10 flex-1 resize-none rounded-md border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:bg-slate-50"
            />
            <Button type="submit" size="icon" aria-label="发送" disabled={!configured || busy || !input.trim()}><Send /></Button>
          </form>
        </aside>
      )}
    </>
  );
}
