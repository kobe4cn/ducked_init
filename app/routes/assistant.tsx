// app/routes/assistant.tsx —— AI 助手的资源路由（ADR-0043），顶栏侧栏（AssistantPanel）用它：任一登录成员都可以用。
// GET 返回是否配置了模型服务与成员可用的工具名；POST 接 JSON { history, page } 跑一轮问答，返回 { reply, toolsUsed }，出错返回 { error } 与对应状态码
import type { Route } from './+types/assistant';
import { requireMember } from '~/.server/auth';
import { resolveProvider } from '~/.server/llm';
import { AssistantError, assistantTurn, type ChatTurn } from '~/.server/assistant/loop';
import { toolsFor } from '~/.server/assistant/tools';

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  return Response.json({ configured: !!await resolveProvider(member.tenant.id), tools: toolsFor(member).map(t => t.name) });
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requireMember(request);
  let body: { history?: unknown; page?: { path?: unknown; title?: unknown } };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  const page = { path: String(body?.page?.path ?? ''), title: String(body?.page?.title ?? '') };
  try {
    return Response.json(await assistantTurn(member, body?.history as ChatTurn[], page));
  } catch (e) {
    if (e instanceof AssistantError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
