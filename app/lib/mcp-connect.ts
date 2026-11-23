// app/lib/mcp-connect.ts —— 「我的设置」里接入方式的配置片段：Claude Code 命令、通用 JSON、自检 curl（ADR-0042）。
// 服务名固定为 crm，不随租户名或域名变；/mcp 只支持 Streamable HTTP 的 POST，所以片段一律写 http 传输。
// 没有明文时调用方把已翻译的占位符当令牌传进来，本模块不依赖 i18n

/** 片段里的 MCP 服务名，固定值 */
export const MCP_SERVER_NAME = 'crm';

export interface ConnectSnippets { claude: string; json: string; curl: string }

/** 按完整 MCP 地址与令牌（没有明文时传占位符）生成三段可直接复制的配置 */
export function connectSnippets(url: string, token: string): ConnectSnippets {
  const auth = `Authorization: Bearer ${token}`;
  return {
    claude: `claude mcp add --transport http ${MCP_SERVER_NAME} ${url} --header "${auth}"`,
    json: JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    curl: `curl -sS -X POST ${url} -H '${auth}' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  };
}
