// app/.server/assistant/loop.ts —— AI 助手的一轮问答（ADR-0043）：把对话、成员当前所在的页面与成员可用的工具交给模型，
// 按模型的 tool_calls 调注册表里的工具（runTool 按登记的权限检查）、结果作为 role: tool 回填，直到模型给出文字答复。
// 助手只能用注册表里的工具，不能执行查询、不能发布；工具出错时把错误文本回填给模型，由它决定怎么继续。
// 起草（ADR-0042）：校验、保存类工具以「经助手」的成员身份调用（审计带 via: 'assistant'），不通过时问题清单回填给模型修正，
// 最多再修正 MAX_FIXES 次；仍不通过时不再请求模型，由服务端把问题清单与最后一版 YAML 交给成员
// 返回给前端的只有文字答复与用过的工具名，不回传工具原文；每次请求在 platform.llm_calls 记一条 assistant（chatTools），不存提示词与答复原文
import type { CurrentMember } from '../auth';
import { DSL_KEY_PATTERN } from '../dsl-definitions';
import { chatTools, LlmError, resolveProvider, type LlmMessage } from '../llm';
import { invokeTool, toolsFor, type ToolResult } from './tools';

/** 每轮最多调用工具的次数，超出时结束本轮并告知成员 */
export const MAX_TOOL_CALLS = 8;
/** 每轮交给模型的对话最多几条 */
export const MAX_HISTORY = 40;
/** 每条消息最多几个字 */
export const MAX_CONTENT = 4000;
/** 校验或保存不通过后，模型最多再修正的次数 */
export const MAX_FIXES = 3;
const LIMIT_REPLY = `本轮已调用 ${MAX_TOOL_CALLS} 次工具，达到上限，先结束本轮。可以把问题问得更具体一些再试。`;

/** 交给成员的问题清单最多列几行、YAML 最多几个字（侧栏把答复截到 4000 字，代码块要能闭合） */
const MAX_ISSUE_LINES = 20;
const MAX_YAML = 2500;

function unfixedReply({ issues, yaml }: NonNullable<ToolResult['rejected']>) {
  const lines = issues.split('\n');
  const listed = lines.length > MAX_ISSUE_LINES ? [...lines.slice(0, MAX_ISSUE_LINES), `……另有 ${lines.length - MAX_ISSUE_LINES} 行`] : lines;
  const body = yaml.length > MAX_YAML ? `${yaml.slice(0, MAX_YAML)}\n# ……YAML 过长，只显示前 ${MAX_YAML} 字` : yaml;
  return `草稿没有通过校验，未保存（已修正 ${MAX_FIXES} 次）。问题清单：\n${listed.join('\n')}\n\n最后一版 YAML：\n\n\`\`\`yaml\n${body.endsWith('\n') ? body : `${body}\n`}\`\`\``;
}

export class AssistantError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 422) { super(message); }
}

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface AssistantPage { path: string; title: string }

/** 对话：1–40 条、每条最多 4000 字的 user / assistant 消息，最后一条是成员的问题 */
function checkHistory(history: unknown): asserts history is ChatTurn[] {
  if (!Array.isArray(history) || !history.length) throw new AssistantError('对话不能为空', 400);
  if (history.length > MAX_HISTORY) throw new AssistantError(`对话太长（最多 ${MAX_HISTORY} 条），请开始新的对话`, 400);
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') throw new AssistantError('对话格式不对', 400);
    if (m.content.length > MAX_CONTENT) throw new AssistantError(`每条消息最多 ${MAX_CONTENT} 字`, 400);
  }
  if (history.at(-1).role !== 'user') throw new AssistantError('最后一条须是成员的问题', 400);
}

const clip = (s: unknown) => (typeof s === 'string' ? s.slice(0, 200) : '');

const systemPrompt = (page: AssistantPage) => [
  '你是本租户 CRM 数据分析平台的数据助手，用中文回答成员的问题。',
  '你只能用给定的工具读语义目录（实体、字段、关系、指标、标签与模板）、校验并保存草稿，不能执行查询、不能发布任何东西；需要这些操作时告诉成员去对应页面自己做。',
  '先用目录工具查清楚再回答，不要编造目录里没有的实体、字段或指标。',
  '起草指标、标签或映射时，先用 validate_* 校验，通过后再用 save_* 保存为草稿；不通过时按问题清单修改后重试。保存后提醒成员草稿要由另一位有发布权限的成员发布。',
  `定义的 key 只能用小写字母、数字与下划线，以小写字母开头（${DSL_KEY_PATTERN.source}）。`,
  `成员当前在页面 ${clip(page.path)}「${clip(page.title)}」。`,
].join('\n');

/** runTool 抛出的 data({ message }, { status }) 或普通错误，转成回填给模型的文本 */
function toolErrorText(e: unknown): string {
  const message = (e as { data?: { message?: unknown } })?.data?.message;
  return `工具出错：${typeof message === 'string' ? message : e instanceof Error ? e.message : String(e)}`;
}

async function callTool(actor: CurrentMember, name: string, args: string): Promise<ToolResult> {
  let input: unknown;
  try { input = JSON.parse(args || '{}'); } catch { return { text: '工具出错：参数不是合法的 JSON' }; }
  try {
    return await invokeTool(actor, name, input);
  } catch (e) {
    return { text: toolErrorText(e) };
  }
}

/**
 * 一轮问答：没配置模型服务 409；模型服务出错（包括不支持工具调用）422；对话不合格 400。
 * 第 MAX_TOOL_CALLS 次工具调用之后模型还要调用工具时，结束本轮并告知
 */
export async function assistantTurn(actor: CurrentMember, history: ChatTurn[], page: AssistantPage): Promise<{ reply: string; toolsUsed: string[] }> {
  checkHistory(history);
  const tenantId = actor.tenant.id;
  if (!await resolveProvider(tenantId)) throw new AssistantError('未配置模型服务：请到「模型服务」页配置端点、模型与 API Key', 409);

  const tools = toolsFor(actor).map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(page) },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ];
  const toolsUsed: string[] = [];
  // 经助手的操作在审计里注明（只加在这里传给工具的 actor 上）
  const via: CurrentMember = { ...actor, via: 'assistant' };
  let failures = 0;
  for (;;) {
    let response;
    try {
      response = await chatTools(tenantId, 'assistant', messages, tools);
    } catch (e) {
      if (e instanceof LlmError) throw new AssistantError(`该模型服务不支持工具调用或调用失败：${e.message}`, 422);
      throw e;
    }
    if (!response.toolCalls.length) return { reply: response.content!, toolsUsed };
    if (toolsUsed.length === MAX_TOOL_CALLS) return { reply: LIMIT_REPLY, toolsUsed };
    // 一次给出的调用超出剩下的次数时只执行到上限就结束本轮
    messages.push({
      role: 'assistant', content: response.content ?? '',
      tool_calls: response.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    });
    for (const c of response.toolCalls) {
      if (toolsUsed.length === MAX_TOOL_CALLS) return { reply: LIMIT_REPLY, toolsUsed };
      toolsUsed.push(c.name);
      const result = await callTool(via, c.name, c.arguments);
      if (result.rejected && ++failures > MAX_FIXES) return { reply: unfixedReply(result.rejected), toolsUsed };
      // 保存成功后再起草下一份，重新计修正次数
      if (result.saved) failures = 0;
      messages.push({ role: 'tool', tool_call_id: c.id, content: result.text });
    }
  }
}
