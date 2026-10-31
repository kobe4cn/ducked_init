// app/.server/mcp.ts —— /mcp 的 MCP 服务（Streamable HTTP，无状态 JSON-RPC 2.0，ADR-0042）：手写，不依赖 MCP SDK。
// 调用方已由 requireMemberToken 认证为某位成员；只回 JSON，不开 SSE 流，不支持批量请求。
// 工具来自助手的工具注册表里 external 的那部分，按成员当前角色与令牌的授权（允许执行查询才有 run_query）过滤；注册表里没有发布工具，Agent 只能存草稿。
// 调用时 actor 带 via: 'mcp'，审计 detail 随之带上。没有这个工具、无权限、输入不对、校验不通过、查询出错（白名单、超时、并发 429）都是 isError 的工具结果，不是 JSON-RPC 错误
import { externalToolsFor, invokeTool, TOOLS, type ToolGrants } from './assistant/tools';
import type { CurrentMember } from './auth';
import { WorkbenchError } from './workbench';

const MCP_PROTOCOL_VERSION = '2025-06-18';

type Id = string | number | null;

const result = (id: Id, value: unknown) => Response.json({ jsonrpc: '2.0', id, result: value });
const error = (id: Id, code: number, message: string) => Response.json({ jsonrpc: '2.0', id, error: { code, message } });

/** 处理一条 JSON-RPC 消息；body 是请求体原文，grants 是令牌上的授权。通知（没有 id）回 202 空体 */
export async function handleMcp(actor: CurrentMember, body: string, grants: ToolGrants = {}): Promise<Response> {
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
  const { method, params } = msg as { method: string; params?: unknown };
  if (!('id' in msg)) return new Response(null, { status: 202 });
  const rawId = (msg as { id: unknown }).id;
  const id: Id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
  switch (method) {
    case 'initialize':
      return result(id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'duckdb-crm', version: '1' } });
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: externalToolsFor(actor, grants).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case 'tools/call':
      return result(id, await callExternalTool(actor, params, grants));
    default:
      return error(id, -32601, `不支持的方法：${method}`);
  }
}

const toolResult = (text: string, isError: boolean) => ({ content: [{ type: 'text', text }], isError });

/**
 * tools/call：不是 external 的工具当作没有。故意不按 externalToolsFor 过滤：无权限或令牌没有授权时让 invokeTool 的 403 说明原样返回。
 * invokeTool 抛的 data({ message })（4xx）与 WorkbenchError 转成 isError 结果，其他异常照旧抛出（500），以免掩盖缺陷
 */
async function callExternalTool(actor: CurrentMember, params: unknown, grants: ToolGrants) {
  const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const tool = TOOLS.find(t => t.name === name && t.external);
  if (!tool) return toolResult('没有这个工具', true);
  try {
    const r = await invokeTool({ ...actor, via: 'mcp' }, tool.name, args ?? {}, grants);
    return toolResult(r.text, !!r.rejected);
  } catch (e) {
    if (e instanceof WorkbenchError) return toolResult(e.message, true);
    const { data: body, init } = (e ?? {}) as { data?: { message?: unknown }; init?: { status?: number } | null };
    if (typeof body?.message === 'string' && (init?.status ?? 500) < 500) return toolResult(body.message, true);
    throw e;
  }
}
