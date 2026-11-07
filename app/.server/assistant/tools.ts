// app/.server/assistant/tools.ts —— AI 助手的工具注册表（ADR-0042）：每个工具登记名称、输入输出 JSON Schema、所需权限与是否允许外部调用
// （/mcp 的工具从这张表里 external 的那部分生成，外部能用的始终是内部的子集）。成员只看得到自己有权限的工具，调用时再按登记的权限检查一次：成员没有的权限助手也用不了。
// 工具返回给模型的是文本；校验或保存不通过时另带上问题清单与那一版 YAML（rejected），助手循环据此计数、超过修正次数时交给成员（ADR-0043）。
// 保存类工具只存草稿，发布照旧双人；注册表里没有发布工具。执行查询的 run_query 另要令牌的授权（requires: 'allowQuery'）：只有签发时允许执行查询的令牌经 MCP 拿得到，
// 平台内的助手拿不到（toolsFor 不含、invokeTool 不带授权时 403）；结果按工作台解读的规则剔除列，但对全部返回行判断哈希（ADR-0043）。目录按角色过滤（catalogFor）：没有 sources:read 的成员看不到数据源与源表条目、字段来源与实体映射到的源表（ADR-0005）。
// 分析计划（ADR-0050）：目录检索工具的输出给每个条目带语义哈希（同一份按角色裁剪的目录上算），并把条目 id 记进 ToolCtx.retrieved（助手循环每轮新建）；
// validate_plan 只认本轮检索到的条目，校验结果渲染成文本、不带 rejected（不计修正次数）；它不对外开放（external: false），外部没有这个上下文
import { Ajv, type ValidateFunction } from 'ajv';
import { and, eq } from 'drizzle-orm';
import { data } from 'react-router';
import { parse } from 'yaml';
import { assertCan, can, type Permission } from '../access';
import type { CurrentMember } from '../auth';
import { expand, overview, toMarkdown, type Catalog, type CatalogEntry } from '../catalog';
import { judgeAmbiguity, type AmbiguityGroup } from '../catalog/ambiguity';
import { tenantCatalog } from '../catalog/load';
import { semanticHash, validatePlan } from '../catalog/plan';
import { rankedSearch, visibilityClass, visibleCatalog } from '../catalog/projection';
import type { HitReason } from '../catalog/rank';
import { getDb } from '../db/client';
import { dslDefinitions, mappings, spaces } from '../db/schema';
import { createDefinition, DslError, saveDslDraft, validateDefinition } from '../dsl-definitions';
import type { DslIssue } from '../pipeline/dsl/metric-spec';
import { createMapping, MappingError, saveMappingDraft, validateNewMapping } from '../mappings';
import { sourceIdByName } from '../source-config';
import { runQuery, WORKBENCH_ROWS } from '../workbench';
import { MAX_CELL, redactResult } from '../workbench-ai';

export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  permission: Permission;
  /** 是否允许外部（MCP）调用 */
  external: boolean;
  /** 除权限外另要的令牌授权：allowQuery 是签发令牌时勾选的「允许执行查询」 */
  requires?: keyof ToolGrants;
  /** input 已按 inputSchema 校验过；返回给模型的文本，不通过时带上问题清单；ctx 是本轮对话的上下文（检索到的候选），目录检索类工具用它 */
  run(actor: CurrentMember, input: Record<string, unknown>, ctx?: ToolCtx): Promise<string | ToolResult>;
}

/** 工具的结果：rejected 表示校验或保存没有通过，issues 是问题清单的文本、yaml 是被拒的那一版；saved 表示保存了一份草稿 */
export interface ToolResult { text: string; rejected?: { issues: string; yaml: string }; saved?: true }

/** 本租户的目录，按成员角色过滤（visibleCatalog）：没有 sources:read 时去掉数据源与源表条目，字段不带来源、实体不列映射到它的源表与合并组 */
export const catalogFor = async (member: CurrentMember): Promise<Catalog> =>
  visibleCatalog(await tenantCatalog(member.tenant.id), visibilityClass(member.role));

/** 一次助手对话轮的上下文：retrieved 是本轮 catalog_search / catalog_expand 返回过的条目 id，validate_plan 只认这些（防止模型引用没检索过的条目） */
export interface ToolCtx { retrieved: Set<string> }

const TEXT = { type: 'string' };

const LANE_NAMES: Record<HitReason['lane'], string> = { id: '标识', alias: '别名', name: '名称', keyword: '关键词', expand: '依赖展开' };

/** 条目的 Markdown 加一行语义哈希：模型把哈希带进计划，validatePlan 用它发现条目内容变了（哈希在成员自己那份按角色裁剪的目录上算） */
const withHash = (e: CatalogEntry) => `${toMarkdown(e)}\nsemanticHash: ${semanticHash(e)}`;

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

const issueLines = (issues: DslIssue[]) =>
  issues.map(i => `- ${i.path || '（文档）'}（第 ${i.line} 行第 ${i.col} 列）：${i.message}`).join('\n');

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

/** 映射草稿的表：取 YAML 里的 table，解析不了时为 undefined（之后的保存会报出问题） */
function mappingTable(yaml: string): unknown {
  try { return (parse(yaml) as { table?: unknown } | null)?.table; } catch { return undefined; }
}

export const TOOLS: AssistantTool[] = [
  {
    name: 'catalog_overview',
    description: '语义目录总览：实体、关系、指标、标签与模板各一行。先看总览，再按标识展开或按关键词搜索',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: true,
    run: async actor => toMarkdown(overview(await catalogFor(actor))),
  },
  {
    name: 'catalog_expand',
    description: '按标识展开一个目录条目，如 entity:customer、field:customer.city、metric:paid_revenue_30d',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: true,
    run: async (actor, { id }, ctx) => {
      const entry = expand(await catalogFor(actor), id as string);
      if (!entry) return '没有这个条目';
      ctx?.retrieved.add(entry.id);
      return withHash(entry);
    },
  },
  {
    name: 'catalog_search',
    description: '按关键词、别名与名称搜索目录条目，返回展开后的条目、命中理由与歧义判定；ambiguous 为 true 时，先用给出的追问问清楚口径，再继续',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: true,
    run: async (actor, { query, limit }, ctx) => {
      // 在检索投影上排序（ADR-0047），排序与歧义判定用同一份可见目录，作用域是查询里点名的本租户空间与成员所属空间；投影不可用时回退到实时目录搜索、不带命中理由
      const q = query as string;
      const spaceIds = (await getDb().select({ id: spaces.id, name: spaces.name }).from(spaces).where(eq(spaces.tenantId, actor.tenant.id)))
        .filter(s => q.includes(s.name)).map(s => s.id);
      const c = await catalogFor(actor);
      const { ranked } = await rankedSearch(actor.tenant.id, visibilityClass(actor.role), c, q,
        { spaceIds, memberSpaceId: actor.space.id }, limit as number | undefined);
      // 排到的条目都算本轮检索到（含投影不可用回退的那部分），每个都带语义哈希
      for (const r of ranked) ctx?.retrieved.add(r.entry.id);
      // 回退时得分全为 0，照样判定（一律按差异追问）
      const { ambiguous, groups } = judgeAmbiguity(ranked, c, q);
      const entries = ranked.length
        ? ranked.map(r => r.reasons.length ? `${withHash(r.entry)}\n${hitLine(r.reasons)}` : withHash(r.entry)).join('\n\n')
        : toMarkdown([]);
      return [`ambiguous: ${ambiguous}`, entries, ...(ambiguous ? groups.map(comparison) : [])].join('\n\n');
    },
  },
  {
    name: 'validate_plan',
    description: '校验一份分析计划（JSON）：结构、步骤与选中的目录条目、口径可加性与平台能力。计划只能引用本轮 catalog_search / catalog_expand 返回过的条目，'
      + '并带上返回的 semanticHash（指标、标签、模板还要带 version）；返回 status（valid / needs_clarification / unsupported / invalid）与逐条问题',
    inputSchema: { type: 'object', required: ['plan'], properties: { plan: { type: 'object' } }, additionalProperties: false },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: false,
    run: async (actor, { plan }, ctx) => {
      const check = validatePlan(plan, { catalog: await catalogFor(actor), retrieved: ctx?.retrieved ?? new Set() });
      const issues = check.issues.map(i => `- ${i.path}${i.entryId ? `（${i.entryId}）` : ''}：${i.message}${i.next ? `；下一步：${i.next}` : ''}`);
      return [`status: ${check.status}`, ...issues].join('\n');
    },
  },
  {
    name: 'validate_definition',
    description: '校验一份指标或标签定义（YAML），不保存：通过时回复「校验通过」，否则逐条列出问题',
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
      if (result.ok) return '校验通过';
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
    description: `把校验通过的指标或标签定义（YAML）保存为草稿，作者是当前成员；定义已存在时改它的草稿。key 只用小写字母、数字与下划线，以小写字母开头。保存后${PUBLISH_HINT}`,
    inputSchema: {
      type: 'object', required: ['kind', 'key', 'yaml'],
      properties: { kind: { enum: ['metric', 'tag'] }, key: { type: 'string' }, yaml: { type: 'string' } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'definitions:draft',
    external: true,
    run: async (actor, input) => {
      const { kind, key, yaml } = input as { kind: 'metric' | 'tag'; key: string; yaml: string };
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
const validators = new Map<string, ValidateFunction>(TOOLS.map(t => [t.name, ajv.compile(t.inputSchema)]));

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
