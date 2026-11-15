// app/routes/assistant.tsx —— AI 助手的资源路由（ADR-0043），顶栏侧栏（AssistantPanel）用它：任一登录成员都可以用。
// GET 返回是否配置了模型服务、最近一次探测是否支持工具调用（toolSupport：true / false / 没探测过为 null）、能否管理模型服务（canManageProvider，侧栏据此决定给不给「模型服务」页的链接）、成员可用的工具名、「我的对话」与「分享给我的」两个列表；带 ?id= 时再返回这个对话（本人或被分享人才能读，否则 404）。
// POST 接 JSON：{ conversationId?, message, page } 跑一轮问答（历史从保存的对话里取，只有本人能续写），记进对话后返回 { conversationId, reply, toolsUsed, workbenchSql?, planCard?, choices? }
// （workbenchSql 是本轮 prefill_workbench 通过校验的 SQL，有值时才带，前端拿它渲染「填入工作台」链接）；
// 计划随对话保存（ADR-0050）：本轮校验过的计划存进 assistant 消息，续写时把对话里最近一份带给 assistantTurn 作 priorPlan（存草稿前重新校验用），发给模型的只有文字；
// 计划卡（#452，P4⑯a）：带 plan 的消息在读时按读者自己的目录组装 planCard（读时再校验、不存状态），POST 返回与 ?id= 读回都带；
// 读回响应只给 planCard、不给原始 plan（#539：被分享人看不到的 excluded 条目 id 不能出现在 HTML / JSON 里），
// 被分享人看到的卡片按他自己的目录组装（ADR-0005），卡片只进响应、不写库、不进发给模型的 content；
// 歧义追问的结构化候选（⑥-3，ADR-0047 / 0046）：判为歧义的那轮 assistant 消息带 choices（词与候选条目 id，加密保存），
// POST 返回与 ?id= 读回都按读者自己的目录组装成带名称的视图（#539：看不到的条目 id 与名称都不出现），不进发给模型的历史；
// POST 带 { conversationId, choice: { entryId } } 时服务端核对（对话属于本人、entryId 在最后一条 assistant 消息的候选里、在自己的目录里），
// 通过后自己生成「『词』按 〈名称〉（entryId）理解」的用户消息继续这一轮（不收自由文本），这条 user 消息带 chosen；任一项不满足 400 且不请求模型；
// { intent: 'share' | 'unshare', conversationId, email } 分享或撤销分享自己的对话；
// { intent: 'knowledge.propose', conversationId, index }（⑥-4，ADR-0046 / 0056）把对话里点选候选时存下的 chosen 确认成一条
// 待复核的 term_default 提案：只收这两个字段，词与条目从服务端存下的 chosen 里取（不收客户端传来的值），
// 卡片的显示条件（无权限 / 已有同词提案 / 指纹已拒绝）同样挡住提交（403 / 409）。出错返回 { error } 与对应状态码
import type { Route } from './+types/assistant';
import { can } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import type { Catalog } from '~/.server/catalog';
import type { AnalysisPlan } from '~/.server/catalog/plan';
import { resolveProvider } from '~/.server/llm';
import { toolSupport } from '~/.server/model-provider';
import {
  appendTurn, ConversationError, lastChoices, listMyConversations, listSharedWithMe, readConversation, shareConversation, unshareConversation,
  type Conversation, type StoredMessage,
} from '~/.server/assistant/conversations';
import { askCardFor, proposeDefault, type AskCard } from '~/.server/assistant/knowledge-ask';
import { AssistantError, assistantTurn, MAX_HISTORY, type ChatTurn } from '~/.server/assistant/loop';
import { planCardView, type PlanCardView } from '~/.server/assistant/plan-card';
import { catalogFor, toolsFor } from '~/.server/assistant/tools';
import { KnowledgeError } from '~/.server/knowledge/basis';
import { ProposalError } from '~/.server/knowledge/proposals';

/** 歧义追问候选的视图（⑥-3）：按读者自己的目录只留看得到的条目并带名称（#539：看不到的条目 id 与名称都不出现） */
interface ChoiceGroupView { term: string; candidates: { entryId: string; name: string }[] }

/** ?id= 读回的对话：消息不带原始 plan 与候选 id 列表，只带读时组装的 planCard（#539）、按读者目录过滤后的 choices（⑥-3）与只给本人组装的 askCard（⑥-4） */
type ConversationView = Omit<Conversation, 'messages'> & { messages: (Omit<StoredMessage, 'plan' | 'choices'> & { planCard?: PlanCardView; choices?: ChoiceGroupView[]; askCard?: AskCard })[] };

const choicesView = (catalog: Catalog, choices: NonNullable<StoredMessage['choices']>): ChoiceGroupView[] =>
  choices.map(({ term, candidates }) => ({
    term,
    candidates: candidates.flatMap(entryId => {
      const entry = catalog.entries.find(e => e.id === entryId);
      return entry ? [{ entryId, name: entry.name }] : [];
    }),
  }));

const errorResponse = (e: unknown) => {
  if (e instanceof AssistantError || e instanceof ConversationError || e instanceof KnowledgeError || e instanceof ProposalError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  throw e;
};

// 这个资源路由只服务挂在 app-shell 上的 AI 助手侧栏，侧栏的读取全部是显式的 fetcher load（打开面板 / 打开对话 /
// 点选候选与分享后重读；fetcher.load 本身不经过 shouldRevalidate）。所以一律关掉自动重读：否则动作提交后会多一次
// GET，「记为知识提案」确认后刚显示的「已提交，待复核」会被重读刷掉（⑥-4，卡片读时组装，有了待复核提案就不再带）；
// 页面跳转时 overview / conversationLoad 两个 fetcher 也会被重读，conversationLoad 读回旧对话会盖掉面板里的当前对话。
// 代价：在别的页面提交表单后，面板不会自动刷新，要等下一次显式 load
export const shouldRevalidate = () => false;

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const id = new URL(request.url).searchParams.get('id');
  try {
    let conversation: ConversationView | undefined;
    if (id) {
      const read = await readConversation(member, id);
      // 只有对话里有 plan 或歧义候选时才查目录（每个请求一次；「记为知识提案」卡片由 askCardFor 自己查），卡片与候选都按读者自己的目录组装：本人和被分享人看到的可以不同（ADR-0005）；
      // 读回只给 planCard、不给原始 plan（#539：plan.excluded 里有读者看不到的条目 id，比如自带数据源名的 table:…，不能经它泄露），
      // 候选同样只给过滤后的视图：存着的候选 id 列表不进响应
      // 「记为知识提案」卡片（⑥-4）：点选候选的那条 user 消息带 chosen，卡片加在它后面那条 assistant 消息上，读时计算、不存库
      // （审核状态变了，读回跟着变）；只给本人组装——被分享人只读，不能替主人提提案
      const chosenBefore = (i: number) => (read.owned ? read.messages[i - 1]?.chosen : undefined);
      const catalog = read.messages.some(m => m.plan || m.choices) ? await catalogFor(member) : null;
      conversation = {
        ...read,
        messages: await Promise.all(read.messages.map(async ({ plan, choices, ...m }, i) => {
          const chosen = chosenBefore(i);
          const askCard = chosen ? await askCardFor(member, chosen, i - 1) : null;
          return {
            ...m,
            ...(plan && catalog ? { planCard: planCardView(catalog, plan) } : {}),
            ...(choices && catalog ? { choices: choicesView(catalog, choices) } : {}),
            ...(askCard ? { askCard } : {}),
          };
        })),
      };
    }
    return Response.json({
      configured: !!await resolveProvider(member.tenant.id),
      toolSupport: await toolSupport(member.tenant.id),
      canManageProvider: can(member.role, 'model_provider:manage'),
      tools: toolsFor(member).map(t => t.name),
      mine: await listMyConversations(member),
      shared: await listSharedWithMe(member),
      ...(conversation ? { conversation } : {}),
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requireMember(request);
  let body: { intent?: unknown; conversationId?: unknown; message?: unknown; choice?: unknown; email?: unknown; index?: unknown; page?: { path?: unknown; title?: unknown } };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  const id = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : null;
  try {
    if (body?.intent === 'share' || body?.intent === 'unshare') {
      if (!id) return Response.json({ error: '缺少对话' }, { status: 400 });
      const email = await (body.intent === 'share' ? shareConversation : unshareConversation)(member, id, String(body.email ?? ''));
      return Response.json({ ok: true, email });
    }
    if (body?.intent === 'knowledge.propose') {
      // 只收 conversationId 与 index：词与条目从服务端存下的 chosen 里取（ADR-0046），body 里别的字段一概不读
      if (!id) return Response.json({ error: '缺少对话' }, { status: 400 });
      if (typeof body.index !== 'number' || !Number.isInteger(body.index)) return Response.json({ error: 'index 要是整数' }, { status: 400 });
      const out = await proposeDefault(member, id, body.index);
      return out instanceof Response ? out : Response.json(out);
    }
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    // choice（⑥-3）：点选上一轮歧义追问的候选来回答，与 message 互斥；entryId 以外的都不收（term 由服务端从存着的候选反查，ADR-0046）
    const choiceInput = typeof body?.choice === 'object' && body.choice !== null ? body.choice as { entryId?: unknown } : undefined;
    if (choiceInput && message) return Response.json({ error: 'choice 与 message 不能同时出现' }, { status: 400 });
    const choice = typeof choiceInput?.entryId === 'string' && choiceInput.entryId ? choiceInput.entryId : null;
    if (choiceInput && !choice) return Response.json({ error: 'choice 要是 { entryId }' }, { status: 400 });
    if (!choice && !message) return Response.json({ error: '问题不能为空' }, { status: 400 });
    if (choice && !id) return Response.json({ error: '缺少对话' }, { status: 400 });
    let history: ChatTurn[] = [];
    let priorPlan: AnalysisPlan | undefined;
    let userText = message;
    let chosen: { term: string; entryId: string } | undefined;
    let chosenIndex = 0;
    if (id) {
      const conversation = await readConversation(member, id);
      if (!conversation.owned) return Response.json({ error: '分享给你的对话只能看，不能续写' }, { status: 403 });
      // 追加前的消息数就是这条 chosen user 消息将要落到的下标（⑥-4 卡片与提交都按它取回选择）
      chosenIndex = conversation.messages.length;
      // 保存的对话可以很长，交给模型的只取最近的若干轮（一问一答成对，加上这次的问题不超过 MAX_HISTORY 条）
      history = conversation.messages.slice(-(MAX_HISTORY - 2)).map(({ role, content }) => ({ role, content }));
      // 最近一份计划在完整消息里倒着找（截过的 history 里可能没有）；它不发给模型，只作存草稿前重新校验的兜底
      priorPlan = conversation.messages.filter(m => m.plan).at(-1)?.plan;
      if (choice) {
        // 核对三点：对话属于本人（上面已查）；entryId 在最后一条 assistant 消息的候选里；在自己的目录里。不满足 400 且不请求模型
        const group = lastChoices(conversation)?.find(g => g.candidates.includes(choice));
        if (!group) return Response.json({ error: '这个条目不在上一轮追问的候选里' }, { status: 400 });
        const entry = (await catalogFor(member)).entries.find(e => e.id === choice);
        if (!entry) return Response.json({ error: '这个条目不在你的目录里' }, { status: 400 });
        userText = `『${group.term}』按 〈${entry.name}〉（${choice}）理解`;
        chosen = { term: group.term, entryId: choice };
      }
    }
    const page = { path: String(body?.page?.path ?? ''), title: String(body?.page?.title ?? '') };
    const { reply, toolsUsed, plan, workbenchSql, choices } = await assistantTurn(member, [...history, { role: 'user', content: userText }], page, priorPlan);
    const conversationId = await appendTurn(member, id, { userText, reply, toolsUsed, ...(plan ? { plan } : {}), ...(workbenchSql ? { workbenchSql } : {}), ...(choices ? { choices } : {}), ...(chosen ? { chosen } : {}) });
    // 本轮校验过计划时带计划卡、判出过歧义时带候选：都按成员自己的目录读时组装；被拒的那轮（如 reuse_result 计划填工作台）校验过计划也带
    const catalog = plan || choices ? await catalogFor(member) : null;
    // 「记为知识提案」卡片（⑥-4）：点选候选回答的那轮按存下的 chosen 确定性组装（不是模型生成的），无权限 / 已有同词提案 /
    // 指纹已拒绝时不带（askCardFor 里检查，与提交同一套条件）
    const askCard = chosen ? await askCardFor(member, chosen, chosenIndex) : null;
    return Response.json({
      conversationId, reply, toolsUsed,
      ...(workbenchSql ? { workbenchSql } : {}),
      ...(plan && catalog ? { planCard: planCardView(catalog, plan) } : {}),
      ...(choices && catalog ? { choices: choicesView(catalog, choices) } : {}),
      ...(askCard ? { askCard } : {}),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
