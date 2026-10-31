// app/.server/assistant/tools.ts —— AI 助手的工具注册表（ADR-0042）：每个工具登记名称、输入输出 JSON Schema、所需权限与是否允许外部调用
// （/mcp 的工具从这张表里 external 的那部分生成，外部能用的始终是内部的子集）。成员只看得到自己有权限的工具，调用时再按登记的权限检查一次：成员没有的权限助手也用不了。
// 工具返回给模型的是文本；校验或保存不通过时另带上问题清单与那一版 YAML（rejected），助手循环据此计数、超过修正次数时交给成员（ADR-0043）。
// 保存类工具只存草稿，发布照旧双人；注册表里没有发布工具。执行查询的 run_query 另要令牌的授权（requires: 'allowQuery'）：只有签发时允许执行查询的令牌经 MCP 拿得到，
// 平台内的助手拿不到（toolsFor 不含、invokeTool 不带授权时 403）；结果按工作台解读的规则剔除列，但对全部返回行判断哈希（ADR-0043）。目录按角色过滤（catalogFor）：没有 sources:read 的成员看不到数据源与源表条目、字段来源与实体映射到的源表（ADR-0005）
import { Ajv, type ValidateFunction } from 'ajv';
import { and, eq } from 'drizzle-orm';
import { data } from 'react-router';
import { parse } from 'yaml';
import { assertCan, can, type Permission } from '../access';
import type { CurrentMember } from '../auth';
import { expand, overview, search, toMarkdown, type Catalog, type CatalogEntry } from '../catalog';
import { tenantCatalog } from '../catalog/load';
import { getDb } from '../db/client';
import { dslDefinitions, mappings } from '../db/schema';
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
  /** input 已按 inputSchema 校验过；返回给模型的文本，不通过时带上问题清单 */
  run(actor: CurrentMember, input: Record<string, unknown>): Promise<string | ToolResult>;
}

/** 工具的结果：rejected 表示校验或保存没有通过，issues 是问题清单的文本、yaml 是被拒的那一版；saved 表示保存了一份草稿 */
export interface ToolResult { text: string; rejected?: { issues: string; yaml: string }; saved?: true }

/** 本租户的目录，按成员角色过滤：没有 sources:read 时去掉数据源与源表条目，字段不带来源、实体不列映射到它的源表与合并组 */
export async function catalogFor(member: CurrentMember): Promise<Catalog> {
  const c = await tenantCatalog(member.tenant.id);
  if (can(member.role, 'sources:read')) return c;
  const entries = c.entries.flatMap((e): CatalogEntry[] => {
    switch (e.kind) {
      case 'source':
      case 'table':
        return [];
      case 'field':
        return [{ ...e, lineage: [] }];
      case 'entity':
        return [{ ...e, tables: [], unscoped: [], mergeGroups: [] }];
      default:
        return [e];
    }
  });
  return { ...c, entries };
}

const TEXT = { type: 'string' };

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
    run: async (actor, { id }) => {
      const entry = expand(await catalogFor(actor), id as string);
      return entry ? toMarkdown(entry) : '没有这个条目';
    },
  },
  {
    name: 'catalog_search',
    description: '按关键词搜索目录条目，返回展开后的条目',
    inputSchema: {
      type: 'object', required: ['query'],
      properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
    outputSchema: TEXT,
    permission: 'definitions:read',
    external: true,
    run: async (actor, { query, limit }) => toMarkdown(search(await catalogFor(actor), query as string, limit as number | undefined)),
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

/** 按名字调用工具：没有这个工具或输入不合 Schema 时 400，成员没有登记的权限或调用方没有另要的授权时 403 */
export async function invokeTool(actor: CurrentMember, name: string, input: unknown, tokenGrants: ToolGrants = {}): Promise<ToolResult> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw badRequest(`没有工具 ${name}`);
  if (!hasGrant(tool, tokenGrants)) throw data({ message: '没有执行查询的授权：签发令牌时须勾选「允许执行查询」' }, { status: 403 });
  assertCan(actor, tool.permission);
  const validate = validators.get(name)!;
  if (!validate(input)) throw badRequest(`工具 ${name} 的输入不对：${ajv.errorsText(validate.errors, { dataVar: 'input' })}`);
  const result = await tool.run(actor, input as Record<string, unknown>);
  return typeof result === 'string' ? { text: result } : result;
}

/** 同 invokeTool，只返回给模型的文本 */
export const runTool = async (actor: CurrentMember, name: string, input: unknown): Promise<string> => (await invokeTool(actor, name, input)).text;
