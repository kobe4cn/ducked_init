// app/.server/assistant/loop.ts —— AI 助手的一轮问答（ADR-0043）：把对话、成员当前所在的页面与成员可用的工具交给模型，
// 按模型的 tool_calls 调注册表里的工具（runTool 按登记的权限检查）、结果作为 role: tool 回填，直到模型给出文字答复。
// 助手只能用注册表里的工具，不能执行查询、不能发布；工具出错时把错误文本回填给模型，由它决定怎么继续。
// 起草（ADR-0042）：校验、保存类工具以「经助手」的成员身份调用（审计带 via: 'assistant'），不通过时问题清单回填给模型修正，
// 最多再修正 maxFixes() 次（默认 MAX_FIXES，可用 ASSISTANT_MAX_FIXES 调）；仍不通过时不再请求模型，由服务端把问题清单与最后一版 YAML 交给成员；本轮有过同 kind 的定义校验通过时，
// 交的是最后一版通过的 YAML 并提示可直接保存（#1185）。中途校验通过不清零修正次数（通过 / 被拒交替也会到上限），保存成功才清零。
// 分析计划（ADR-0050）：每轮新建一个检索候选集合（ToolCtx.retrieved）传给每次工具调用，validate_plan 只认本轮 catalog_search / catalog_expand 返回过的条目
// 与对话里最近一份计划引用过的条目（#1179，一轮开始时用 planRetrievedIds(priorPlan) 预先填入）；
// 本轮校验过的最后一份结构合法的计划（ToolCtx.plan）随答复返回、由路由存进对话，对话里最近一份作为 priorPlan 带进下一轮：
// 它的摘要（不含 rationale 与步骤）拼在系统提示末尾，模型沿用它时不必重新检索；存草稿 / 填工作台前照旧对当前目录重新校验
// 本轮 prefill_workbench 通过校验的 SQL（ToolCtx.workbenchSql）随答复返回；本轮最后一次 catalog_search 判为歧义的追问候选（ToolCtx.choices，⑥-3）也随答复返回；
// 返回给前端的只有文字答复、用过的工具名、本轮的计划、这份 SQL 与歧义候选，不回传工具原文；
// 工具调用次数到 maxToolCalls()（默认 MAX_TOOL_CALLS，可用 ASSISTANT_MAX_TOOL_CALLS 调）时不带工具再请求一次，让模型总结本轮进展与下一步（#1180，失败时退回 LIMIT_REPLY）；本轮已有 valid 计划后 prefill_workbench 最多免计 2 次；
// 中途模型出错且本轮已调用过工具时返回 ERROR_REPLY 与本轮进展，第一次请求就出错仍 422（#1209）；
// 一轮开始时解析一次 reasoning 档位的路由（#531），整轮每次请求都用同一套端点与模型（chatToolsWith）、在 platform.llm_calls 记一条 assistant（route=reasoning），不存提示词与答复原文
import { can, deniedReason } from '../access';
import type { CurrentMember } from '../auth';
import type { Role } from '../db/schema';
import { planRetrievedIds, type AnalysisPlan } from '../catalog/plan';
import { DSL_KEY_PATTERN } from '../dsl-definitions';
import { ABORTED, chatToolsWith, LlmError, resolveRoute, withLlmContext, type LlmMessage, type LlmRoute } from '../llm';
import { dataOnlyNotice } from '../llm-prompts';
import { toolSupport } from '../model-provider';
import type { ChoiceGroup } from './conversations';
import { invokeTool, PLAN_MODE_RULE, toolsFor, type ToolCtx, type ToolResult } from './tools';

/** 每轮最多调用工具次数的默认值（ASSISTANT_MAX_TOOL_CALLS 没填或非法时用），用完时不带工具再请求一次、让模型总结进展与下一步（#1180）；
 *  要给检索、展开、校验计划与保存草稿都留出次数 */
export const MAX_TOOL_CALLS = 12;
/** 每轮交给模型的对话最多几条 */
export const MAX_HISTORY = 40;
/** 每条消息最多几个字 */
export const MAX_CONTENT = 4000;
/** 校验或保存不通过后，模型最多再修正次数的默认值（ASSISTANT_MAX_FIXES 没填或非法时用） */
export const MAX_FIXES = 3;

/** 读一个正整数环境变量（写法照 catalog/embeddings.ts 的 embedBatchSize）：没填或空串用默认，填了但非法时告警后回落默认 */
function positiveIntEnv(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  console.warn(`${name}=${JSON.stringify(raw)} is not a positive integer, falling back to the default ${fallback}`);
  return fallback;
}

/** 每轮最多调用工具的次数：ASSISTANT_MAX_TOOL_CALLS 每次调用都读（默认参数在调用时求值，stubEnv 生效），默认 MAX_TOOL_CALLS */
export function maxToolCalls(env: Record<string, string | undefined> = process.env): number {
  return positiveIntEnv(env, 'ASSISTANT_MAX_TOOL_CALLS', MAX_TOOL_CALLS);
}

/** 校验或保存不通过后模型最多再修正的次数：ASSISTANT_MAX_FIXES 每次调用都读，默认 MAX_FIXES */
export function maxFixes(env: Record<string, string | undefined> = process.env): number {
  return positiveIntEnv(env, 'ASSISTANT_MAX_FIXES', MAX_FIXES);
}
/** 本轮已有 valid 计划后，不计入工具调用上限（maxToolCalls()）的 prefill_workbench 最多几次（#1180） */
const MAX_FREE_PREFILLS = 2;
/** 超限后的总结请求失败时的答复 */
const LIMIT_REPLY = '本轮工具调用次数用完，已保存目前的进展；回复『继续』可以接着做';
/** 本轮已调用过工具后请求模型出错时的答复（#1209）：本轮的 plan / workbenchSql / choices 照常带回 */
export const ERROR_REPLY = '模型服务出错，本轮已保存目前的进展；回复『继续』可以重试';
/** 超限后追加在消息末尾的 system 提示：总结进展与下一步，不编造 */
const LIMIT_PROMPT = '本轮工具调用次数已用完，不能再调用工具。请用中文简短总结：这一轮查到了什么；计划是否已通过 validate_plan 校验；成员下一步该怎么说（例如「回复『填入工作台』」或「回复『继续』」）。不要编造没查到的结果，不要声称已执行查询或已填入工作台（除非 prefill_workbench 确实返回了已准备好）。';
/** 超限时没执行的调用回填的 tool 消息：assistant 消息里的每个 tool_call 都要有对应回复，否则服务商拒绝下一次请求 */
const SKIPPED = '未执行：本轮工具调用次数已用完';

/** 交给成员的问题清单最多列几行、YAML 最多几个字（侧栏把答复截到 4000 字，代码块要能闭合） */
const MAX_ISSUE_LINES = 20;
const MAX_YAML = 2500;

/** 放弃时的答复：问题清单与 YAML；fixes 是本轮的修正上限（和循环判断用同一个值）；valid 是本轮最后一版通过校验的同类定义（#1185），有时给它而不是被拒的那版，过长截断时提示重新起草 */
function unfixedReply({ issues, yaml }: NonNullable<ToolResult['rejected']>, fixes: number, valid?: string) {
  const lines = issues.split('\n');
  const listed = lines.length > MAX_ISSUE_LINES ? [...lines.slice(0, MAX_ISSUE_LINES), `……另有 ${lines.length - MAX_ISSUE_LINES} 行`] : lines;
  const shown = valid ?? yaml;
  const clipped = shown.length > MAX_YAML;
  const body = clipped ? `${shown.slice(0, MAX_YAML)}\n# ……YAML 过长，只显示前 ${MAX_YAML} 字` : shown;
  let head = `草稿没有通过校验，未保存（已修正 ${fixes} 次）。问题清单：`;
  let label = '最后一版 YAML';
  if (valid !== undefined) {
    const next = clipped ? `但过长只显示前 ${MAX_YAML} 字，请让我重新起草后保存` : '可以让我直接保存';
    head = `未保存：修正 ${fixes} 次后仍不通过；上一版已通过校验，${next}。最后一次的问题清单：`;
    label = '通过校验的那一版 YAML';
  }
  return `${head}\n${listed.join('\n')}\n\n${label}：\n\n\`\`\`yaml\n${body.endsWith('\n') ? body : `${body}\n`}\`\`\``;
}

/** 被拒的调用与通过的那版是同一 kind 的定义工具时，放弃时用通过的那版（映射工具被拒时不用） */
function sameKindValid(name: string, args: string, lastValid?: { kind: string; yaml: string }): string | undefined {
  if (!lastValid || (name !== 'validate_definition' && name !== 'save_definition_draft')) return undefined;
  try {
    return (JSON.parse(args || '{}') as { kind?: unknown }).kind === lastValid.kind ? lastValid.yaml : undefined;
  } catch { return undefined; }
}

const TOOLS_UNSUPPORTED = '该模型服务不支持工具调用，AI 助手无法使用：请管理员到「模型服务」页换一个支持工具调用的模型';

/** 各个 return 共用的展开：本轮校验过的计划、通过校验的 SQL 与最后一次搜索留下的歧义候选（⑥-3），没有的键不出现 */
const extras = (ctx: ToolCtx) => ({
  ...(ctx.plan ? { plan: ctx.plan } : {}),
  ...(ctx.workbenchSql ? { workbenchSql: ctx.workbenchSql } : {}),
  ...(ctx.choices?.length ? { choices: ctx.choices } : {}),
});

export class AssistantError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 422) { super(message); }
}

/** source: 'interpretation' 是工作台结果解读（#1259）：发给模型时改成 user 角色的引用，不当作助手说过的话 */
export interface ChatTurn { role: 'user' | 'assistant'; content: string; source?: 'interpretation' }
export interface AssistantPage { path: string; title: string }

/** 对话：1–40 条、每条最多 4000 字的 user / assistant 消息，最后一条是成员的问题 */
function checkHistory(history: unknown): asserts history is ChatTurn[] {
  if (!Array.isArray(history) || !history.length) throw new AssistantError('对话不能为空', 400);
  if (history.length > MAX_HISTORY) throw new AssistantError(`对话太长（最多 ${MAX_HISTORY} 条），请开始新的对话`, 400);
  for (const m of history) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') throw new AssistantError('对话格式不对', 400);
    if (m.content.length > MAX_CONTENT) throw new AssistantError(`每条消息最多 ${MAX_CONTENT} 字`, 400);
    if (m.source !== undefined && m.source !== 'interpretation') throw new AssistantError('对话格式不对', 400);
  }
  if (history.at(-1).role !== 'user') throw new AssistantError('最后一条须是成员的问题', 400);
}

const clip = (s: unknown) => (typeof s === 'string' ? s.slice(0, 200) : '');

/** 系统提示末尾「对话里最近一份计划」摘要的字数上限（#1179）：只放 mode、request、selected 与 excluded 的 id，不放 rationale 与步骤 */
export const MAX_PLAN_SUMMARY = 2000;

/**
 * 对话里最近一份计划的摘要（#1179）：超长时截到 MAX_PLAN_SUMMARY 字以内。
 * 块名 prior_plan 与字段都用英文键，说明写在系统提示改过措辞的那一句里（i18n 棘轮按含汉字的行计，提示词不豁免）
 */
function planSummary(plan: AnalysisPlan): string {
  const summary = [
    'prior_plan:',
    `mode: ${plan.mode}`,
    `request: ${JSON.stringify(plan.request)}`,
    'selected:',
    ...plan.selected.map(s => `- ${s.id}${s.version === undefined ? '' : ` · version: ${s.version}`} · semanticHash: ${s.semanticHash}`),
    ...(plan.excluded?.length ? [`excluded: ${plan.excluded.map(x => x.id).join(', ')}`] : []),
  ].join('\n');
  return summary.length > MAX_PLAN_SUMMARY ? `${summary.slice(0, MAX_PLAN_SUMMARY - 2)}\n…` : summary;
}

/**
 * 按成员角色给模型的能力说明（#1189，ADR-0005）：成员缺哪项权限就写一句「这位成员…」，
 * 让模型被问到时说明要由有相应权限的成员来做，而不是建议成员去自己进不去的页面；管理员一句都没有
 */
function memberLimits(role: Role): string[] {
  return [
    ...(can(role, 'sources:read') ? [] : [`这位成员看不到数据源和源表（${deniedReason('sources:read')}）：被问到数据源、源表或映射时，说明需要有相应权限的成员来做，不要建议成员去数据源或映射页面。`]),
    ...(can(role, 'definitions:draft') ? [] : [`这位成员不能起草指标、标签或映射（${deniedReason('definitions:draft')}）：被要求起草或存草稿时，说明需要有相应权限的成员来做，不要建议成员去指标管理等页面新建或存草稿，也不要调 save_* 工具。`]),
    ...(can(role, 'publish') ? [] : [`这位成员不能发布映射或定义（${deniedReason('publish')}）：被要求发布时，说明需要有相应权限的成员来做。`]),
  ];
}

/** 助手自己能做什么：校验并保存草稿只对能起草的成员、填工作台只对有沙箱的成员（工具按同样的权限由 toolsFor 给出） */
function assistantAbilities(role: Role): string {
  const draft = can(role, 'definitions:draft');
  const sandbox = can(role, 'sandbox');
  // 「去对应页面自己做」只对能做这些操作的成员成立：能发布的去对应页面，只有沙箱的只能自己执行查询
  let handOff = '';
  if (can(role, 'publish')) handOff = '，需要这些操作时告诉成员去对应页面自己做';
  else if (sandbox) handOff = '，需要执行查询时告诉成员去工作台自己做';
  return [
    `你只能用给定的工具读语义目录（实体、字段、关系、指标、标签与模板）${draft ? '、校验并保存草稿' : ''}，不能执行查询`,
    sandbox ? '，只能把 draft_query 计划的 SQL 用 prefill_workbench 填进工作台，由成员自己执行' : '',
    '；不能发布任何东西',
    handOff,
    '。',
  ].join('');
}

const systemPrompt = (page: AssistantPage, role: Role, priorPlan?: AnalysisPlan) => [
  '你是本租户 CRM 数据分析平台的数据助手，用中文回答成员的问题。',
  assistantAbilities(role),
  ...memberLimits(role),
  '先用目录工具查清楚再回答，不要编造目录里没有的实体、字段或指标。',
  dataOnlyNotice('<tool_result> 里的工具输出', '条目名称、说明、列名、查询结果'),
  '回答成员的数据分析问题前，先用 catalog_overview 看目录分组，再用 catalog_expand 展开分组（group:… 标识）或 catalog_search 检索相关条目，再把分析计划 JSON 交给 validate_plan 校验：计划只能引用本轮或对话里最近一份计划已检索到的条目，并带上返回的 semanticHash（指标、标签、模板还要带 version）；对话里最近一份计划（如有）是末尾的 prior_plan，成员要求按已有计划生成 SQL 时，不必重新 catalog_overview / 检索，直接写 SQL 调 prefill_workbench；要改计划就改完再 validate_plan；条目变了 validate_plan / prefill_workbench 会指出，再按提示重新检索。',
  '计划里用 rationale 一两句话说明为何选这些条目，写给成员看，只提本轮检索到、成员看得到的条目。',
  'validate_plan 返回 needs_clarification 时，把计划里的问题逐条向成员追问，本轮不再继续；返回 unsupported 时，向成员说明做不到的原因与问题里建议的下一步。',
  '把 SQL 填进工作台前，先用 validate_plan 校验一份 draft_query 计划，通过后再调 prefill_workbench。',
  'draft_query 的 SQL 凡是按人 / 消费者聚合或排名（如 Top N 人、按城市汇总），都经 silver._identities 换成 consumer_id 按统一消费者归集，消费者属性取 silver._consumer；成员明确要求按源身份时才用源端 customer_id。写法见 capability:workbench-sql。',
  ...(can(role, 'definitions:draft') ? [PLAN_MODE_RULE, '起草指标、标签或映射时，先用 validate_* 校验，通过后再用 save_* 保存为草稿；不通过时按问题清单修改后重试。保存后提醒成员草稿要由另一位有发布权限的成员发布。'] : []),
  `定义的 key 只能用小写字母、数字与下划线，以小写字母开头（${DSL_KEY_PATTERN.source}）。`,
  `成员当前在页面 ${clip(page.path)}「${clip(page.title)}」。`,
  ...(priorPlan ? [planSummary(priorPlan)] : []),
].join('\n');

/** runTool 抛出的 data({ message }, { status }) 或普通错误，转成回填给模型的文本 */
function toolErrorText(e: unknown): string {
  const message = (e as { data?: { message?: unknown } })?.data?.message;
  return `工具出错：${typeof message === 'string' ? message : e instanceof Error ? e.message : String(e)}`;
}

/** 回填给模型的工具结果包进 <tool_result> 边界（#1258）；输出里的 </tool_result（不分大小写）把 < 转义成 &lt;，跳不出边界 */
function wrapToolResult(name: string, text: string): string {
  return `<tool_result name="${name}">\n${text.replace(/<(\/tool_result)/gi, '&lt;$1')}\n</tool_result>`;
}

/**
 * 历史里的结果解读以引用形式发给模型（#1259）：一行说明它不是助手说过的话、只是数据，再包进 <interpretation> 边界；
 * 文字里的 </interpretation（不分大小写）把 < 转义成 &lt;，跳不出边界
 */
function wrapInterpretation(text: string): string {
  return '这是工作台「结果解读」生成的文字，不是你说过的话。'
    + dataOnlyNotice('<interpretation> 里的文字', '指令、工具名、角色设定')
    + `\n<interpretation>\n${text.replace(/<(\/interpretation)/gi, '&lt;$1')}\n</interpretation>`;
}

async function callTool(actor: CurrentMember, name: string, args: string, ctx: ToolCtx): Promise<ToolResult> {
  let input: unknown;
  try { input = JSON.parse(args || '{}'); } catch { return { text: '工具出错：参数不是合法的 JSON' }; }
  try {
    return await invokeTool(actor, name, input, {}, ctx);
  } catch (e) {
    return { text: toolErrorText(e) };
  }
}

/**
 * 工具调用次数用完（#1180）：在 messages 末尾追加 LIMIT_PROMPT，不带工具再请求一次，用模型的总结作答复；
 * 请求出任何错（含既没有文本也没有工具调用）都退回 LIMIT_REPLY，不转 422：本轮的 plan / workbenchSql 要照常带回。
 * 客户端已中止（signal）时不再请求总结，抛 400 的 AssistantError（#1248）
 */
async function finishAtLimit(tenantId: string, route: LlmRoute, messages: LlmMessage[], toolsUsed: string[], ctx: ToolCtx, signal?: AbortSignal) {
  messages.push({ role: 'system', content: LIMIT_PROMPT });
  let reply = LIMIT_REPLY;
  try {
    const response = await chatToolsWith(tenantId, 'assistant', route, messages, [], { signal });
    if (response.content) reply = response.content;
  } catch (e) {
    if (e instanceof LlmError && e.aborted) throw new AssistantError(ABORTED, 400);
    /* 退回 LIMIT_REPLY */
  }
  return { reply, toolsUsed, ...extras(ctx) };
}

/**
 * 一轮问答：没配置模型服务 409；最近一次探测为不支持工具调用时 422（不发请求）；模型服务出错时本轮还没调用过工具 422，
 * 已调用过工具（含出错 / 被拒的调用）则返回 ERROR_REPLY 与本轮的 plan / workbenchSql / choices（#1209）；对话不合格 400。
 * 工具调用次数到本轮上限（maxToolCalls()，默认 MAX_TOOL_CALLS）之后模型还要调用工具时，没执行的调用回填「未执行」，再不带工具请求一次、用模型对进展与下一步的总结作答复
 * （#1180，这次请求失败时用 LIMIT_REPLY），plan / workbenchSql 照常返回；本轮 validate_plan 返回过 valid 后 prefill_workbench 最多免计 MAX_FREE_PREFILLS 次。
 * priorPlan 是对话里最近一份计划（ADR-0050）：不带进发给模型的历史，摘要拼在系统提示末尾、它的条目预先算作本轮已检索（#1179），
 * 并经 ToolCtx 给存草稿 / 填工作台前的重新校验兜底；
 * 返回的 plan 只来自本轮 validate_plan（不回传 priorPlan），workbenchSql 是本轮 prefill_workbench 通过校验的 SQL（没有时都缺省）。
 * 一轮开始时解析一次 reasoning 档位的路由（#531）：整轮所有请求用同一个模型，中途改配置不影响本轮（tool_call 历史对模型敏感）。
 * signal 是这一轮的外部中止（#1248，路由传 request.signal）：客户端中止后不再发后续模型请求、不执行后续工具，抛 400 的
 * AssistantError（不返回 ERROR_REPLY），本轮已存下的草稿与审计照常保留
 */
export async function assistantTurn(
  actor: CurrentMember, history: ChatTurn[], page: AssistantPage, priorPlan?: AnalysisPlan, signal?: AbortSignal,
): Promise<{ reply: string; toolsUsed: string[]; plan?: AnalysisPlan; workbenchSql?: string; choices?: ChoiceGroup[] }> {
  // 整轮包进 withLlmContext（#1253）：这一轮里的所有模型调用（含工具里查询向量的 embedding）在 llm_calls 里共用同一个 turn_id、记提问人
  return withLlmContext({ actorEmail: actor.email }, async () => {
    checkHistory(history);
    const tenantId = actor.tenant.id;
    // 一轮开始时解析一次 reasoning 档位的路由（#531），整轮所有 chatToolsWith 都用它：中途改配置不影响本轮
    const route = await resolveRoute(tenantId, 'assistant');
    if (!route) throw new AssistantError('未配置模型服务：请到「模型服务」页配置端点、模型与 API Key', 409);
    if (await toolSupport(tenantId, route) === false) throw new AssistantError(TOOLS_UNSUPPORTED, 422);

    const tools = toolsFor(actor).map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema }));
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(page, actor.role, priorPlan) },
      ...history.map(m => (m.source === 'interpretation' ? { role: 'user' as const, content: wrapInterpretation(m.content) } : { role: m.role, content: m.content })),
    ];
    const toolsUsed: string[] = [];
    // 上限一轮开始时读一次，中途改环境变量不影响本轮
    const toolLimit = maxToolCalls();
    const fixLimit = maxFixes();
    // 本轮的上下文：retrieved 是本轮检索到的候选条目（catalog_search / catalog_expand 记进来，validate_plan 只认这些，每轮新建），
    // 一开始预先填入对话里最近一份计划引用过的条目（#1179，沿用计划不必重新检索；版本、哈希与可见性仍由 validatePlan 对当前目录检查），
    // priorPlan 是对话里最近一份计划，plan 由本轮 validate_plan 写进（不带 priorPlan 初始化，免得每轮把旧计划再存一遍）
    const ctx: ToolCtx = { retrieved: new Set(priorPlan ? planRetrievedIds(priorPlan) : []), priorPlan };
    // 经助手的操作在审计里注明（只加在这里传给工具的 actor 上）
    const via: CurrentMember = { ...actor, via: 'assistant' };
    let failures = 0;
    // 本轮最后一版校验通过的定义（#1185）：放弃时交给成员；保存成功后清掉，下一份草稿重新算
    let lastValid: { kind: string; yaml: string } | undefined;
    // 本轮 validate_plan 返回过 status: valid 之后（之后再校验失败也不撤回）prefill_workbench 免计，最多 MAX_FREE_PREFILLS 次；
    // 不用 ctx.plan 判断：status 不是 valid 时 validate_plan 也会写它
    let planValid = false;
    let freePrefills = 0;
    for (;;) {
      // 客户端中止（#1248）：不再发后续模型请求（chatToolsWith 里也会先查一次，这里在工具执行完的间隙也拦下）
      if (signal?.aborted) throw new AssistantError(ABORTED, 400);
      let response;
      try {
        response = await chatToolsWith(tenantId, 'assistant', route, messages, tools, { signal });
      } catch (e) {
        // 客户端中止（#1248）：不是模型服务的错（不 transient、不算超时），抛 400 结束本轮，不走 #1209 的 ERROR_REPLY
        if (e instanceof LlmError && e.aborted) throw new AssistantError(ABORTED, 400);
        if (e instanceof LlmError && toolsUsed.length) return { reply: ERROR_REPLY, toolsUsed, ...extras(ctx) };
        if (e instanceof LlmError) throw new AssistantError(`该模型服务不支持工具调用或调用失败：${e.message}`, 422);
        throw e;
      }
      if (!response.toolCalls.length) return { reply: response.content!, toolsUsed, ...extras(ctx) };
      // 一次给出的调用超出剩下的次数时只执行到上限，其余回填「未执行」后请求总结
      messages.push({
        role: 'assistant', content: response.content ?? '',
        tool_calls: response.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
      for (const [i, c] of response.toolCalls.entries()) {
        // 客户端中止（#1248）：这批以及后面的工具不再执行（超限时的总结也不再请求）
        if (signal?.aborted) throw new AssistantError(ABORTED, 400);
        const free = c.name === 'prefill_workbench' && planValid && freePrefills < MAX_FREE_PREFILLS;
        if (!free && toolsUsed.length - freePrefills === toolLimit) {
          for (const skipped of response.toolCalls.slice(i)) messages.push({ role: 'tool', tool_call_id: skipped.id, content: wrapToolResult(skipped.name, SKIPPED) });
          return finishAtLimit(tenantId, route, messages, toolsUsed, ctx, signal);
        }
        if (free) freePrefills++;
        toolsUsed.push(c.name);
        const result = await callTool(via, c.name, c.arguments, ctx);
        if (c.name === 'validate_plan' && result.text.startsWith('status: valid')) planValid = true;
        if (result.validated) lastValid = result.validated;
        if (result.rejected && ++failures > fixLimit) {
          return { reply: unfixedReply(result.rejected, fixLimit, sameKindValid(c.name, c.arguments, lastValid)), toolsUsed, ...extras(ctx) };
        }
        // 保存成功后再起草下一份，重新计修正次数与通过的那版
        if (result.saved) { failures = 0; lastValid = undefined; }
        messages.push({ role: 'tool', tool_call_id: c.id, content: wrapToolResult(c.name, result.text) });
      }
    }
  });
}
