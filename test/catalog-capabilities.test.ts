// test/catalog-capabilities.test.ts —— 语义目录的能力说明（ADR-0041）：每个手写示例都过 checkMetric / checkTag（标签示例引用指标示例）；
// 注册表（AGGS、RATIO_AGGS、FILTER_OPS、MAX_DIMENSIONS、MAX_HOPS、METRIC_SCHEMA、TAG_CONDITIONS、TAG_SCHEMA、TEMPLATES）的每一项都出现在能力说明里；
// 模板产出列与各模板按默认参数编译出的 SELECT 在内存 DuckDB 里 DESCRIBE 出来的列名与类型一致（纯函数，不碰平台库与数据湖）
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { buildCatalog, expand, toMarkdown, type CapabilityEntry } from '../app/.server/catalog';
import { CAPABILITIES, CAPABILITY_EXAMPLES, TEMPLATE_OUTPUTS } from '../app/.server/catalog/capabilities';
import { AGGS, checkMetric, FILTER_OPS, MAX_DIMENSIONS, MAX_HOPS, METRIC_SCHEMA, RATIO_AGGS, type DslContext } from '../app/.server/pipeline/dsl/metric-spec';
import { checkTag, TAG_CONDITIONS, TAG_SCHEMA } from '../app/.server/pipeline/dsl/tag-spec';
import { TEMPLATES, type TemplateId } from '../app/.server/pipeline/templates';

// 只有标准实体：没有自定义实体、没有扩展字段
const base: DslContext = { published: new Map(), plans: [], metrics: new Map() };
const ctx: DslContext = {
  ...base,
  metrics: new Map(CAPABILITY_EXAMPLES.filter(e => e.kind === 'metric').map(e => [e.key, checkMetric(e.yaml, base)])),
};

const capability = (id: string) => CAPABILITIES.find(c => c.id === id)!;
const names = (c: CapabilityEntry) => c.sections.flatMap(s => s.items.map(i => i.name));
const text = (c: CapabilityEntry) => toMarkdown(c);

describe('能力说明', () => {
  it('每个手写示例都通过校验，标签示例引用的指标示例能被标签引用', () => {
    expect(CAPABILITY_EXAMPLES.filter(e => e.kind === 'metric').length).toBeGreaterThan(0);
    expect(CAPABILITY_EXAMPLES.filter(e => e.kind === 'tag').length).toBeGreaterThan(0);
    for (const e of CAPABILITY_EXAMPLES) {
      const r = e.kind === 'metric' ? checkMetric(e.yaml, ctx) : checkTag(e.yaml, ctx);
      expect(r, `${e.kind} ${e.key}：${JSON.stringify(r.ok ? null : r.issues)}`).toMatchObject({ ok: true });
    }
    expect(new Set(CAPABILITY_EXAMPLES.map(e => e.key)).size).toBe(CAPABILITY_EXAMPLES.length);
  });

  it('目录里有三个能力条目，注册表的每一项都出现在能力说明里', () => {
    const c = buildCatalog({});
    expect(c.entries.filter(e => e.kind === 'capability').map(e => e.id)).toEqual(['capability:metric-dsl', 'capability:tag-dsl', 'capability:templates']);
    expect(expand(c, 'capability:metric-dsl')).toEqual(capability('capability:metric-dsl'));

    const metric = capability('capability:metric-dsl');
    for (const name of [...AGGS, ...RATIO_AGGS, ...FILTER_OPS, ...Object.keys(METRIC_SCHEMA.properties)]) expect(names(metric), name).toContain(name);
    expect(text(metric)).toContain(`最多 ${MAX_DIMENSIONS} 个维度`);
    expect(text(metric)).toContain(`最多 ${MAX_HOPS} 跳`);
    for (const e of CAPABILITY_EXAMPLES.filter(x => x.kind === 'metric')) expect(text(metric)).toContain(e.yaml.trimEnd());

    const tag = capability('capability:tag-dsl');
    for (const name of [...TAG_CONDITIONS, ...Object.keys(TAG_SCHEMA.properties)]) expect(names(tag), name).toContain(name);
    for (const e of CAPABILITY_EXAMPLES.filter(x => x.kind === 'tag')) expect(text(tag)).toContain(e.yaml.trimEnd());

    const templates = capability('capability:templates');
    for (const id of Object.keys(TEMPLATES) as TemplateId[]) {
      expect(text(templates)).toContain(`### ${id} ${TEMPLATES[id].label}`);
      for (const key of Object.keys(TEMPLATES[id].defaults)) expect(names(templates), `${id}.${key}`).toContain(key);
      for (const col of TEMPLATE_OUTPUTS[id].columns) expect(text(templates)).toContain(`\`${col.name}\` ${col.type}`);
    }
  });

  it('模板产出列与按默认参数编译出的 SELECT 的列名、类型一致', async () => {
    const con = await (await DuckDBInstance.create(':memory:')).connect();
    await con.run(`CREATE SCHEMA silver;
      CREATE TABLE silver."order" (order_id VARCHAR, customer_id VARCHAR, _customer_source VARCHAR, status VARCHAR, amount DECIMAL(18, 2),
        created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ);
      CREATE TABLE silver._identities (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR);
      CREATE TABLE silver._consumer (consumer_id VARCHAR);
      CREATE TABLE silver._consumer_consent (consumer_id VARCHAR, channel VARCHAR, status VARCHAR);`);
    for (const id of Object.keys(TEMPLATES) as TemplateId[]) {
      const t = TEMPLATES[id];
      const sql = t.compile(t.parse({ asOf: '2026-10-01' }) as never, () => true);
      const described = (await (await con.runAndReadAll(`DESCRIBE ${sql}`)).getRowObjectsJson()).map(r => ({ name: r.column_name, type: r.column_type }));
      expect(described, id).toEqual(TEMPLATE_OUTPUTS[id].columns.map(c => ({ name: c.name, type: c.type })));
    }
    con.closeSync();
  });
});
