// 工作台 SQL 编辑器（纯函数）：DuckDB 方言的关键字高亮，目录树转成的补全 schema 与 lang-sql 按它补出的表名、字段名
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { schemaCompletionSource } from '@codemirror/lang-sql';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry, WorkbenchCatalog } from '../app/.server/workbench';
import { duckdbDialect } from '../app/lib/duckdb-sql';
import { completionSchema } from '../app/lib/sql-completion';

const RFM = 'rfm__0b6f3a52-6c1e-4f0a-9d7e-1c2b3a4d5e6f';
const MINE = 'sandbox_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER = 'sandbox_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const entry = (schema: string, name: string, columns: string[]): CatalogEntry => ({
  schema, name, rows: 1, columns: columns.map(c => ({ name: c, type: 'VARCHAR' })),
  ref: `lake.${schema}."${name}"`, location: `s3://lake/${schema}/${name}/`,
});

// listCatalog 已按权限过滤：他人没分享的沙箱本来就不在输入里
const catalog: WorkbenchCatalog = {
  silver: [entry('silver', 'customer', ['consumer_id', 'email']), entry('silver', 'orders', ['order_id', 'amount'])],
  gold: [entry('gold', RFM, ['consumer_id', 'r_score'])],
  mine: [entry(MINE, 'top_customers', ['consumer_id', 'total'])],
  shared: [entry(OWNER, 'vip', ['consumer_id'])],
  raw: [
    { name: 'CRM', tables: [{ name: 'customers', ref: '"CRM"."customers"', columns: [{ name: 'email', type: 'VARCHAR' }] }] },
    { name: 'silver', tables: [], error: '与保留名冲突' },
  ],
};

/** 在 doc 末尾（或 | 处）取补全 */
async function complete(doc: string): Promise<CompletionResult | null> {
  const pos = doc.includes('|') ? doc.indexOf('|') : doc.length;
  const text = doc.replace('|', '');
  const state = EditorState.create({ doc: text, extensions: duckdbDialect.language });
  const source = schemaCompletionSource({ schema: completionSchema(catalog), dialect: duckdbDialect });
  return await source(new CompletionContext(state, pos, true));
}
const labels = (r: CompletionResult | null) => (r?.options ?? []).map(o => o.label);
const applied = (r: CompletionResult | null, label: string) => {
  const o = r?.options.find(x => x.label === label);
  return typeof o?.apply === 'string' ? o.apply : o?.label;
};

describe('补全 schema', () => {
  it('顶层只有成员能读的 schema、lake 与挂载了的数据源；他人没分享的沙箱、没挂载的数据源不出现', () => {
    const schema = completionSchema(catalog) as Record<string, unknown>;
    expect(Object.keys(schema).sort()).toEqual(['CRM', 'gold', 'lake', OWNER, MINE, 'silver'].sort());
    expect(Object.keys(schema[OWNER] as object)).toEqual(['vip']);
    expect(JSON.stringify(schema)).not.toContain('与保留名冲突');
  });

  it('silver. 之后补出表名，表. 之后补出字段名（带类型）', async () => {
    expect(labels(await complete('SELECT * FROM silver.'))).toEqual(['customer', 'orders']);
    expect(labels(await complete('SELECT silver.customer.'))).toEqual(['consumer_id', 'email']);
    const cols = await complete('SELECT * FROM silver.customer c WHERE c.');
    expect(labels(cols)).toEqual(['consumer_id', 'email']);
    expect(cols?.options[0]?.detail).toBe('VARCHAR');
    expect(labels(await complete(`SELECT * FROM lake.${MINE}.`))).toEqual(['top_customers']);
  });

  it('结果层带横线的表名补全时带引号，带引号的表名之后照样补出字段', async () => {
    expect(applied(await complete('SELECT * FROM gold.'), RFM)).toBe(`"${RFM}"`);
    expect(labels(await complete(`SELECT gold."${RFM}".`))).toEqual(['consumer_id', 'r_score']);
    expect(applied(await complete('SELECT * FROM '), 'CRM')).toBe('"CRM"');
    expect(labels(await complete('SELECT * FROM "CRM".'))).toEqual(['customers']);
  });

  it('不是简单标识符的字段名补全时带引号', async () => {
    const raw = [{ name: 'crm', tables: [{ name: 'c', ref: '"crm"."c"', columns: [{ name: 'CustomerID', type: 'INT' }, { name: 'id', type: 'INT' }] }] }];
    const state = EditorState.create({ doc: 'SELECT crm.c.', extensions: duckdbDialect.language });
    const r = await schemaCompletionSource({ schema: completionSchema({ ...catalog, raw }), dialect: duckdbDialect })(new CompletionContext(state, state.doc.length, true));
    expect(applied(r, 'CustomerID')).toBe('"CustomerID"');
    expect(applied(r, 'id')).toBe('id');
  });

  it('分享给我的表按主人的沙箱 schema 补全', async () => {
    expect(labels(await complete(`SELECT * FROM ${OWNER}.`))).toEqual(['vip']);
    expect(labels(await complete(`SELECT * FROM ${OWNER}.vip v WHERE v.`))).toEqual(['consumer_id']);
  });

  it('数据源名里的点不拆成两级', async () => {
    const schema = completionSchema({ ...catalog, raw: [{ name: 'crm.v2', tables: [{ name: 't', ref: '"crm.v2"."t"', columns: [] }] }] });
    const state = EditorState.create({ doc: 'SELECT * FROM "crm.v2".', extensions: duckdbDialect.language });
    const r = await schemaCompletionSource({ schema, dialect: duckdbDialect })(new CompletionContext(state, state.doc.length, true));
    expect(labels(r)).toEqual(['t']);
  });
});

describe('DuckDB 方言', () => {
  it('扩展关键字按关键字高亮', () => {
    const sql = 'SUMMARIZE silver.customer; DESCRIBE x; SELECT * EXCLUDE (a), COLUMNS(\'b\') FROM t QUALIFY 1; PIVOT t ON a USING sum(b)';
    const keywords: string[] = [];
    duckdbDialect.language.parser.parse(sql).iterate({
      enter: n => { if (n.name === 'Keyword') keywords.push(sql.slice(n.from, n.to).toUpperCase()); },
    });
    for (const k of ['SUMMARIZE', 'DESCRIBE', 'QUALIFY', 'PIVOT', 'EXCLUDE', 'COLUMNS']) expect(keywords).toContain(k);
  });
});
