// app/routes/assistant.tsx —— AI 助手的资源路由（ADR-0043），顶栏侧栏（AssistantPanel）用它：任一登录成员都可以用。
// GET 返回是否配置了模型服务、最近一次探测是否支持工具调用（toolSupport：true / false / 没探测过为 null）、成员可用的工具名、「我的对话」与「分享给我的」两个列表；带 ?id= 时再返回这个对话（本人或被分享人才能读，否则 404）。
// POST 接 JSON：{ conversationId?, message, page } 跑一轮问答（历史从保存的对话里取，只有本人能续写），记进对话后返回 { conversationId, reply, toolsUsed }；
// { intent: 'share' | 'unshare', conversationId, email } 分享或撤销分享自己的对话。出错返回 { error } 与对应状态码
import type { Route } from './+types/assistant';
import { requireMember } from '~/.server/auth';
import { resolveProvider } from '~/.server/llm';
import { toolSupport } from '~/.server/model-provider';
import {
  appendTurn, ConversationError, listMyConversations, listSharedWithMe, readConversation, shareConversation, unshareConversation,
} from '~/.server/assistant/conversations';
import { AssistantError, assistantTurn, MAX_HISTORY, type ChatTurn } from '~/.server/assistant/loop';
import { toolsFor } from '~/.server/assistant/tools';

const errorResponse = (e: unknown) => {
  if (e instanceof AssistantError || e instanceof ConversationError) return Response.json({ error: e.message }, { status: e.status });
  throw e;
};

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const id = new URL(request.url).searchParams.get('id');
  try {
    return Response.json({
      configured: !!await resolveProvider(member.tenant.id),
      toolSupport: await toolSupport(member.tenant.id),
      tools: toolsFor(member).map(t => t.name),
      mine: await listMyConversations(member),
      shared: await listSharedWithMe(member),
      ...(id ? { conversation: await readConversation(member, id) } : {}),
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
    if (id) {
      const conversation = await readConversation(member, id);
      if (!conversation.owned) return Response.json({ error: '分享给你的对话只能看，不能续写' }, { status: 403 });
      // 保存的对话可以很长，交给模型的只取最近的若干轮（一问一答成对，加上这次的问题不超过 MAX_HISTORY 条）
      history = conversation.messages.slice(-(MAX_HISTORY - 2)).map(({ role, content }) => ({ role, content }));
    }
    const page = { path: String(body?.page?.path ?? ''), title: String(body?.page?.title ?? '') };
    const { reply, toolsUsed } = await assistantTurn(member, [...history, { role: 'user', content: message }], page);
    return Response.json({ conversationId: await appendTurn(member, id, message, reply, toolsUsed), reply, toolsUsed });
  } catch (e) {
    return errorResponse(e);
  }
}
