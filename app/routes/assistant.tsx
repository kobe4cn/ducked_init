// app/routes/assistant.tsx —— AI 助手的资源路由（ADR-0043），顶栏侧栏（AssistantPanel）用它：任一登录成员都可以用。
// GET 返回是否配置了模型服务、最近一次探测是否支持工具调用（toolSupport：true / false / 没探测过为 null）、能否管理模型服务（canManageProvider，侧栏据此决定给不给「模型服务」页的链接）、成员可用的工具名、「我的对话」与「分享给我的」两个列表；带 ?id= 时再返回这个对话（本人或被分享人才能读，否则 404）。
// POST 接 JSON：{ conversationId?, message, page } 跑一轮问答（历史从保存的对话里取，只有本人能续写），记进对话后返回 { conversationId, reply, toolsUsed, workbenchSql?, planCard? }
// （workbenchSql 是本轮 prefill_workbench 通过校验的 SQL，有值时才带，前端拿它渲染「填入工作台」链接）；
// 计划随对话保存（ADR-0050）：本轮校验过的计划存进 assistant 消息，续写时把对话里最近一份带给 assistantTurn 作 priorPlan（存草稿前重新校验用），发给模型的只有文字；
// 计划卡（#452，P4⑯a）：带 plan 的消息在读时按读者自己的目录组装 planCard（读时再校验、不存状态），POST 返回与 ?id= 读回都带，
// 被分享人看到的卡片按他自己的目录组装（ADR-0005），卡片只进响应、不写库、不进发给模型的 content；
// { intent: 'share' | 'unshare', conversationId, email } 分享或撤销分享自己的对话。出错返回 { error } 与对应状态码
import type { Route } from './+types/assistant';
import { can } from '~/.server/access';
import { requireMember } from '~/.server/auth';
import type { AnalysisPlan } from '~/.server/catalog/plan';
import { resolveProvider } from '~/.server/llm';
import { toolSupport } from '~/.server/model-provider';
import {
  appendTurn, ConversationError, listMyConversations, listSharedWithMe, readConversation, shareConversation, unshareConversation,
  type Conversation,
} from '~/.server/assistant/conversations';
import { AssistantError, assistantTurn, MAX_HISTORY, type ChatTurn } from '~/.server/assistant/loop';
import { planCardView } from '~/.server/assistant/plan-card';
import { catalogFor, toolsFor } from '~/.server/assistant/tools';

const errorResponse = (e: unknown) => {
  if (e instanceof AssistantError || e instanceof ConversationError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
};

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const id = new URL(request.url).searchParams.get('id');
  try {
    let conversation: Conversation | undefined;
    if (id) {
      const read = await readConversation(member, id);
      // 只有对话里有 plan 时才查目录（每个请求一次），卡片按读者自己的目录组装：本人和被分享人看到的可以不同（ADR-0005）
      if (read.messages.some(m => m.plan)) {
        const catalog = await catalogFor(member);
        conversation = { ...read, messages: read.messages.map(m => (m.plan ? { ...m, planCard: planCardView(catalog, m.plan) } : m)) };
      } else conversation = read;
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
  let body: { intent?: unknown; conversationId?: unknown; message?: unknown; email?: unknown; page?: { path?: unknown; title?: unknown } };
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
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return Response.json({ error: '问题不能为空' }, { status: 400 });
    let history: ChatTurn[] = [];
    let priorPlan: AnalysisPlan | undefined;
    if (id) {
      const conversation = await readConversation(member, id);
      if (!conversation.owned) return Response.json({ error: '分享给你的对话只能看，不能续写' }, { status: 403 });
      // 保存的对话可以很长，交给模型的只取最近的若干轮（一问一答成对，加上这次的问题不超过 MAX_HISTORY 条）
      history = conversation.messages.slice(-(MAX_HISTORY - 2)).map(({ role, content }) => ({ role, content }));
      // 最近一份计划在完整消息里倒着找（截过的 history 里可能没有）；它不发给模型，只作存草稿前重新校验的兜底
      priorPlan = conversation.messages.filter(m => m.plan).at(-1)?.plan;
    }
    const page = { path: String(body?.page?.path ?? ''), title: String(body?.page?.title ?? '') };
    const { reply, toolsUsed, plan, workbenchSql } = await assistantTurn(member, [...history, { role: 'user', content: message }], page, priorPlan);
    // 本轮校验过计划时带计划卡：按成员自己的目录读时组装；被拒的那轮（如 reuse_result 计划填工作台）校验过计划也带
    return Response.json({
      conversationId: await appendTurn(member, id, message, reply, toolsUsed, plan, workbenchSql),
      reply, toolsUsed, ...(workbenchSql ? { workbenchSql } : {}),
      ...(plan ? { planCard: planCardView(await catalogFor(member), plan) } : {}),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
