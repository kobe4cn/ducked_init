// test/pipeline/assistant-tools.test.ts —— AI 助手的工具注册表（ADR-0042）：toolsFor 按角色列出可用工具，runTool 按登记的权限检查（403）、
// 没有的工具与不合 Schema 的输入 400；目录工具按角色过滤（catalogFor：查看者看不到 source: / table: 条目与字段来源，ADR-0005）；
// 校验工具（定义、映射）把问题转成给模型的文本；validate_plan 校验分析计划（ADR-0050）：只认本轮 catalog_search / catalog_expand 检索到的条目，
// search / expand 的输出给每个条目带按角色裁剪的目录上算出的语义哈希
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { catalogFor, invokeTool, runTool, toolsFor } from '../../app/.server/assistant/tools';
import { semanticHash } from '../../app/.server/catalog/plan';
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

    const catalogTools = ['catalog_expand', 'catalog_overview', 'catalog_search', 'validate_plan'];
    expect(names(toolsFor(author))).toEqual([...catalogTools, 'save_definition_draft', 'save_mapping_draft', 'validate_definition', 'validate_mapping'].sort());
    expect(names(toolsFor(analyst))).toEqual([...catalogTools, 'save_definition_draft', 'validate_definition'].sort());
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

  it('validate_plan：引用本轮检索到的条目通过、没检索到的被拒；search / expand 的输出带按角色裁剪的语义哈希', async () => {
    const { acme, author } = await publishedIdentitySources();
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    const hashOf = async (member: typeof author, id: string) =>
      semanticHash((await catalogFor(member)).entries.find(e => e.id === id)!);

    // expand / search 的输出带语义哈希，条目记进本轮检索到的候选集合（validate_plan 只认这些）
    const retrieved = new Set<string>();
    const expanded = await invokeTool(author, 'catalog_expand', { id: 'entity:customer' }, {}, { retrieved });
    expect(expanded.text).toContain(`semanticHash: ${await hashOf(author, 'entity:customer')}`);
    expect(retrieved.has('entity:customer')).toBe(true);
    const searched = await invokeTool(author, 'catalog_search', { query: 'coupon' }, {}, { retrieved });
    expect(searched.text).toContain(`semanticHash: ${await hashOf(author, 'entity:coupon')}`);
    expect(retrieved.has('entity:coupon')).toBe(true);

    // 哈希在成员自己那份按角色裁剪的目录上算：查看者看不到映射到实体的源表，同一实体的哈希不同
    const asViewer = await invokeTool(viewer, 'catalog_expand', { id: 'entity:customer' }, {});
    expect(asViewer.text).toContain(`semanticHash: ${await hashOf(viewer, 'entity:customer')}`);
    expect(await hashOf(viewer, 'entity:customer')).not.toBe(await hashOf(author, 'entity:customer'));

    /** 一份选了 id 的合法 reuse_result 计划（实体没有版本，不带 version） */
    const plan = (id: string, hash: string) => ({
      schemaVersion: 1,
      mode: 'reuse_result',
      selected: [{ id, semanticHash: hash }],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: [id] }],
      assumptions: [],
      questions: [],
    });

    // 刚检索到的 entity:coupon 通过；在目录里但本轮没检索到的 entity:order 被拒，问题带 path 与 entryId
    const valid = await invokeTool(author, 'validate_plan', { plan: plan('entity:coupon', await hashOf(author, 'entity:coupon')) }, {}, { retrieved });
    expect(valid.text).toBe('status: valid');
    expect(valid.rejected).toBeUndefined();
    const invalid = await invokeTool(author, 'validate_plan', { plan: plan('entity:order', await hashOf(author, 'entity:order')) }, {}, { retrieved });
    expect(invalid.text).toContain('status: invalid');
    expect(invalid.text).toContain('- selected.0.id（entity:order）：选中的条目不在本次检索结果里');
    expect(invalid.rejected).toBeUndefined(); // 不用 rejected：计划的校验结果不算修正次数
  });
});
