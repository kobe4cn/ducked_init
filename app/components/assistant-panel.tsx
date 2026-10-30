// app/components/assistant-panel.tsx —— 顶栏的「AI 助手」按钮与右侧侧栏（ADR-0043）：多轮问答，助手只能用目录等注册表里的工具。
// 可用性、对话列表与答复都走 /assistant 资源路由（客户端组件不能 import .server 模块）。每轮问答由服务端记进本人的对话，
// 「历史对话」里列出「我的对话」与「分享给我的」：打开自己的可以继续问、可以只读分享给同租户成员；分享给我的只能看（不显示输入框）。
// 每次发送带上当前页面的路径与标题，答复下面列出本轮用过的工具。
// 工作台结果解读存下的消息带 query：显示 SQL、行数与列名，链接「在工作台重新执行」把 SQL 填进工作台编辑框（不执行，用的是打开者自己的权限）
import { useEffect, useRef, useState } from 'react';
import { Link, useFetcher, useLocation } from 'react-router';
import { AlertTriangle, History, Send, Sparkles, X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';

interface Message { role: 'user' | 'assistant'; content: string; toolsUsed?: string[]; query?: { sql: string; rows: number; columns: string[] } }
interface Summary { id: string; title: string; updatedAt: string; owner?: string }
interface Conversation { id: string; title: string; messages: Message[]; owned: boolean; sharedWith: string[] }
type Overview = { configured: boolean; toolSupport: boolean | null; canManageProvider: boolean; tools: string[]; mine: Summary[]; shared: Summary[]; conversation?: Conversation } | { error: string };
type TurnResult = { conversationId: string; reply: string; toolsUsed: string[] } | { error: string };
type ShareResult = { ok: true; email: string } | { error: string };

const JSON_POST = { method: 'post', action: '/assistant', encType: 'application/json' } as const;

export function AssistantPanel() {
  const [panelOpen, setPanelOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  /** 打开的是别人分享给我的对话时记下主人的邮箱：只读 */
  const [readOnlyOwner, setReadOnlyOwner] = useState<string | null>(null);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [shareEmail, setShareEmail] = useState('');
  const overview = useFetcher<Overview>();
  const conversationLoad = useFetcher<Overview>();
  const turn = useFetcher<TurnResult>();
  const shareFetcher = useFetcher<ShareResult>();
  const { pathname } = useLocation();
  const handledResult = useRef<TurnResult | undefined>(undefined);
  const handledLoad = useRef<Overview | undefined>(undefined);
  const handledShare = useRef<ShareResult | undefined>(undefined);
  const scrollEnd = useRef<HTMLDivElement>(null);

  // 每次打开都重新取：管理员可能刚在「模型服务」页配置好
  useEffect(() => {
    if (panelOpen) overview.load('/assistant');
  }, [panelOpen]);

  useEffect(() => {
    const data = turn.data;
    if (turn.state !== 'idle' || !data || handledResult.current === data) return;
    handledResult.current = data;
    if ('error' in data) {
      // 没答上的问题放回输入框，免得下次发送时出现两条连续的提问
      setError(data.error);
      setMessages(m => m.slice(0, -1));
      setInput(current => current || messages.at(-1)?.content || '');
    } else {
      setConversationId(data.conversationId);
      setMessages(m => [...m, { role: 'assistant', content: data.reply, toolsUsed: data.toolsUsed }]);
      overview.load('/assistant');
    }
  }, [turn.state, turn.data]);

  useEffect(() => {
    const data = conversationLoad.data;
    if (conversationLoad.state !== 'idle' || !data || handledLoad.current === data) return;
    handledLoad.current = data;
    if ('error' in data) { setError(data.error); return; }
    const c = data.conversation!;
    setConversationId(c.id);
    setMessages(c.messages);
    setSharedWith(c.sharedWith);
    setReadOnlyOwner(c.owned ? null : (data.shared.find(s => s.id === c.id)?.owner ?? '其他成员'));
    setError(null);
    setShowHistory(false);
  }, [conversationLoad.state, conversationLoad.data]);

  useEffect(() => {
    const data = shareFetcher.data;
    if (shareFetcher.state !== 'idle' || !data || handledShare.current === data) return;
    handledShare.current = data;
    if ('error' in data) setError(data.error);
    else if (conversationId) { setShareEmail(''); setError(null); conversationLoad.load(`/assistant?id=${conversationId}`); }
  }, [shareFetcher.state, shareFetcher.data]);

  useEffect(() => { scrollEnd.current?.scrollIntoView({ block: 'end' }); }, [messages, error, turn.state]);

  const busy = turn.state !== 'idle';
  const lists = overview.data && !('error' in overview.data) ? overview.data : undefined;
  // 最近一次探测为不支持工具调用时也不能发送；没探测过照常可用
  const unsupported = lists?.configured && lists.toolSupport === false;
  const usable = lists?.configured && !unsupported;

  function startNew() {
    setConversationId(null);
    setReadOnlyOwner(null);
    setSharedWith([]);
    setMessages([]);
    setError(null);
    setShowHistory(false);
  }

  function send() {
    const question = input.trim();
    if (!question || busy || !usable || readOnlyOwner) return;
    setMessages(m => [...m, { role: 'user', content: question }]);
    setInput('');
    setError(null);
    turn.submit(
      { conversationId, message: question, page: { path: pathname, title: document.title } },
      JSON_POST,
    );
  }

  function submitShare(intent: 'share' | 'unshare', email: string) {
    if (!conversationId || !email.trim()) return;
    shareFetcher.submit({ intent, conversationId, email }, JSON_POST);
  }

  const conversationList = (title: string, items: Summary[], testId: string) => (
    <section data-testid={testId} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-slate-500">{title}</h3>
      {items.length === 0 ? <p className="text-slate-400">暂无</p> : items.map(c => (
        <button
          key={c.id}
          type="button"
          data-conversation={c.id}
          onClick={() => conversationLoad.load(`/assistant?id=${c.id}`)}
          className={`flex flex-col rounded-md px-2 py-1.5 text-left hover:bg-slate-100 ${c.id === conversationId ? 'bg-slate-100' : ''}`}
        >
          <span className="truncate text-slate-900">{c.title}</span>
          <span className="text-xs text-slate-400">{c.owner ? `${c.owner} · ` : ''}{new Date(c.updatedAt).toLocaleString('zh-CN')}</span>
        </button>
      ))}
    </section>
  );

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setPanelOpen(o => !o)} aria-expanded={panelOpen}>
        <Sparkles data-icon="inline-start" />
        AI 助手
      </Button>
      {panelOpen && (
        <aside data-testid="assistant-panel" className="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l bg-white text-sm text-slate-700 shadow-lg">
          <div className="flex h-16 items-center justify-between border-b px-4">
            <span className="flex items-center gap-2 font-semibold text-slate-900"><Sparkles className="size-4 text-violet-500" />AI 助手</span>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={startNew}>新对话</Button>
              <Button type="button" variant={showHistory ? 'secondary' : 'ghost'} size="sm" disabled={busy} onClick={() => setShowHistory(s => !s)} aria-pressed={showHistory}>
                <History data-icon="inline-start" />历史对话
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭 AI 助手" onClick={() => setPanelOpen(false)}><X /></Button>
            </div>
          </div>
          {showHistory ? (
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {!lists ? <p className="text-slate-500">加载中…</p> : (
                <>
                  {conversationList('我的对话', lists.mine, 'my-conversations')}
                  {conversationList('分享给我的', lists.shared, 'shared-conversations')}
                </>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                {!lists ? (
                  <p className="text-slate-500">加载中…</p>
                ) : unsupported ? (
                  <p data-assistant="unsupported" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>该模型服务不支持工具调用，AI 助手无法使用。{lists.canManageProvider
                      ? <>请到<Link to="/model-provider" className="mx-0.5 underline">「模型服务」</Link>页换一个支持工具调用的模型。</>
                      : '请联系管理员换一个支持工具调用的模型。'}</span>
                  </p>
                ) : !lists.configured ? (
                  <p data-assistant="unconfigured" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>未配置模型服务，AI 助手暂时不能用。{lists.canManageProvider
                      ? <>请到<Link to="/model-provider" className="mx-0.5 underline">「模型服务」</Link>页配置。</>
                      : '请联系管理员配置。'}</span>
                  </p>
                ) : messages.length === 0 ? (
                  <p className="text-slate-500">可以问我目录里有哪些实体、字段、指标与标签，以及它们的含义。我只读目录，不执行查询、不发布。对话会保存在「历史对话」里，只有你自己能看到。</p>
                ) : null}
                {readOnlyOwner && (
                  <p data-assistant="read-only" className="rounded-lg border bg-slate-50 p-2 text-xs text-slate-500">{readOnlyOwner} 分享给你的对话，只能查看，不能续写。</p>
                )}
                {messages.map((m, i) => (
                  <div key={i} data-role={m.role} className={m.role === 'user' ? 'self-end max-w-[85%] rounded-2xl bg-slate-900 px-3 py-2 text-white' : 'max-w-[95%]'}>
                    {m.query ? (
                      <div data-query className="space-y-1">
                        <p>请解读这段查询的结果：</p>
                        <pre className="overflow-x-auto rounded-lg bg-slate-800 p-2 font-mono text-xs">{m.query.sql}</pre>
                        <p className="text-xs text-slate-300">{`${m.query.rows} 行，列：${m.query.columns.join('、')}`}</p>
                        <Link data-rerun to={`/workbench?sql=${encodeURIComponent(m.query.sql)}`} className="text-xs underline">在工作台重新执行</Link>
                      </div>
                    ) : <p className="whitespace-pre-wrap">{m.content}</p>}
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
              {conversationId && !readOnlyOwner && (
                <div data-testid="assistant-share" className="flex flex-col gap-2 border-t px-3 py-2">
                  <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); submitShare('share', shareEmail); }}>
                    <Input aria-label="分享给成员的邮箱" type="email" placeholder="只读分享给本租户成员（邮箱）" value={shareEmail} onChange={e => setShareEmail(e.target.value)} className="h-8" />
                    <Button type="submit" variant="outline" size="sm" disabled={shareFetcher.state !== 'idle' || !shareEmail.trim()}>分享</Button>
                  </form>
                  {sharedWith.length > 0 && (
                    <ul className="flex flex-wrap gap-1 text-xs">
                      {sharedWith.map(email => (
                        <li key={email} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1">
                          {email}
                          <button type="button" aria-label={`撤销分享给 ${email}`} className="rounded-full p-0.5 hover:bg-slate-200" onClick={() => submitShare('unshare', email)}><X className="size-3" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {!readOnlyOwner && (
                <form className="flex items-end gap-2 border-t p-3" onSubmit={e => { e.preventDefault(); send(); }}>
                  <textarea
                    aria-label="向 AI 助手提问"
                    rows={2}
                    value={input}
                    disabled={!usable}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                    placeholder="问点什么，Enter 发送，Shift+Enter 换行"
                    className="min-h-10 flex-1 resize-none rounded-md border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:bg-slate-50"
                  />
                  <Button type="submit" size="icon" aria-label="发送" disabled={!usable || busy || !input.trim()}><Send /></Button>
                </form>
              )}
            </>
          )}
        </aside>
      )}
    </>
  );
}
