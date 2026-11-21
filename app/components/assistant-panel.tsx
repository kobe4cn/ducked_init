// app/components/assistant-panel.tsx —— 顶栏的「AI 助手」按钮与右侧侧栏（ADR-0043）：多轮问答，助手只能用目录等注册表里的工具。
// 可用性、对话列表与答复都走 /assistant 资源路由（客户端组件不能 import .server 模块）。每轮问答由服务端记进本人的对话，
// 「历史对话」里列出「我的对话」与「分享给我的」：打开自己的可以继续问、可以只读分享给同租户成员；分享给我的只能看（不显示输入框）。
// 每次发送带上当前页面的路径与标题，答复下面列出本轮用过的工具。
// 工作台结果解读存下的消息带 query：显示 SQL、行数与列名，链接「在工作台重新执行」把 SQL 填进工作台编辑框（不执行，用的是打开者自己的权限）。
// 本轮 prefill_workbench 通过校验的答复带 workbenchSql（#437）：正文下有「填入工作台」链接，点开只把 SQL 放进工作台编辑框（?sql= 不重新校验、不执行，由成员自己执行）
// 带 plan 的答复在读时按读者自己的目录另带 planCard（#452，P4⑯a）：正文下渲染一张计划卡（PlanCard，校验结果、所选条目、依据、
// 窗口 / 粒度 / 维度 / 人群与数据截至），新发的回答与打开历史对话都显示；卡片只进响应，不进发给模型的历史。
// 计划卡的下一步入口（#453，P4⑯b）：通过的卡按 mode 给结果页链接或续写按钮，按钮替本人发一句固定续写（send(text)，不动
// 输入框），由助手工具重新校验后再存草稿 / 填工作台；没有 planCard 只有 workbenchSql 的消息照旧给「填入工作台」链接
// 歧义追问的候选按钮（⑥-4，ADR-0047 / 0046）：带 choices 的答复下列出候选，点选后 POST choice 继续这一轮——回答的文字由
// 服务端生成、POST 不返回，所以本地不追加，成功后整个对话按服务端重新读回（消息、下标与卡片都以它为准）；
// 未命中组的标题是「指的是哪一个？」并多一个「都不是」按钮（⑥-5），点了提交 entryId: null；被分享人只读（readOnlyOwner）：
// 服务端照旧返回 choices，候选按钮、「都不是」与「记为知识提案」卡片只在前端隐藏
// 「记为知识提案」卡片（KnowledgeAskCard）：点选候选的答复下由服务端确定性生成，确认后生成待复核的提案
//（歧义点选默认指向、未命中点选别名，文案按 kind 区分）
// 界面文字按界面语言翻译（ADR-0060）：显示文字走 t()，发给服务端的请求内容（输入的问题、计划卡按钮的固定续写）不翻。
// 对话列表与消息区抽成 ConversationList / AssistantMessages、面板加 initialOpen：仓库没有 jsdom，静态渲染测试
//（test/assistant-panel-render.test.ts）点不开内部状态，抽出的纯展示组件与 initialOpen 让典型状态可渲染
import { useEffect, useRef, useState } from 'react';
import { Link, useFetcher, useLocation } from 'react-router';
import { AlertTriangle, History, Send, Sparkles, X } from 'lucide-react';
import { KnowledgeAskCard } from '~/components/knowledge-ask-card';
import { PlanCard } from '~/components/plan-card';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { useT, useLocale } from '~/lib/i18n';
import { formatDateTime } from '~/lib/format';
import type { AskCard } from '~/.server/assistant/knowledge-ask';
import type { PlanCardView } from '~/.server/assistant/plan-card';

export interface Message { role: 'user' | 'assistant'; content: string; toolsUsed?: string[]; query?: { sql: string; rows: number; columns: string[] }; workbenchSql?: string; planCard?: PlanCardView; choices?: { term: string; kind?: 'missing'; candidates: { entryId: string; name: string }[] }[]; askCard?: AskCard }
export interface Summary { id: string; title: string; updatedAt: string; owner?: string }
interface Conversation { id: string; title: string; messages: Message[]; owned: boolean; sharedWith: string[] }
type Overview = { configured: boolean; toolSupport: boolean | null; canManageProvider: boolean; tools: string[]; mine: Summary[]; shared: Summary[]; conversation?: Conversation } | { error: string };
type TurnResult = { conversationId: string; reply: string; toolsUsed: string[]; workbenchSql?: string; planCard?: PlanCardView; choices?: Message['choices']; askCard?: AskCard } | { error: string };
type ShareResult = { ok: true; email: string } | { error: string };

const JSON_POST = { method: 'post', action: '/assistant', encType: 'application/json' } as const;

export function AssistantPanel({ initialOpen = false }: { initialOpen?: boolean }) {
  const t = useT();
  const [panelOpen, setPanelOpen] = useState(initialOpen);
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
  /** 最近一次发送是不是计划卡按钮发的固定续写：出错的回填只在用输入框发送时做，续写文字不放回输入框 */
  const sentFollowUp = useRef(false);
  /** 最近一次发送是不是点选歧义候选：回答由服务端生成、本地没追加过消息，成功后改为整个对话重新读回 */
  const sentChoice = useRef(false);
  const scrollEnd = useRef<HTMLDivElement>(null);

  // 每次打开都重新取：管理员可能刚在「模型服务」页配置好
  useEffect(() => {
    if (panelOpen) overview.load('/assistant');
  }, [panelOpen]);

  useEffect(() => {
    const data = turn.data;
    if (turn.state !== 'idle' || !data || handledResult.current === data) return;
    handledResult.current = data;
    const wasChoice = sentChoice.current;
    sentChoice.current = false;
    if ('error' in data) {
      // 没答上的问题放回输入框，免得下次发送时出现两条连续的提问；计划卡按钮发的固定续写不放回；
      // 点选候选时本地没追加过消息，只报错、不移除也不回填
      setError(data.error);
      if (wasChoice) return;
      setMessages(m => m.slice(0, -1));
      if (!sentFollowUp.current) setInput(current => current || messages.at(-1)?.content || '');
    } else {
      setConversationId(data.conversationId);
      if (wasChoice) {
        // 点选的回答与「记为知识提案」卡片都由服务端生成，重新读回整个对话，下标以服务端为准
        conversationLoad.load(`/assistant?id=${data.conversationId}`);
      } else {
        setMessages(m => [...m, {
          role: 'assistant', content: data.reply, toolsUsed: data.toolsUsed,
          ...(data.workbenchSql ? { workbenchSql: data.workbenchSql } : {}),
          ...(data.planCard ? { planCard: data.planCard } : {}),
          ...(data.choices ? { choices: data.choices } : {}),
          ...(data.askCard ? { askCard: data.askCard } : {}),
        }]);
      }
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
    setReadOnlyOwner(c.owned ? null : (data.shared.find(s => s.id === c.id)?.owner ?? t('其他成员')));
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

  /** 发送：不带参数用输入框（发完清空）；带固定文本（计划卡按钮的续写）直接发这句，不动输入框 */
  function send(text?: string) {
    const question = (text ?? input).trim();
    if (!question || busy || !usable || readOnlyOwner) return;
    sentFollowUp.current = text !== undefined;
    setMessages(m => [...m, { role: 'user', content: question }]);
    if (text === undefined) setInput('');
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

  /** 点选追问的候选（⑥-3 歧义 / ⑥-5 未命中；entryId 为 null 是「都不是」）：POST choice 继续这一轮，回答与卡片由服务端生成、成功后整个对话重新读回 */
  function pickChoice(entryId: string | null) {
    if (!conversationId || busy || !usable || readOnlyOwner) return;
    sentChoice.current = true;
    setError(null);
    turn.submit({ conversationId, choice: { entryId } }, JSON_POST);
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setPanelOpen(o => !o)} aria-expanded={panelOpen}>
        <Sparkles data-icon="inline-start" />
        {t('AI 助手')}
      </Button>
      {panelOpen && (
        <aside data-testid="assistant-panel" className="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l bg-white text-sm text-slate-700 shadow-lg">
          <div className="flex h-16 items-center justify-between border-b px-4">
            <span className="flex items-center gap-2 font-semibold text-slate-900"><Sparkles className="size-4 text-violet-500" />{t('AI 助手')}</span>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={startNew}>{t('新对话')}</Button>
              <Button type="button" variant={showHistory ? 'secondary' : 'ghost'} size="sm" disabled={busy} onClick={() => setShowHistory(s => !s)} aria-pressed={showHistory}>
                <History data-icon="inline-start" />{t('历史对话')}
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t('关闭 AI 助手')} onClick={() => setPanelOpen(false)}><X /></Button>
            </div>
          </div>
          {showHistory ? (
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {!lists ? <p className="text-slate-500">{t('加载中…')}</p> : (
                <>
                  <ConversationList title={t('我的对话')} items={lists.mine} testId="my-conversations" currentId={conversationId ?? undefined} onOpen={id => conversationLoad.load(`/assistant?id=${id}`)} />
                  <ConversationList title={t('分享给我的')} items={lists.shared} testId="shared-conversations" currentId={conversationId ?? undefined} onOpen={id => conversationLoad.load(`/assistant?id=${id}`)} />
                </>
              )}
            </div>
          ) : (
            <>
              <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                {!lists ? (
                  <p className="text-slate-500">{t('加载中…')}</p>
                ) : unsupported ? (
                  <p data-assistant="unsupported" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    {/* 带链接的句子拆成三段翻译：中文回退时逐字拼回原句；英文译文首尾带空格，拼回后语句通顺 */}
                    <span>{t('该模型服务不支持工具调用，AI 助手无法使用。')}{lists.canManageProvider
                      ? <>{t('请到')}<Link to="/model-provider" className="mx-0.5 underline">{t('「模型服务」')}</Link>{t('页换一个支持工具调用的模型。')}</>
                      : t('请联系管理员换一个支持工具调用的模型。')}</span>
                  </p>
                ) : !lists.configured ? (
                  <p data-assistant="unconfigured" className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>{t('未配置模型服务，AI 助手暂时不能用。')}{lists.canManageProvider
                      ? <>{t('请到')}<Link to="/model-provider" className="mx-0.5 underline">{t('「模型服务」')}</Link>{t('页配置。')}</>
                      : t('请联系管理员配置。')}</span>
                  </p>
                ) : messages.length === 0 ? (
                  <p className="text-slate-500">{t('可以问我目录里有哪些实体、字段、指标与标签，以及它们的含义。我只读目录，不执行查询、不发布。对话会保存在「历史对话」里，只有你自己能看到。')}</p>
                ) : null}
                <AssistantMessages messages={messages} busy={busy} readOnlyOwner={readOnlyOwner} conversationId={conversationId} onFollowUp={text => send(text)} onPickChoice={pickChoice} />
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
                    <Input aria-label={t('分享给成员的邮箱')} type="email" placeholder={t('只读分享给本租户成员（邮箱）')} value={shareEmail} onChange={e => setShareEmail(e.target.value)} className="h-8" />
                    <Button type="submit" variant="outline" size="sm" disabled={shareFetcher.state !== 'idle' || !shareEmail.trim()}>{t('分享')}</Button>
                  </form>
                  {sharedWith.length > 0 && (
                    <ul className="flex flex-wrap gap-1 text-xs">
                      {sharedWith.map(email => (
                        <li key={email} className="flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-1">
                          {email}
                          <button type="button" aria-label={t('撤销分享给 {email}', { email })} className="rounded-full p-0.5 hover:bg-slate-200" onClick={() => submitShare('unshare', email)}><X className="size-3" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {!readOnlyOwner && (
                <form className="flex items-end gap-2 border-t p-3" onSubmit={e => { e.preventDefault(); send(); }}>
                  <textarea
                    aria-label={t('向 AI 助手提问')}
                    rows={2}
                    value={input}
                    disabled={!usable}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                    placeholder={t('问点什么，Enter 发送，Shift+Enter 换行')}
                    className="min-h-10 flex-1 resize-none rounded-md border px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:bg-slate-50"
                  />
                  <Button type="submit" size="icon" aria-label={t('发送')} disabled={!usable || busy || !input.trim()}><Send /></Button>
                </form>
              )}
            </>
          )}
        </aside>
      )}
    </>
  );
}

/** 「历史对话」里的一组对话（我的 / 分享给我的）：title 由调用方翻译后传入，条目的更新时间按界面语言格式化（ADR-0060） */
export function ConversationList({ title, items, testId, currentId, onOpen }: {
  title: string; items: Summary[]; testId: string; currentId?: string; onOpen: (id: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-slate-500">{title}</h3>
      {items.length === 0 ? <p className="text-slate-400">{t('暂无')}</p> : items.map(c => (
        <button
          key={c.id}
          type="button"
          data-conversation={c.id}
          onClick={() => onOpen(c.id)}
          className={`flex flex-col rounded-md px-2 py-1.5 text-left hover:bg-slate-100 ${c.id === currentId ? 'bg-slate-100' : ''}`}
        >
          <span className="truncate text-slate-900">{c.title}</span>
          <span className="text-xs text-slate-400">{c.owner ? `${c.owner} · ` : ''}{formatDateTime(locale, c.updatedAt)}</span>
        </button>
      ))}
    </section>
  );
}

/** 消息区：只读横幅、消息列表（工作台结果解读、计划卡、追问候选与提案卡）与「思考中…」。条目数据原样显示，不翻译 */
export function AssistantMessages({ messages, busy, readOnlyOwner, conversationId, onFollowUp, onPickChoice }: {
  messages: Message[]; busy: boolean; readOnlyOwner: string | null; conversationId: string | null;
  onFollowUp?: (text: string) => void; onPickChoice: (entryId: string | null) => void;
}) {
  const t = useT();
  return (
    <>
      {readOnlyOwner && (
        <p data-assistant="read-only" className="rounded-lg border bg-slate-50 p-2 text-xs text-slate-500">{t('{owner} 分享给你的对话，只能查看，不能续写。', { owner: readOnlyOwner })}</p>
      )}
      {messages.map((m, i) => (
        <div key={i} data-role={m.role} className={m.role === 'user' ? 'self-end max-w-[85%] rounded-2xl bg-slate-900 px-3 py-2 text-white' : 'max-w-[95%]'}>
          {m.query ? (
            <div data-query className="space-y-1">
              <p>{t('请解读这段查询的结果：')}</p>
              <pre className="overflow-x-auto rounded-lg bg-slate-800 p-2 font-mono text-xs">{m.query.sql}</pre>
              <p className="text-xs text-slate-300">{t('{rows} 行，列：{columns}', { rows: m.query.rows, columns: m.query.columns.join(t('、')) })}</p>
              <Link data-rerun to={`/workbench?sql=${encodeURIComponent(m.query.sql)}`} className="text-xs underline">{t('在工作台重新执行')}</Link>
            </div>
          ) : (
            <>
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.planCard && <PlanCard card={m.planCard} workbenchSql={m.workbenchSql} onFollowUp={readOnlyOwner ? undefined : onFollowUp} />}
              {!m.planCard && m.workbenchSql && <Link data-prefill to={`/workbench?sql=${encodeURIComponent(m.workbenchSql)}`} className="text-xs underline">{t('填入工作台')}</Link>}
              {/* 追问的候选按钮（⑥-3 歧义 / ⑥-5 未命中）：被分享人只读，服务端照旧返回 choices，这里不渲染按钮 */}
              {!readOnlyOwner && m.choices && m.choices.length > 0 && (
                <div data-choices className="mt-2 space-y-2 rounded-lg border bg-slate-50 p-3">
                  {m.choices.map(g => (
                    <div key={g.term} className="space-y-1">
                      <p className="text-slate-500">{g.kind === 'missing' ? t('『{term}』指的是哪一个？', { term: g.term }) : t('『{term}』指哪一个？', { term: g.term })}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {g.candidates.map(c => (
                          <Button key={c.entryId} type="button" size="xs" variant="outline" data-choice={c.entryId} disabled={busy} onClick={() => onPickChoice(c.entryId)}>{c.name}</Button>
                        ))}
                        {/* 「都不是」（⑥-5）只属于未命中组：歧义组由点选回答，没有这个按钮 */}
                        {g.kind === 'missing' && (
                          <Button type="button" size="xs" variant="ghost" data-choice-none disabled={busy} onClick={() => onPickChoice(null)}>{t('都不是')}</Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* 「记为知识提案」卡片（⑥-4）：同样只给本人渲染，被分享人不能替主人提提案 */}
              {!readOnlyOwner && m.askCard && conversationId && <KnowledgeAskCard card={m.askCard} conversationId={conversationId} />}
            </>
          )}
          {m.toolsUsed && m.toolsUsed.length > 0 && (
            <p data-tools-used className="mt-1 text-xs text-slate-400">{t('用过的工具：{tools}', { tools: [...new Set(m.toolsUsed)].join(t('、')) })}</p>
          )}
        </div>
      ))}
      {busy && <p className="text-slate-500">{t('思考中…')}</p>}
    </>
  );
}
