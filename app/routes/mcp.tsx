// app/routes/mcp.tsx —— 平台外的 Agent 经 MCP 接入（Streamable HTTP，ADR-0042）：Bearer 成员个人令牌，不读 cookie。
// 只接受 POST 一条 JSON-RPC 消息并回 JSON；GET（SSE 流）回 405
import type { Route } from './+types/mcp';
import { handleMcp } from '~/.server/mcp';
import { requireMemberToken } from '~/.server/member-tokens';

export function loader() {
  return Response.json({ error: '不支持 SSE 流，请用 POST 发送 JSON-RPC 消息' }, { status: 405, headers: { Allow: 'POST' } });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') return Response.json({ error: '只支持 POST' }, { status: 405, headers: { Allow: 'POST' } });
  const { actor } = await requireMemberToken(request);
  return handleMcp(actor, await request.text());
}
