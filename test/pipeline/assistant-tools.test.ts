// test/pipeline/assistant-tools.test.ts —— AI 助手的工具注册表（ADR-0042）：toolsFor 按角色列出可用工具，runTool 按登记的权限检查（403）、
// 没有的工具与不合 Schema 的输入 400；目录工具按角色过滤（catalogFor：查看者看不到 source: / table: 条目与字段来源，ADR-0005）；
// 校验工具（定义、映射）把问题转成给模型的文本
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { catalogFor, runTool, toolsFor } from '../../app/.server/assistant/tools';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const names = (tools: { name: string }[]) => tools.map(t => t.name).sort();

describe('AI 助手的工具注册表', () => {
  it('按角色列出工具、调用时按登记权限检查；查看者经目录工具看不到数据源、源表与字段来源', async () => {
    const { acme, author } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');

    const catalogTools = ['catalog_expand', 'catalog_overview', 'catalog_search'];
    expect(names(toolsFor(author))).toEqual([...catalogTools, 'save_definition_draft', 'save_mapping_draft', 'validate_definition', 'validate_mapping']);
    expect(names(toolsFor(analyst))).toEqual([...catalogTools, 'save_definition_draft', 'validate_definition']);
    expect(names(toolsFor(viewer))).toEqual(catalogTools);

    await expect(runTool(viewer, 'validate_definition', { kind: 'metric', yaml: 'base: customer' })).rejects.toMatchObject({ init: { status: 403 } });
    await expect(runTool(analyst, 'validate_mapping', { source: 'CRM', yaml: 'x: 1' })).rejects.toMatchObject({ init: { status: 403 } });
    await expect(runTool(author, 'no_such_tool', {})).rejects.toMatchObject({ init: { status: 400 } });
    await expect(runTool(author, 'catalog_expand', {})).rejects.toMatchObject({ init: { status: 400 } });

    // 有 sources:read 的成员看得到数据源条目与字段来源
    expect(await runTool(analyst, 'catalog_search', { query: 'CRM' })).toMatch(/## (source|table):/);
    const mapped = (await catalogFor(analyst)).entries.find(e => e.kind === 'field' && e.lineage.length)!;
    expect(await runTool(analyst, 'catalog_expand', { id: mapped.id })).toMatch(/- 来源：\n {2}- \S+\//);

    const searched = await runTool(viewer, 'catalog_search', { query: 'CRM' });
    expect(searched).not.toMatch(/(source|table):/);
    const overview = await runTool(viewer, 'catalog_overview', {});
    expect(overview).toContain('- entity:customer ');
    expect(overview).not.toMatch(/(source|table):/);
    const field = await runTool(viewer, 'catalog_expand', { id: mapped.id });
    expect(field).toContain(`## ${mapped.id}`);
    expect(field).toContain('- 来源：未映射');
    expect(await runTool(viewer, 'catalog_expand', { id: 'entity:customer' })).not.toMatch(/(source|table):/);
    const [source] = (await runTool(analyst, 'catalog_overview', {})).match(/source:\S+/)!;
    expect(await runTool(viewer, 'catalog_expand', { id: source })).toBe('没有这个条目');
  });

  it('校验工具：错的指标列出问题，对的通过；映射校验按数据源名找数据源', async () => {
    const { author } = await publishedIdentitySources();

    const bad = await runTool(author, 'validate_definition', { kind: 'metric', yaml: 'base: nope\nmeasure: { agg: count }\n' });
    expect(bad).toMatch(/^有 \d+ 个问题：\n- base/);
    expect(await runTool(author, 'validate_definition', { kind: 'metric', yaml: 'base: customer\nmeasure: { agg: count }\n' })).toBe('校验通过');

    expect(await runTool(author, 'validate_mapping', { source: '不存在', yaml: 'x: 1' })).toBe('没有叫「不存在」的数据源');
    const mapping = await runTool(author, 'validate_mapping', { source: 'CRM', yaml: 'table: customers\n' });
    expect(mapping).toMatch(/^映射有 2 处问题/);
    expect(mapping).toContain('- （文档）（第 1 行第 1 列）：缺少 entity');
  });
});
