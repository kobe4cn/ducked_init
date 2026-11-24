// app/.server/assistant/tools.ts —— AI 助手的工具注册表（ADR-0042）：每个工具登记名称、输入输出 JSON Schema、所需权限与是否允许外部调用
// （/mcp 的工具从这张表里 external 的那部分生成，外部能用的始终是内部的子集）。成员只看得到自己有权限的工具，调用时再按登记的权限检查一次：成员没有的权限助手也用不了。
// 工具返回给模型的是文本；校验或保存不通过时另带上问题清单与那一版 YAML（rejected），助手循环据此计数、超过修正次数时交给成员（ADR-0043）。
// 保存类工具只存草稿，发布照旧双人；注册表里没有发布工具。执行查询的 run_query 另要令牌的授权（requires: 'allowQuery'）：只有签发时允许执行查询的令牌经 MCP 拿得到，
// 平台内的助手拿不到（toolsFor 不含、invokeTool 不带授权时 403）；结果按工作台解读的规则剔除列，但对全部返回行判断哈希（ADR-0043）。目录按角色过滤（catalogFor）：没有 sources:read 的成员看不到数据源与源表条目、字段来源与实体映射到的源表（ADR-0005）。
// 分析计划（ADR-0050）：目录检索工具的输出给每个条目带语义哈希（同一份按角色裁剪的目录上算），并把条目 id 记进 ToolCtx.retrieved（助手循环每轮新建）；
// 目录总览分层（#854）：catalog_overview 只给第一层分组（groupOverview），catalog_expand 认 group: 分组标识（groupItems，组内条目同样带哈希并记进 retrieved），
// 大目录不再截掉条目；查看者的目录里没有数据源条目，第一层不出 group:sources 汇总行、展开也回「没有这个条目」；
// validate_plan 只认本轮检索到的条目与对话里最近一份计划引用过的条目（#1179，助手循环预先记进 retrieved），依赖变了的问题提示重新检索，校验结果渲染成文本、不带 rejected（不计修正次数）；它不对外开放（external: false），外部没有这个上下文。
// validate_plan 发给模型的参数 Schema 是剥掉条件关键字的 PLAN_SCHEMA、说明附最小示例（PLAN_EXAMPLE），入参校验另用 inputCheck 只查 plan 是对象，结构错误仍由 validatePlan 逐条返回（#1178）。
// 本轮校验过的计划经 ToolCtx 带走随对话保存；save_definition_draft 存草稿前对最新目录重新校验（本轮的优先，其次对话里最近一份），
// 不是 valid 就不保存、说明原因（依赖变了 / 看不到所选条目时说计划已过期，否则写明计划状态，如 clarify 计划的 needs_clarification），不带 rejected；外部经 MCP 调用不带 ctx，没有计划，行为与不带计划时一致。
// prefill_workbench（#424 选 A）把 draft_query 计划写好的 SQL 准备填进工作台：同样对最新目录重新校验计划（没有计划时拒绝，与存草稿不同），
// SQL 经 checkDraftedSql 按工作台白名单检查、不执行（ADR-0043），通过后经 ToolCtx.workbenchSql 随本轮返回，由成员自己执行；它不对外开放（external: false，外部没有计划上下文）
import { Ajv, type ValidateFunction } from 'ajv';
import { and, eq } from 'drizzle-orm';
import { data } from 'react-router';
import { parse } from 'yaml';
import { assertCan, can, type Permission } from '../access';
import type { CurrentMember } from '../auth';
import { expand, groupItems, groupOverview, toMarkdown, type Catalog, type CatalogEntry } from '../catalog';
import { judgeAmbiguity, type AmbiguityGroup } from '../catalog/ambiguity';
import { tenantCatalog } from '../catalog/load';
import { PLAN_SCHEMA, planRetrievedIds, semanticHash, validatePlan, type AnalysisPlan, type PlanIssue, type PlanStatus } from '../catalog/plan';
import { rankedSearch, visibilityClass, visibleCatalog } from '../catalog/projection';
import type { HitReason, Ranked } from '../catalog/rank';
import { getDb } from '../db/client';
import { dslDefinitions, mappings, spaces, tenants } from '../db/schema';
import { createDefinition, DslError, saveDslDraft, validateDefinition } from '../dsl-definitions';
import { METRIC_SCHEMA, type DslIssue } from '../pipeline/dsl/metric-spec';
import { TAG_SCHEMA } from '../pipeline/dsl/tag-spec';
import { createMapping, MappingError, saveMappingDraft, validateNewMapping } from '../mappings';
import type { ChoiceGroup } from './conversations';
import { sourceIdByName } from '../source-config';
import { checkDraftedSql, runQuery, WORKBENCH_ROWS } from '../workbench';
import { MAX_CELL, redactResult } from '../workbench-ai';

export interface AssistantTool {
  name: string;
  description: string;
  /** 发给模型（与 MCP tools/list）的参数 Schema */
  inputSchema: object;
  /** invokeTool 的入参校验用这份（没有时用 inputSchema）：validate_plan 只查 plan 是对象，结构错误交给 validatePlan 逐条列出 */
  inputCheck?: object;
  outputSchema: object;
  permission: Permission;
  /** 是否允许外部（MCP）调用 */
  external: boolean;
  /** 除权限外另要的令牌授权：allowQuery 是签发令牌时勾选的「允许执行查询」 */
  requires?: keyof ToolGrants;
  /** input 已按 inputCheck ?? inputSchema 校验过；返回给模型的文本，不通过时带上问题清单；ctx 是本轮对话的上下文（检索到的候选），目录检索类工具用它 */
  run(actor: CurrentMember, input: Record<string, unknown>, ctx?: ToolCtx): Promise<string | ToolResult>;
}

/** 工具的结果：rejected 表示校验或保存没有通过，issues 是问题清单的文本、yaml 是被拒的那一版；saved 表示保存了一份草稿；
 * validated 是 validate_definition 通过的那一版（助手循环放弃时交给成员，#1185；MCP 只用 text） */
export interface ToolResult { text: string; rejected?: { issues: string; yaml: string }; saved?: true; validated?: { kind: string; yaml: string } }

/** 本租户的目录，按成员角色过滤（visibleCatalog）：没有 sources:read 时去掉数据源与源表条目，字段不带来源、实体不列映射到它的源表与合并组 */
export const catalogFor = async (member: CurrentMember): Promise<Catalog> =>
  visibleCatalog(await tenantCatalog(member.tenant.id), visibilityClass(member.role));

/** 成员自己的目录（catalog，同 catalogFor）与另一类可见性的目录（other）：计划卡用 other 判断「读者看到的目录变了」（#1190），other 的内容不给读者 */
export const catalogPairFor = async (member: CurrentMember): Promise<{ catalog: Catalog; other: Catalog }> => {
  const full = await tenantCatalog(member.tenant.id);
  const cls = visibilityClass(member.role);
  return { catalog: visibleCatalog(full, cls), other: visibleCatalog(full, cls === 'full' ? 'restricted' : 'full') };
};

/** 一次助手对话轮的上下文：retrieved 是本轮 catalog_search / catalog_expand 返回过的条目 id，助手循环一开始预先填入对话里最近一份计划引用过的条目（#1179），validate_plan 只认这些（防止模型引用没检索过的条目）；
 * plan 是本轮 validate_plan 收到的最后一份结构合法的计划，priorPlan 是对话里最近一份（助手循环带入）；存草稿与填工作台前都优先用 plan、其次 priorPlan 重新校验；
 * workbenchSql 是本轮 prefill_workbench 通过校验的 SQL（多次通过以最后一次为准，之后的拒绝不清掉之前通过的值）；
 * choices 是本轮最后一次 catalog_search 判为歧义的追问候选（⑥-3，只有词与候选条目 id）或未命中说法的候选组（⑥-5，kind: 'missing'）：随答复返回、由路由加密存进对话，不进发给模型的请求 */
export interface ToolCtx { retrieved: Set<string>; plan?: AnalysisPlan; priorPlan?: AnalysisPlan; workbenchSql?: string; choices?: ChoiceGroup[] }

const TEXT = { type: 'string' };

const LANE_NAMES: Record<HitReason['lane'], string> = { id: '标识', alias: '别名', name: '名称', keyword: '关键词', vector: '语义', expand: '依赖展开' };

/** 条目的 Markdown 加一行语义哈希：模型把哈希带进计划，validatePlan 用它发现条目内容变了（哈希在成员自己那份按角色裁剪的目录上算）。
 *  restricted 目录里被清掉的来源写「按你的角色不显示」：只改渲染，不往条目上加标记，哈希与投影都不变（#1188） */
const withHash = (e: CatalogEntry, restricted: boolean) => `${toMarkdown(e, { restricted })}\nsemanticHash: ${semanticHash(e)}`;

/** 命中理由一行：「命中：别名「GMV」；关键词「营收」、「30天」」，补召回的是「依赖展开「entity:order 的时间字段」」 */
const hitLine = (reasons: HitReason[]) =>
  `命中：${reasons.map(r => LANE_NAMES[r.lane] + r.matched.map(m => `「${m}」`).join('、')).join('；')}`;

/** 一个歧义组的口径对比段：标题、维度 × 候选的表（只列不同的维度）、每句追问一行 */
const comparison = (g: AmbiguityGroup) => [
  `## 口径对比：${g.term}`,
  `| 维度 | ${g.candidates.join(' | ')} |`,
  `|${' --- |'.repeat(g.candidates.length + 1)}`,
  ...g.diffs.map(d => `| ${d.label} | ${g.candidates.map(id => d.values[id] ?? '').join(' | ')} |`),
  ...g.questions.map(q => `追问：${q}`),
].join('\n');

/** 未命中说法的候选组（⑥-5）：投影没回退（回退时理由全空，判不了）、没有任何标识 / 别名 / 名称命中（词命中名称或别名就不算未命中）、
 * 词 1–20 字且不含空白（整句话不记，免得把问句变成以后的别名提案）时，取排名顺序里前 5 个 metric / tag / entity / field 条目当候选；
 * 任一条件不满足时 undefined（歧义优先，见 catalog_search） */
function missingGroup(ranked: Ranked[], fallback: boolean, q: string): ChoiceGroup[] | undefined {
  const term = q.trim();
  if (fallback || !term || [...term].length > 20 || /\s/.test(term)) return undefined;
  if (ranked.some(r => r.reasons.some(({ lane }) => lane === 'id' || lane === 'alias' || lane === 'name'))) return undefined;
  const candidates = ranked.filter(r => /^(metric|tag|entity|field):/.test(r.entry.id)).slice(0, 5).map(r => r.entry.id);
  return candidates.length ? [{ term, kind: 'missing', candidates }] : undefined;
}

const issueLines = (issues: DslIssue[]) =>
  issues.map(i => `- ${i.path || '（文档）'}（第 ${i.line} 行第 ${i.col} 列）：${i.message}`).join('\n');

/** 计划一条问题的引用：path（entryId） */
const planIssueRef = (i: PlanIssue) => `${i.path}${i.entryId ? `（${i.entryId}）` : ''}`;

/** 计划的一条问题：- path（entryId）：message；下一步：next（validate_plan 的输出与存草稿前重新校验共用） */
const planIssueLine = (i: PlanIssue) => `- ${planIssueRef(i)}：${i.message}${i.next ? `；下一步：${i.next}` : ''}`;

const isDependencyIssue = (i: PlanIssue) => i.path.endsWith('.version') || i.path.endsWith('.semanticHash');
const isHiddenIssue = (i: PlanIssue) => i.kind === 'hidden';

/** 依赖变了的一条问题：validate_plan 与存草稿 / 填工作台前的重新校验共用，带上重新检索的提示（#1179：沿用对话里的计划、条目已升版时模型据此重新检索） */
const dependencyLine = (i: PlanIssue) => `- ${planIssueRef(i)}：依赖变了（版本或语义哈希与当前目录不一致，要重新检索、换上当前的 version 与 semanticHash）——${i.message}`;

/** validate_plan 的问题清单：依赖变了的那几条按 dependencyLine 写 */
const planIssueLines = (issues: PlanIssue[]) => issues.map(i => (isDependencyIssue(i) ? dependencyLine(i) : planIssueLine(i))).join('\n');

/** 重新校验没通过时的两种动作：存草稿与把 SQL 填进工作台，文案只差「保存 / 填入」那几个词（save 的逐字文案有历史用例断言） */
type StaleAction = 'save' | 'prefill';

/** 计划本身不是 valid 时的下一步（非 valid 一律不保存 / 不填入，见 #422 的 sandcastle:decided） */
const STATUS_NEXT: Record<StaleAction, Record<Exclude<PlanStatus, 'valid'>, string>> = {
  save: {
    needs_clarification: '要先向用户澄清，澄清后重新检索并校验计划，valid 了再保存',
    unsupported: '要向用户说明做不到，不能存草稿',
    invalid: '先修正计划并重新校验，valid 了再保存',
  },
  prefill: {
    needs_clarification: '要先向用户澄清，澄清后重新检索并校验计划，valid 了再填入',
    unsupported: '要向用户说明做不到，不能填入工作台',
    invalid: '先修正计划并重新校验，valid 了再填入',
  },
};

/** stalePlanReply 里随动作换的三个词：开头（未保存 / 未填入）、校验时机（存草稿前 / 填入工作台前）、结尾（再保存 / 再填入） */
const STALE_WORDS: Record<StaleAction, { failed: string; before: string; again: string }> = {
  save: { failed: '未保存', before: '存草稿前', again: '再保存' },
  prefill: { failed: '未填入', before: '填入工作台前', again: '再填入' },
};

/**
 * 重新校验没有通过：不保存 / 不填入，说明原因（不带 rejected，不计修正次数）。有依赖变了 / 看不到所选条目的问题时
 * 说计划已过期并提示重新检索；没有这两类问题时是计划本身就不是 valid（比如 clarify / unsupported 模式），写明计划状态，不说过期
 */
function stalePlanReply(status: Exclude<PlanStatus, 'valid'>, plan: AnalysisPlan, issues: PlanIssue[], action: StaleAction = 'save'): string {
  const words = STALE_WORDS[action];
  if (!issues.some(i => isDependencyIssue(i) || isHiddenIssue(i))) {
    return [`${words.failed}：计划状态是 ${status}（mode 是 ${plan.mode}），${STATUS_NEXT[action][status]}。`, ...issues.map(planIssueLine)].join('\n');
  }
  const lines = issues.map(i => {
    if (isDependencyIssue(i)) return dependencyLine(i);
    if (isHiddenIssue(i)) return `- ${planIssueRef(i)}：看不到所选条目（权限变了，或条目已停用 / 删除）`;
    return planIssueLine(i);
  });
  return [`${words.failed}：计划已过期，${words.before}用当前目录重新校验没有通过。`, ...lines, `请重新检索并校验计划后${words.again}`].join('\n');
}

/** 不通过：给模型的文本与交给成员的问题清单 */
function rejected(text: string, issues: string, yaml: string): ToolResult {
  return { text, rejected: { issues, yaml } };
}

/** 保存草稿；被拒（DslError / MappingError 400）转成不通过的结果，其余错误照常抛出（回填给模型「工具出错」，不算一次修正） */
async function savedOrRejected(yaml: string, save: () => Promise<string>): Promise<ToolResult> {
  try {
    return { text: await save(), saved: true };
  } catch (e) {
    if (!(e instanceof DslError || e instanceof MappingError) || e.status !== 400) throw e;
    const issues = [e.message, issueLines(e.issues)].filter(Boolean).join('\n');
    return rejected(`未保存：${issues}`, issues, yaml);
  }
}

const PUBLISH_HINT = '需由另一位有发布权限的成员发布';

/** 一种 DSL 的顶层键与必填键，取自校验用的 Schema（ADR-0041：不另写清单） */
const dslKeys = (schema: { properties: object; required: readonly string[] }) =>
  `${Object.keys(schema.properties).join('、')}（必填 ${schema.required.join('、')}；没有别的顶层键）`;

/** 定义工具说明里的 DSL 提示（#1185）：顶层键，以及口径声明、别名不写进 YAML */
const DSL_KEYS_HINT = `。指标 DSL 顶层键：${dslKeys(METRIC_SCHEMA)}；标签 DSL 顶层键：${dslKeys(TAG_SCHEMA)}。写法见 capability:metric-dsl / capability:tag-dsl。口径声明（含税 / 扣退款 / 币种等）与别名不在 YAML 里，定义发布后在定义页的业务知识面板设置`;

/** 映射草稿的表：取 YAML 里的 table，解析不了时为 undefined（之后的保存会报出问题） */
function mappingTable(yaml: string): unknown {
  try { return (parse(yaml) as { table?: unknown } | null)?.table; } catch { return undefined; }
}

/** prefill_workbench 接受的 SQL 上限：工作台路由 ?sql= 超过这个字数会被忽略（app/routes/workbench.tsx 的 MAX_SQL_PARAM 同值，不从路由文件导入） */
const MAX_PREFILL_SQL = 20_000;

/** 发给模型前从参数 Schema 里剥掉的关键字：条件与组合（服务商不一定接受）及引用 / 元信息；这些跨字段规则仍由 Ajv 用完整 Schema 校验 */
const MODEL_DROPPED_KEYS = new Set(['if', 'then', 'else', 'not', 'allOf', '$id', '$schema', '$ref']);

/** Schema 的深拷贝，递归去掉 MODEL_DROPPED_KEYS；不改原 Schema */
function forModel(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forModel);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !MODEL_DROPPED_KEYS.has(k)).map(([k, v]) => [k, forModel(v)]));
}

/** validate_plan 说明末尾附的最小合法 draft_query 计划（#1178）：fetch 的 inputs 引用 selected 的 id，aggregate 带 agg、inputs 恰好一个前面的步骤 */
export const PLAN_EXAMPLE: AnalysisPlan = {
  schemaVersion: 1,
  mode: 'draft_query',
  selected: [{ id: 'metric:order_count', version: 1, semanticHash: '<从 catalog_search 或 catalog_expand 的输出里抄>' }],
  request: { dimensions: ['consumer.city'] },
  steps: [{ id: 's1', action: 'fetch', inputs: ['metric:order_count'] }, { id: 's2', action: 'aggregate', agg: 'count', inputs: ['s1'] }],
  assumptions: [{ text: '按下单时间统计', confirmed: false }],
  questions: [],
};

export const TOOLS: AssistantTool[] = [
  {
    name: 'catalog_overview',
    description: '语义目录总览（第一层分组）：分析主题、实体各一组一行（带指标 / 标签 / 字段数量），数据源、关系、模板各一行汇总。'
      + '先看分组，再用 catalog_expand 按分组展开（group:… 标识）或用 catalog_search 搜索',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: true,
    run: async actor => toMarkdown(groupOverview(await catalogFor(actor))),
  },
  {
    name: 'catalog_expand',
    description: '按标识展开一个目录条目（如 entity:customer、field:customer.city、metric:paid_revenue_30d），或展开一个分组：'
      + 'group:subject:<主题名>、group:entity:<实体名>、group:sources、group:relationships、group:templates、group:other、合并组 group:entities@<k>'
      + '（组内放不下时分页，在标识后加 @<页>，如 group:entity:order@2）。先看 catalog_overview 的分组，再按分组展开或搜索',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: true,
    run: async (actor, { id }, ctx) => {
      const c = await catalogFor(actor);
      const key = id as string;
      // 分组（第一层 group: 标识）走第二层：组内条目每行带语义哈希，同样记进本轮检索到的候选集合
      if (key.startsWith('group:')) {
        const group = groupItems(c, key, semanticHash);
        if (!group) return '没有这个条目';
        for (const entryId of group.entries) ctx?.retrieved.add(entryId);
        return toMarkdown(group);
      }
      const entry = expand(c, key);
      if (!entry) return '没有这个条目';
      ctx?.retrieved.add(entry.id);
      return withHash(entry, visibilityClass(actor.role) === 'restricted');
    },
  },
  {
    name: 'catalog_search',
    description: '按关键词、别名与名称搜索目录条目，返回展开后的条目、命中理由与歧义判定；ambiguous 为 true 时，先用给出的追问问清楚口径，再继续；'
      + '输出里有「默认口径：」行时，回答里要写明按哪个默认口径理解了哪个词；'
      + '输出里有「vector_fallback:」行时，表示向量一路没用上（结果只来自关键词），其中 not_ready 表示向量还没补算好，结果只来自关键词',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: true,
    run: async (actor, { query, limit }, ctx) => {
      // 在检索投影上排序（ADR-0047），排序与歧义判定用同一份可见目录，作用域是查询里点名的本租户空间与成员所属空间；投影不可用时回退到实时目录搜索、不带命中理由；
      // 租户开了 hybrid_search（运营切换，默认关）时加向量一路（ADR-0049）
      const q = query as string;
      const spaceIds = (await getDb().select({ id: spaces.id, name: spaces.name }).from(spaces).where(eq(spaces.tenantId, actor.tenant.id)))
        .filter(s => q.includes(s.name)).map(s => s.id);
      const c = await catalogFor(actor);
      const [tenant] = await getDb().select({ hybridSearch: tenants.hybridSearch }).from(tenants).where(eq(tenants.id, actor.tenant.id));
      const visibility = visibilityClass(actor.role);
      const { ranked, fallback, vectorFallback } = await rankedSearch(actor.tenant.id, visibility, c, q,
        { spaceIds, memberSpaceId: actor.space.id }, limit as number | undefined, { hybrid: tenant?.hybridSearch ?? false });
      // 排到的条目都算本轮检索到（含投影不可用回退的那部分），每个都带语义哈希
      for (const r of ranked) ctx?.retrieved.add(r.entry.id);
      // 回退时得分全为 0，照样判定（一律按差异追问）
      const { ambiguous, groups, defaults } = judgeAmbiguity(ranked, c, q);
      // 歧义候选留在轮上下文里（⑥-3）：随本轮答复返回并加密存进对话，供前端点选、/assistant 的 choice 入参核对；同一轮再搜且不歧义时清空，只认最后一次。
      // 不歧义但词未命中（没有任何标识 / 别名 / 名称命中）时改留未命中候选组（⑥-5），同样是最后一次搜索说了算
      if (ctx) ctx.choices = ambiguous ? groups.map(g => ({ term: g.term, candidates: g.candidates })) : missingGroup(ranked, fallback, q);
      const restricted = visibility === 'restricted';
      const entries = ranked.length
        ? ranked.map(r => r.reasons.length ? `${withHash(r.entry, restricted)}\n${hitLine(r.reasons)}` : withHash(r.entry, restricted)).join('\n\n')
        : toMarkdown([]);
      // 词的默认指向（ADR-0056）：没追问、按默认条目处理的组，每项一行（指标的名称就是键），让助手在回答里转述这一句
      const defaultLines = defaults.map(({ term, entryId }) =>
        `默认口径：按默认口径 ${c.entries.find(e => e.id === entryId)?.name}（${entryId}）理解『${term}』；用户要别的口径时请换一种说法再问`);
      // 向量一路没用上时（开了混合检索但 embedding 失败或外部库连不上）紧跟 ambiguous 报原因，结果只来自关键词
      return [`ambiguous: ${ambiguous}`, ...(vectorFallback ? [`vector_fallback: ${vectorFallback}`] : []), entries, ...defaultLines, ...(ambiguous ? groups.map(comparison) : [])].join('\n\n');
    },
  },
  {
    name: 'validate_plan',
    description: '校验一份分析计划（JSON）：结构、步骤与选中的目录条目、口径可加性与平台能力。计划只能引用本轮 catalog_search / catalog_expand 返回过的条目或对话里最近一份计划引用过的条目，'
      + '并带上返回的 semanticHash（指标、标签、模板还要带 version）；可选的 excluded 列出检索到但没选的口径（id 也必须来自本轮检索或对话里最近一份计划）和原因，'
      + '可选的 rationale 说明为何选；原因里不要写目录以外的名称。返回 status（valid / needs_clarification / unsupported / invalid）与逐条问题。'
      + `最小合法示例（draft_query）：${JSON.stringify(PLAN_EXAMPLE)}`,
    // 发给模型的是计划的完整结构（#1178），入参只查 plan 是对象：结构错误由 validatePlan 以 status: invalid 与逐条问题返回，不在 invokeTool 处 400
    inputSchema: { type: 'object', required: ['plan'], properties: { plan: forModel(PLAN_SCHEMA) }, additionalProperties: false },
    inputCheck: { type: 'object', required: ['plan'], properties: { plan: { type: 'object' } }, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: false,
    run: async (actor, { plan }, ctx) => {
      const check = validatePlan(plan, { catalog: await catalogFor(actor), retrieved: ctx?.retrieved ?? new Set() });
      // 本轮收到的最后一份结构合法的计划（status 不是 valid 也算）带走：随对话保存，存草稿前重新校验用（ADR-0050）
      if (check.plan && ctx) ctx.plan = check.plan;
      const issues = planIssueLines(check.issues);
      return [`status: ${check.status}`, ...(issues ? [issues] : [])].join('\n');
    },
  },
  {
    name: 'validate_definition',
    description: `校验一份指标或标签定义（YAML），不保存：通过时回复「校验通过」，否则逐条列出问题${DSL_KEYS_HINT}`,
    inputSchema: {
      type: 'object', required: ['kind', 'yaml'],
      properties: { kind: { enum: ['metric', 'tag'] }, yaml: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'definitions:draft',
    external: true,
    run: async (actor, { kind, yaml }) => {
      const result = await validateDefinition(actor, kind as string, yaml as string);
      if (result.ok) return { text: '校验通过', validated: { kind: kind as string, yaml: yaml as string } };
      const issues = issueLines(result.issues);
      return rejected(`有 ${result.issues.length} 个问题：\n${issues}`, issues, yaml as string);
    },
  },
  {
    name: 'validate_mapping',
    description: '校验一份新映射（YAML），不保存：source 是数据源的登记名。通过时回复「校验通过」（附带提示），否则列出问题',
    inputSchema: {
      type: 'object', required: ['source', 'yaml'],
      properties: { source: { type: 'string' }, yaml: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'sources:write',
    external: true,
    run: async (actor, { source, yaml }) => {
      const sourceId = await sourceIdByName(actor.tenant.id, source as string);
      if (!sourceId) return `没有叫「${source}」的数据源`;
      const v = await validateNewMapping(actor, sourceId, yaml as string);
      const notices = v.notices.length ? `\n提示：\n${issueLines(v.notices)}` : '';
      if (v.ok) return `校验通过${notices}`;
      const issues = [v.error, v.issues.length ? issueLines(v.issues) : ''].filter(Boolean).join('\n');
      return rejected(issues, issues, yaml as string);
    },
  },
  {
    name: 'save_definition_draft',
    description: `把校验通过的指标或标签定义（YAML）保存为草稿，作者是当前成员；定义已存在时改它的草稿。key 只用小写字母、数字与下划线，以小写字母开头。保存后${PUBLISH_HINT}${DSL_KEYS_HINT}`,
    inputSchema: {
      type: 'object', required: ['kind', 'key', 'yaml'],
      properties: { kind: { enum: ['metric', 'tag'] }, key: { type: 'string' }, yaml: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'definitions:draft',
    external: true,
    run: async (actor, input, ctx) => {
      const { kind, key, yaml } = input as { kind: 'metric' | 'tag'; key: string; yaml: string };
      // 存草稿前用当前目录重新校验（ADR-0050）：优先本轮刚校验过的计划，其次对话里最近一份。selected 与 excluded 的条目都当作
      // 检索过（planRetrievedIds），这样拦下来的只有依赖变了（版本或哈希不一致）与看不到所选条目，不会报「不在本次检索结果里」。
      // 没有计划（外部经 MCP 或本轮和对话里都没有）时不校验，与原来一致
      const plan = ctx?.plan ?? ctx?.priorPlan;
      if (plan) {
        const check = validatePlan(plan, { catalog: await catalogFor(actor), retrieved: planRetrievedIds(plan) });
        if (check.status !== 'valid') return stalePlanReply(check.status, plan, check.issues);
      }
      return savedOrRejected(yaml, async () => {
        // createDefinition 键重复时拒绝：已存在的定义改草稿。查与存之间别人新建了同键定义时 createDefinition 报键重复（不通过），模型重试即走改草稿
        const [existing] = await getDb().select({ id: dslDefinitions.id }).from(dslDefinitions)
          .where(and(eq(dslDefinitions.tenantId, actor.tenant.id), eq(dslDefinitions.kind, kind), eq(dslDefinitions.key, key)));
        const version = existing ? await saveDslDraft(actor, kind, key, yaml) : (await createDefinition(actor, kind, key, yaml)).version;
        return `已保存为草稿：${kind}/${key} 第 ${version} 版，${PUBLISH_HINT}`;
      });
    },
  },
  {
    name: 'save_mapping_draft',
    description: `把校验通过的映射（YAML）保存为草稿，作者是当前成员：source 是数据源的登记名，entity 是映射到的实体；这个数据源的这张表到这个实体已有映射时在它上面存草稿，否则新建。保存后${PUBLISH_HINT}`,
    inputSchema: {
      type: 'object', required: ['source', 'entity', 'yaml'],
      properties: { source: { type: 'string' }, entity: { type: 'string' }, yaml: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'sources:write',
    external: true,
    run: async (actor, input) => {
      const { source, entity, yaml } = input as { source: string; entity: string; yaml: string };
      const sourceId = await sourceIdByName(actor.tenant.id, source);
      if (!sourceId) return `没有叫「${source}」的数据源`;
      return savedOrRejected(yaml, async () => {
        // 查与存之间别人建了同一映射时 createMapping 报重复（不通过），模型重试即走改草稿
        const table = mappingTable(yaml);
        const [existing] = typeof table === 'string'
          ? await getDb().select().from(mappings)
            .where(and(eq(mappings.sourceId, sourceId), eq(mappings.tableName, table), eq(mappings.entity, entity)))
          : [];
        if (existing) {
          const { version } = await saveMappingDraft(actor, existing.id, yaml);
          return `已保存为草稿：${source} 的 ${existing.tableName} → ${existing.entity} 第 ${version} 版，${PUBLISH_HINT}`;
        }
        const created = await createMapping(actor, sourceId, yaml);
        return `已保存为草稿：${source} 的 ${created.tableName} → ${created.entity} 第 1 版，${PUBLISH_HINT}`;
      });
    },
  },
  {
    name: 'run_query',
    description: `按数据查询工作台的规则执行一条只读 SQL（只能读 silver、gold 与自己能读的沙箱表），最多返回 ${WORKBENCH_ROWS} 行。`
      + `返回 JSON { columns, rows, truncated, dropped }：系统列、名字像敏感字段的列与取值含哈希的列被剔除，列名在 dropped 里；每格最多 ${MAX_CELL} 字`,
    inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } }, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'sandbox',
    external: true,
    requires: 'allowQuery',
    run: async (actor, { sql }) => {
      // runQuery 自己记 workbench.query（actor 带着 via）；出错时抛 WorkbenchError，由调用方转成工具错误。全部行都交出去，哈希按全部行判断
      const result = await runQuery(actor, sql as string);
      const { columns, rows, dropped } = redactResult(result, Infinity);
      return JSON.stringify({ columns: columns.map(c => c.name), rows, truncated: result.truncated, dropped });
    },
  },
  {
    name: 'prefill_workbench',
    description: '把按 draft_query 计划写好的一条只读 SQL 准备填进数据查询工作台：先用当前目录重新校验计划，再按工作台白名单检查 SQL（不执行）。'
      + '通过后成员在工作台点链接把 SQL 放进编辑器，由成员自己执行',
    inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' } }, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'sandbox',
    external: false,
    run: async (actor, { sql }, ctx) => {
      // 与存草稿不同：没有计划（外部经 MCP 或本轮和对话里都没有）时拒绝，不放过未校验的 SQL
      const plan = ctx?.plan ?? ctx?.priorPlan;
      if (!plan) return '未填入：本轮和对话里都没有校验过的分析计划，先检索并用 validate_plan 校验一份 draft_query 计划';
      if (plan.mode !== 'draft_query') return `未填入：计划的 mode 是 ${plan.mode}，只有 draft_query 的计划能填入工作台`;
      // 填入前对当前目录重新校验（ADR-0050）：selected 与 excluded 都当作检索过（planRetrievedIds），拦下来的是依赖变了、看不到所选条目，以及口径不合 / 需追问（#1184）
      const check = validatePlan(plan, { catalog: await catalogFor(actor), retrieved: planRetrievedIds(plan) });
      if (check.status !== 'valid') return stalePlanReply(check.status, plan, check.issues, 'prefill');
      if ((sql as string).length > MAX_PREFILL_SQL) return `未填入：SQL 超过 ${MAX_PREFILL_SQL} 字，工作台的链接放不下，请精简后重试`;
      // 只按工作台白名单检查、不执行（ADR-0043）；挂载出错时抛 WorkbenchError，由助手循环转成工具错误
      const { sql: normalized, problem } = await checkDraftedSql(actor, sql as string);
      if (problem) return `未填入：SQL 没有通过工作台校验：${problem}`;
      // SQL 只进 ctx 与返回值，不写进 tool 文本；拒绝不清掉之前通过的值，多次通过以最后一次为准
      if (ctx) ctx.workbenchSql = normalized;
      return '已准备好填入工作台：成员点链接把 SQL 放进编辑器，自己执行';
    },
  },
];

/** 调用方带着的授权：allowQuery 来自令牌的「允许执行查询」 */
export interface ToolGrants { allowQuery?: boolean }

const hasGrant = (tool: AssistantTool, tokenGrants: ToolGrants) => !tool.requires || !!tokenGrants[tool.requires];

/** 平台内助手可以用的工具：有登记的权限，不另要授权 */
export const toolsFor = (member: CurrentMember): AssistantTool[] => TOOLS.filter(t => !t.requires && can(member.role, t.permission));

/** 经 MCP 可以用的工具：external、有登记的权限，另要的授权令牌上有 */
export const externalToolsFor = (member: CurrentMember, tokenGrants: ToolGrants): AssistantTool[] =>
  TOOLS.filter(t => t.external && hasGrant(t, tokenGrants) && can(member.role, t.permission));

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>(TOOLS.map(t => [t.name, ajv.compile(t.inputCheck ?? t.inputSchema)]));

const badRequest = (message: string) => data({ message }, { status: 400 });

/** 按名字调用工具：没有这个工具或输入不合 Schema 时 400，成员没有登记的权限或调用方没有另要的授权时 403；ctx 是本轮对话的上下文，透传给工具 */
export async function invokeTool(actor: CurrentMember, name: string, input: unknown, tokenGrants: ToolGrants = {}, ctx?: ToolCtx): Promise<ToolResult> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw badRequest(`没有工具 ${name}`);
  if (!hasGrant(tool, tokenGrants)) throw data({ message: '没有执行查询的授权：签发令牌时须勾选「允许执行查询」' }, { status: 403 });
  assertCan(actor, tool.permission);
  const validate = validators.get(name)!;
  if (!validate(input)) throw badRequest(`工具 ${name} 的输入不对：${ajv.errorsText(validate.errors, { dataVar: 'input' })}`);
  const result = await tool.run(actor, input as Record<string, unknown>, ctx);
  return typeof result === 'string' ? { text: result } : result;
}

/** 同 invokeTool，只返回给模型的文本 */
export const runTool = async (actor: CurrentMember, name: string, input: unknown): Promise<string> => (await invokeTool(actor, name, input)).text;
