// app/.server/assistant/tools.ts —— AI 助手的工具注册表（ADR-0042）：每个工具登记名称、输入输出 JSON Schema、所需权限与是否允许外部调用
// （MCP 以后从这张表生成，外部能用的始终是内部的子集）。成员只看得到自己有权限的工具，调用时再按登记的权限检查一次：成员没有的权限助手也用不了。
// 工具返回给模型的是文本。目录按角色过滤（catalogFor）：没有 sources:read 的成员看不到数据源与源表条目、字段来源与实体映射到的源表（ADR-0005）
import { Ajv, type ValidateFunction } from 'ajv';
import { data } from 'react-router';
import { assertCan, can, type Permission } from '../access';
import type { CurrentMember } from '../auth';
import { expand, overview, search, toMarkdown, type Catalog, type CatalogEntry } from '../catalog';
import { tenantCatalog } from '../catalog/load';
import { validateDefinition } from '../dsl-definitions';
import type { DslIssue } from '../pipeline/dsl/metric-spec';
import { validateNewMapping } from '../mappings';
import { sourceIdByName } from '../source-config';

export interface AssistantTool {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema: object;
  permission: Permission;
  /** 是否允许外部（MCP）调用 */
  external: boolean;
  /** input 已按 inputSchema 校验过；返回给模型的文本 */
  run(actor: CurrentMember, input: Record<string, unknown>): Promise<string>;
}

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
      return result.ok ? '校验通过' : `有 ${result.issues.length} 个问题：\n${issueLines(result.issues)}`;
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
      return [v.error, v.issues.length ? issueLines(v.issues) : ''].filter(Boolean).join('\n');
    },
  },
];

/** 成员可以用的工具：有登记的权限 */
export const toolsFor = (member: CurrentMember): AssistantTool[] => TOOLS.filter(t => can(member.role, t.permission));

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>(TOOLS.map(t => [t.name, ajv.compile(t.inputSchema)]));

const badRequest = (message: string) => data({ message }, { status: 400 });

/** 按名字调用工具：没有这个工具或输入不合 Schema 时 400，成员没有登记的权限时 403 */
export async function runTool(actor: CurrentMember, name: string, input: unknown): Promise<string> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw badRequest(`没有工具 ${name}`);
  assertCan(actor, tool.permission);
  const validate = validators.get(name)!;
  if (!validate(input)) throw badRequest(`工具 ${name} 的输入不对：${ajv.errorsText(validate.errors, { dataVar: 'input' })}`);
  return tool.run(actor, input as Record<string, unknown>);
}
