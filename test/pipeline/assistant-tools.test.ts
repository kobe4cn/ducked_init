// test/pipeline/assistant-tools.test.ts —— AI 助手的工具注册表（ADR-0042）：toolsFor 按角色列出可用工具，runTool 按登记的权限检查（403）、
// 没有的工具与不合 Schema 的输入 400；目录工具按角色过滤（catalogFor：查看者看不到 source: / table: 条目与字段来源，ADR-0005）；
// 校验工具（定义、映射）把问题转成给模型的文本；validate_plan 校验分析计划（ADR-0050）：只认本轮 catalog_search / catalog_expand 检索到的条目，
// search / expand 的输出给每个条目带按角色裁剪的目录上算出的语义哈希；
// 分层总览（#854）：catalog_overview 只给第一层分组（查看者没有 group:sources 汇总行），catalog_expand 认 group: 分组标识，组内条目记进本轮检索；
// validate_plan 发给模型的参数 Schema 是剥掉条件关键字的 PLAN_SCHEMA、说明附最小示例，结构错误仍以逐条问题返回而不是 400（#1178）
import { Ajv } from 'ajv';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { catalogFor, invokeTool, PLAN_EXAMPLE, runTool, TOOLS, toolsFor } from '../../app/.server/assistant/tools';
import { PLAN_SCHEMA, semanticHash, validatePlan } from '../../app/.server/catalog/plan';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
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
    expect(names(toolsFor(author))).toEqual([...catalogTools, 'prefill_workbench', 'save_definition_draft', 'save_mapping_draft', 'validate_definition', 'validate_mapping'].sort());
    expect(names(toolsFor(analyst))).toEqual([...catalogTools, 'prefill_workbench', 'save_definition_draft', 'validate_definition'].sort());
    expect(names(toolsFor(viewer))).toEqual(catalogTools);
    // prefill_workbench 要 sandbox 权限（查看者没有）、不对外开放：外部经 MCP 调用没有本轮 / 对话里的计划上下文（#436）
    expect(TOOLS.find(t => t.name === 'prefill_workbench')).toMatchObject({ permission: 'sandbox', external: false });

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
    // 第一层只有分组：查看者没有数据源汇总行（也不泄露源表数），没有 source / table 条目行
    const overview = await runTool(viewer, 'catalog_overview', {});
    expect(overview).toContain('- group:entity:customer ');
    expect(overview).not.toContain('group:sources');
    expect(overview).not.toMatch(/(source|table):/);
    const field = await runTool(viewer, 'catalog_expand', { id: mapped.id });
    expect(field).toContain(`## ${mapped.id}`);
    // 来源被隐藏时写中性文字，不说「未映射」（#1188）
    expect(field).toContain('- 来源：按你的角色不显示');
    expect(field).not.toContain('未映射');
    const entity = await runTool(viewer, 'catalog_expand', { id: 'entity:customer' });
    expect(entity).not.toMatch(/(source|table):/);
    expect(entity).toContain('- 映射来源：按你的角色不显示');
    expect(entity).not.toContain('未映射');
    const viewerSearch = await runTool(viewer, 'catalog_search', { query: 'customer' });
    expect(viewerSearch).toContain('## entity:customer');
    expect(viewerSearch).toContain('- 映射来源：按你的角色不显示');
    expect(viewerSearch).not.toContain('未映射');
    // 分析师的实体仍列出映射来源
    const analystEntity = await runTool(analyst, 'catalog_expand', { id: 'entity:customer' });
    expect(analystEntity).toMatch(/- 映射来源：\S*\//);
    expect(analystEntity).not.toContain('按你的角色不显示');
    // 组内列表也没有数据源、源表与字段来源
    const grouped = await runTool(viewer, 'catalog_expand', { id: 'group:entity:customer' });
    expect(grouped).toContain('- entity:customer ');
    expect(grouped).not.toMatch(/(source|table):/);
    expect(grouped).not.toContain('来源：');
    // 数据源与源表在 group:sources 组里（每行带语义哈希）；查看者的目录里没有这个组
    const sources = await runTool(analyst, 'catalog_expand', { id: 'group:sources' });
    const source = sources.match(/^- (source:\S+)/m)![1]!;
    expect(sources).toMatch(/· semanticHash: [0-9a-f]{64}/m);
    expect(await runTool(viewer, 'catalog_expand', { id: 'group:sources' })).toBe('没有这个条目');
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

  it('catalog_expand 展开分组：组内条目每行带语义哈希并记进本轮检索，计划只经分组引用它们也通过', async () => {
    const { author, reviewer } = await publishedIdentitySources();
    await createDefinition(author, 'metric', 'customer_count', 'base: customer\nmeasure: { agg: count }\ndescription: 客户数\n');
    await publishDefinition(reviewer, 'metric', 'customer_count', 1);

    // 只经分组拿到条目：展开实体组，从行里取条目标识与语义哈希
    const retrieved = new Set<string>();
    const group = await invokeTool(author, 'catalog_expand', { id: 'group:entity:customer' }, {}, { retrieved });
    const line = group.text.split('\n').find(l => l.startsWith('- entity:customer '))!;
    const hash = line.match(/semanticHash: ([0-9a-f]{64})/)![1];
    expect(hash).toBe(semanticHash((await catalogFor(author)).entries.find(e => e.id === 'entity:customer')!));
    expect(group.text).toMatch(/^# 分组 group:entity:customer$/m);
    expect(retrieved.has('entity:customer')).toBe(true);
    expect(retrieved.has('group:entity:customer')).toBe(false); // 组标识不是条目，不进候选集合
    expect(group.text.split('\n').filter(l => l.startsWith('- field:')).length).toBeGreaterThan(0);

    const plan = {
      schemaVersion: 1,
      mode: 'reuse_result',
      selected: [{ id: 'entity:customer', semanticHash: hash }],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: ['entity:customer'] }],
      assumptions: [],
      questions: [],
    };
    const checked = await invokeTool(author, 'validate_plan', { plan }, {}, { retrieved });
    expect(checked.text).toBe('status: valid');

    // 只经分组拿到的指标：组内行带 semanticHash 与 version，计划带上两者通过
    const metricLine = group.text.split('\n').find(l => l.startsWith('- metric:customer_count '))!;
    const [, metricHash, version] = metricLine.match(/semanticHash: ([0-9a-f]{64}) · version: (\d+)/)!;
    expect(retrieved.has('metric:customer_count')).toBe(true);
    const metricPlan = {
      ...plan,
      selected: [{ id: 'metric:customer_count', semanticHash: metricHash, version: Number(version) }],
      steps: [{ id: 's1', action: 'answer', inputs: ['metric:customer_count'] }],
    };
    const metricChecked = await invokeTool(author, 'validate_plan', { plan: metricPlan }, {}, { retrieved });
    expect(metricChecked.text).toBe('status: valid');
  });

  it('validate_plan 发给模型的参数 Schema 是 PLAN_SCHEMA（剥掉 if / not 等条件关键字），说明末尾附最小示例（#1178）', async () => {
    const { acme } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const tool = toolsFor(analyst).find(t => t.name === 'validate_plan')!;
    const schema = tool.inputSchema as { required: string[]; properties: { plan: { required: string[] } } };
    expect(schema.required).toEqual(['plan']);
    expect(schema.properties.plan.required).toEqual(expect.arrayContaining(['schemaVersion', 'mode', 'selected', 'request', 'steps', 'assumptions', 'questions']));
    const sent = JSON.stringify(tool.inputSchema);
    for (const k of ['"if"', '"then"', '"not"', '"allOf"']) expect(sent).not.toContain(k);
    expect(tool.description).toContain(`最小合法示例（draft_query）：${JSON.stringify(PLAN_EXAMPLE)}`);
  });

  it('validate_definition / save_definition_draft 的说明列出指标与标签 DSL 的顶层键（必填键标出），并说明口径声明与别名不在 YAML 里（#1185）', async () => {
    const { acme } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    for (const name of ['validate_definition', 'save_definition_draft']) {
      const { description } = toolsFor(analyst).find(t => t.name === name)!;
      for (const k of ['base', 'measure', 'filter', 'window', 'rules', 'default', 'missing']) expect(description).toContain(k);
      expect(description).toContain('必填 base、measure');
      expect(description).toContain('必填 rules、default');
      expect(description).toMatch(/口径声明.*别名不在 YAML 里.*业务知识/);
    }
  });

  it('validate_plan 的最小示例能通过 PLAN_SCHEMA 的结构校验（#1178）', () => {
    expect(new Ajv({ strict: false }).compile(PLAN_SCHEMA)(PLAN_EXAMPLE)).toBe(true);
    // 空目录下条目没检索到，status 是 invalid；只断言结构与步骤检查通过（plan 不为 null）
    expect(validatePlan(PLAN_EXAMPLE, { catalog: { entries: [] }, retrieved: new Set() }).plan).not.toBeNull();
  });

  it('validate_plan 结构错误的计划不抛 400，以 status: invalid 和中文的逐条问题返回（#1178）', async () => {
    const { acme } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const plan = { ...PLAN_EXAMPLE, steps: [PLAN_EXAMPLE.steps[0], { id: 's2', action: 'aggregate', agg: 'count', inputs: ['s1', 's1'] }] };
    const result = await invokeTool(analyst, 'validate_plan', { plan }, {}, { retrieved: new Set() });
    expect(result.text).toContain('status: invalid');
    expect(result.text).toContain('最多 1 项');
    // 非 aggregate 步骤带 agg：报中文原因而不是 must NOT be valid
    const fetchWithAgg = { ...PLAN_EXAMPLE, steps: [{ id: 's1', action: 'fetch', agg: 'count', inputs: ['metric:order_count'] }] };
    const rejected = await invokeTool(analyst, 'validate_plan', { plan: fetchWithAgg }, {}, { retrieved: new Set() });
    expect(rejected.text).toContain('只有 aggregate 步骤能写 agg');
    expect(rejected.text).not.toContain('must NOT');
  });
});
