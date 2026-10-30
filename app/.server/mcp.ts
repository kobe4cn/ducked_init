// app/.server/mcp.ts —— /mcp 的 MCP 服务（Streamable HTTP，无状态 JSON-RPC 2.0，ADR-0042）：手写，不依赖 MCP SDK。
// 调用方已由 requireMemberToken 认证为某位成员；只回 JSON，不开 SSE 流，不支持批量请求。
// 本期工具列表为空，tools/call 一律「没有这个工具」（工具注册表以后接进来）
import type { CurrentMember } from './auth';

const MCP_PROTOCOL_VERSION = '2025-06-18';

type Id = string | number | null;

const result = (id: Id, value: unknown) => Response.json({ jsonrpc: '2.0', id, result: value });
const error = (id: Id, code: number, message: string) => Response.json({ jsonrpc: '2.0', id, error: { code, message } });

/** 处理一条 JSON-RPC 消息；body 是请求体原文。通知（没有 id）回 202 空体 */
export async function handleMcp(_actor: CurrentMember, body: string): Promise<Response> {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return error(null, -32700, '请求体不是合法的 JSON');
  }
  if (Array.isArray(msg)) return error(null, -32600, '不支持批量请求');
  if (!msg || typeof msg !== 'object' || (msg as { jsonrpc?: unknown }).jsonrpc !== '2.0' || typeof (msg as { method?: unknown }).method !== 'string') {
    return error(null, -32600, '不是合法的 JSON-RPC 2.0 请求');
  }
  const { method } = msg as { method: string };
  if (!('id' in msg)) return new Response(null, { status: 202 });
  const rawId = (msg as { id: unknown }).id;
  const id: Id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  switch (method) {
    case 'initialize':
      return result(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'duckdb-crm', version: '1' } });
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: [] });
    case 'tools/call':
      return error(id, -32602, '没有这个工具');
    default:
      return error(id, -32601, `不支持的方法：${method}`);
  }
}
