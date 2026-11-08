// 任务契约：参数 schema 接受的参数、拒绝的参数与报错文案（纯函数，不碰平台库与数据湖）
import { describe, expect, it } from 'vitest';
import { CONTRACTS, isTaskKind, type TaskKind } from '../app/.server/pipeline/task-contracts';

/** 一个已发布映射的最小参数（深层形状发布时已校验过，契约只核对形状） */
const mapping = { mapping: 'm1', version: 1, sourceId: 's1', entity: 'customer', table: 'crm.customers', columns: [{ name: 'id' }], entityColumns: [{ name: 'id' }], key: ['id'], latest: null };
const uuid = '00000000-0000-0000-0000-000000000000';
const hash = 'a'.repeat(64);

/** 每个任务契约接受的一组合法参数（取自入队时实际会带的形状） */
const accepted: [TaskKind, Record<string, unknown>][] = [
  ['catalog.projection', {}],
  ['catalog.embed', {}],
  ['lake.inventory', {}],
  ['demo.seed', { customers: 10 }],
  ['demo.seed', { customers: 1_000_000 }],
  ['source.profile', { sourceId: 's1', tables: ['customers', 'orders'] }],
  ['source.profile', { sourceId: 's1', tables: ['orders'], repairFor: { alert: 'a1' } }],
  ['source.sync', { sourceId: 's1', tables: [{ name: 'orders' }] }],
  ['source.sync', { sourceId: 's1', reconcile: true, tables: [
    { name: 'orders', column: 'updated_at', kind: 'updated_at', key: 'id', softDelete: 'deleted_at' },
    { name: 'events', kind: undefined, column: undefined, key: ['a', 'b'] },
  ] }],
  ['source.keycheck', { sourceId: 's1', tableName: 'orders', keyColumns: ['id'], sensitive: true, memberId: 'm1', email: 'a@b.test' }],
  ['source.verify', { sourceId: 's1', tables: [{ name: 'orders', inScope: true, reason: 'pending_sync', key: ['id'], column: 'u', kind: 'increment' }, { name: 'gone', inScope: false, reason: 'out_of_scope' }] }],
  ['lake.inspect', { expected: { customer: { id: 'VARCHAR', name: 'VARCHAR' } } }],
  ['lake.inspect', { expected: {} }],
  ['silver.keycheck', { entities: [{ entity: 'customer', key: ['id'], bySource: false, mappings: [{ mapping: 'm1', columns: ['id'], group: 'g1' }] }] }],
  ['silver.merge', { mappings: [mapping], identity: ['phone'], identityForce: true, survivorship: { m1: 1 }, consumerSensitive: ['phone'], relations: [{ from: { entity: 'order', field: 'customer_id' }, ref: { entity: 'customer', field: 'id' }, sensitive: false }], identityExclude: [hash] }],
  // 只撤下停用映射（停用的是实体最后一个映射）时 mappings 可以为空
  ['silver.merge', { mappings: [], drop: [{ mapping: 'm1', entity: 'customer' }], identityForce: false, identityExclude: [] }],
  // 早先入队的合并没有这些项
  ['silver.merge', { mappings: [{ ...mapping, group: { id: 'g1', rule: { kind: 'latest', field: 'updated_at' }, key: ['id'], members: [{ mapping: 'm1', sourceId: 's1', version: 1, key: ['id'], latest: 'updated_at', refs: [{ column: 'customer_id', source: 's1' }], sensitive: ['phone'] }] } }] }],
  ['gold.dsl', { kind: 'metric', key: 'amount', definitionId: 'd1', definitionVersion: 2, asOf: '2026-01-01', sql: 'SELECT 1', entities: ['order'], trigger: 'publish' }],
  ['gold.expire', { tables: [`gold.metric__${uuid}`] }],
  ['source.drop', { schema: `bronze_${'0'.repeat(32)}` }],
  ['sandbox.expire', { tables: [`sandbox_${'0'.repeat(32)}.t1`, `sandbox_${'0'.repeat(32)}.t_2`] }],
  ['serving.build', { version: 3, target: '/lake/_serving/v3.duckdb', snapshots: [{ id: 'snap1', template: 'rfm', table: `gold.rfm__${uuid}` }] }],
  ['export.tags', { format: 'csv', conditions: [{ tag: 'tier', value: '高', table: `tag__${uuid}` }], snapshots: [{ id: 'snap1' }] }],
  ['gold.rfm', { asOf: '2026-01-01', definitionVersion: 1, trigger: 'publish' }],
  ['gold.user360', {}],
  ['gold.cohort', {}],
  ['gold.repurchase', {}],
  ['gold.clv', {}],
  ['gold.churn', {}],
];

/** 每个任务契约拒绝的参数与报出的文案（与原来的手写校验一字不差） */
const rejected: [TaskKind, unknown, string][] = [
  ['catalog.projection', null, ''],
  ['lake.inventory', 42, ''],
  ['demo.seed', { customers: -1 }, '参数 customers 必须是 1 到 1000000 之间的整数'],
  ['demo.seed', { customers: 1_000_001 }, '参数 customers 必须是 1 到 1000000 之间的整数'],
  ['demo.seed', { customers: 1.5 }, '参数 customers 必须是 1 到 1000000 之间的整数'],
  ['demo.seed', {}, '参数 customers 必须是 1 到 1000000 之间的整数'],
  ['source.profile', { tables: [] }, '参数 tables 必须是非空的表名列表'],
  ['source.profile', { tables: ['orders', 1] }, '参数 tables 必须是非空的表名列表'],
  ['source.profile', {}, '参数 tables 必须是非空的表名列表'],
  ['source.sync', { tables: [{ name: 'orders' }] }, '缺少参数 sourceId'],
  ['source.sync', { sourceId: 's1', tables: [] }, '参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表'],
  ['source.sync', { sourceId: 's1', tables: [{ name: 'orders', kind: 'updated_at' }] }, '参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表'],
  ['source.sync', { sourceId: 's1', tables: [{ name: 'orders', column: 'u', kind: 'weekly' }] }, '参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表'],
  ['source.keycheck', { keyColumns: ['id'] }, '缺少参数 tableName'],
  ['source.keycheck', { tableName: 'orders' }, '参数 keyColumns 必须是非空的字段列表'],
  ['source.keycheck', { tableName: 'orders', keyColumns: [] }, '参数 keyColumns 必须是非空的字段列表'],
  ['source.verify', { tables: [] }, '缺少参数 sourceId'],
  ['source.verify', { sourceId: 's1', tables: [{ name: 'orders', inScope: true, reason: 'in_lake' }] }, '参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表'],
  ['source.verify', { sourceId: 's1', tables: [{ name: 'orders', inScope: 'yes', reason: 'pending_sync' }] }, '参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表'],
  ['lake.inspect', { expected: { customer: { id: 1 } } }, '参数 expected 必须是 表名 → 列名 → 类型 的对象'],
  ['lake.inspect', { expected: [] }, '参数 expected 必须是 表名 → 列名 → 类型 的对象'],
  ['lake.inspect', {}, '参数 expected 必须是 表名 → 列名 → 类型 的对象'],
  ['silver.keycheck', { entities: [{ entity: 'customer', key: ['id'], bySource: false, mappings: [{ mapping: 'm1', columns: [] }] }] }, '参数 entities 必须是 { entity, key, bySource, mappings: { mapping, columns, group? }[] } 列表'],
  // entities 允许为空列表（原校验只查每一项的形状，没有长度要求）
  ['silver.merge', { mappings: [], drop: [{ mapping: 'm1' }] }, '参数 drop 必须是 { mapping, entity } 列表'],
  ['silver.merge', { drop: [{ mapping: 'm1', entity: 'customer' }] }, '参数 mappings 必须是非空的已发布映射列表'],
  ['silver.merge', { mappings: [{ ...mapping, mapping: 1 }] }, '参数 mappings 必须是非空的已发布映射列表'],
  ['silver.merge', { mappings: [{ ...mapping, version: 1.5 }] }, '参数 mappings 必须是非空的已发布映射列表'],
  ['silver.merge', { mappings: [{ ...mapping, columns: [] }] }, '参数 mappings 必须是非空的已发布映射列表'],
  ['silver.merge', { mappings: [{ ...mapping, latest: 'u', uniqueKey: [] }] }, '参数 mappings 必须是非空的已发布映射列表'],
  ['silver.merge', { mappings: [{ ...mapping, group: { id: 'g1', rule: { kind: 'latest' }, key: ['id'], members: [] } }] }, '参数 mappings 必须是非空的已发布映射列表'],
  ['silver.merge', { mappings: [{ ...mapping, group: { id: 'g1', rule: { kind: 'weekly' }, key: ['id'], members: [{ mapping: 'm1', sourceId: 's1', version: 1, key: ['id'], latest: null, refs: [] }] } }] }, '参数 mappings 必须是非空的已发布映射列表'],
  ['silver.merge', { mappings: [mapping], identity: [] }, '参数 identity 必须是非空的字段名列表'],
  ['silver.merge', { mappings: [mapping], identityForce: 'yes' }, '参数 identityForce 必须是布尔值'],
  ['silver.merge', { mappings: [mapping], survivorship: { m1: 0 } }, '参数 survivorship 必须是映射 ID 到正整数名次的对照'],
  ['silver.merge', { mappings: [mapping], consumerSensitive: 'phone' }, '参数 consumerSensitive 必须是字段名列表'],
  ['silver.merge', { mappings: [mapping], relations: [{ from: { entity: 'order' }, ref: { entity: 'customer', field: 'id' }, sensitive: false }] }, '参数 relations 必须是关系列表（from、ref 与 sensitive）'],
  ['gold.dsl', { key: 'k', sql: 'SELECT 1', entities: ['order'] }, '参数 kind 不合法'],
  ['gold.dsl', { kind: 'BigMetric', sql: 'SELECT 1', entities: ['order'] }, '参数 kind 不合法'],
  ['gold.dsl', { kind: 'metric', entities: ['order'] }, '缺少参数 sql'],
  ['gold.dsl', { kind: 'metric', sql: '' , entities: ['order'] }, '缺少参数 sql'],
  ['gold.dsl', { kind: 'metric', sql: 'SELECT 1', entities: [] }, '参数 entities 必须是非空的实体名列表'],
  ['gold.expire', { tables: ['silver.customer'] }, '参数 tables 必须是非空的结果层快照表名列表'],
  ['gold.expire', { tables: [`gold.metric__${uuid}`, `gold.metric__${uuid.slice(1)}`] }, '参数 tables 必须是非空的结果层快照表名列表'],
  ['gold.expire', { tables: [] }, '参数 tables 必须是非空的结果层快照表名列表'],
  ['source.drop', { schema: 'bronze_123' }, '参数 schema 必须是原始层 schema 名'],
  ['source.drop', {}, '参数 schema 必须是原始层 schema 名'],
  ['sandbox.expire', { tables: ['main.orders'] }, '参数 tables 必须是非空的沙箱表名列表'],
  ['sandbox.expire', { tables: [] }, '参数 tables 必须是非空的沙箱表名列表'],
  ['serving.build', { target: '/lake/_serving/v3.duckdb', snapshots: [] }, '参数 version 必须是正整数'],
  ['serving.build', { version: 0, target: '/lake/_serving/v0.duckdb', snapshots: [] }, '参数 version 必须是正整数'],
  ['serving.build', { version: 3, target: '/lake/_serving/v3.duckdb', snapshots: [{ id: 'snap1', template: 'rfm', table: 'silver.customer' }] }, '参数 snapshots 必须是 { id, template, table } 列表，table 是结果层快照表名'],
  ['serving.build', { version: 3, target: '/lake/_serving/v3.duckdb', snapshots: [{ id: 'snap1', template: 'rfm' }] }, '参数 snapshots 必须是 { id, template, table } 列表，table 是结果层快照表名'],
  ['export.tags', { format: 'xml', conditions: [{ tag: 'tier', value: '高', table: `tag__${uuid}` }] }, '参数 format 只能是 parquet / csv'],
  ['export.tags', { format: 'csv', conditions: [] }, '参数 conditions 必须是非空的 { tag, value, table } 列表，table 是标签快照表名'],
  ['export.tags', { format: 'csv', conditions: [{ tag: 'tier', value: '高', table: 'tag_wrong' }] }, '参数 conditions 必须是非空的 { tag, value, table } 列表，table 是标签快照表名'],
  ['gold.rfm', null, ''],
];

describe('任务契约', () => {
  it('契约表登记了全部任务（非模板与模板占位），isTaskKind 只认表里的 kind', () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual([
      'catalog.embed', 'catalog.projection', 'demo.seed', 'export.tags', 'gold.churn', 'gold.clv', 'gold.cohort', 'gold.dsl', 'gold.expire',
      'gold.repurchase', 'gold.rfm', 'gold.user360', 'lake.inspect', 'lake.inventory', 'sandbox.expire', 'serving.build', 'silver.keycheck',
      'silver.merge', 'source.drop', 'source.keycheck', 'source.profile', 'source.sync', 'source.verify',
    ]);
    for (const kind of Object.keys(CONTRACTS)) expect(isTaskKind(kind)).toBe(true);
    expect(isTaskKind('demo.seeds')).toBe(false);
    expect(isTaskKind('constructor')).toBe(false);
  });

  it.each(accepted)('接受 %s 的参数 %j', (kind, raw) => {
    expect(() => CONTRACTS[kind].params.parse(raw)).not.toThrow();
  });

  it.each(rejected)('不合法的参数 %s %j 报出原因', (kind, raw, message) => {
    if (message) expect(() => CONTRACTS[kind].params.parse(raw)).toThrow(message);
    else expect(() => CONTRACTS[kind].params.parse(raw)).toThrow();
  });

  it('解析出的参数是引擎要用的形状：业务主键单个字段转成数组，缺省的可选项补上默认值', () => {
    const sync = CONTRACTS['source.sync'].params.parse({ sourceId: 's1', tables: [{ name: 'orders', key: 'id' }, { name: 'events', key: ['a'] }] });
    expect(sync).toMatchObject({ sourceId: 's1', tables: [{ name: 'orders', key: ['id'] }, { name: 'events', key: ['a'] }] });
    const merge = CONTRACTS['silver.merge'].params.parse({ mappings: [mapping] });
    expect(merge).toMatchObject({ identityForce: false, identityExclude: [], survivorship: {}, consumerSensitive: [], relations: [], drop: [] });
  });

  it('schema 原样保留调用方带上、engine 还要用的多余字段（快照指针、导出的快照、定义与触发来源）', () => {
    const serving = CONTRACTS['serving.build'].params.parse({ version: 3, target: '/lake/_serving/v3.duckdb', snapshots: [{ id: 'snap1', template: 'rfm', table: `gold.rfm__${uuid}`, definitionVersion: 2 }] });
    expect(serving.snapshots[0]).toMatchObject({ definitionVersion: 2 });
    const tags = CONTRACTS['export.tags'].params.parse({ format: 'parquet', conditions: [{ tag: 'tier', value: '高', table: `tag__${uuid}` }], snapshots: [{ id: 'snap1', template: 'rfm' }] });
    expect(tags).toMatchObject({ snapshots: [{ id: 'snap1', template: 'rfm' }] });
    const dsl = CONTRACTS['gold.dsl'].params.parse({ kind: 'metric', sql: 'SELECT 1', entities: ['order'], definitionId: 'd1', trigger: 'publish' });
    expect(dsl).toMatchObject({ definitionId: 'd1', trigger: 'publish' });
  });

  it('identityExclude 拒绝非哈希的取值时，报错里不带出明文', () => {
    for (const bad of ['13800000001', 'A'.repeat(64), hash.slice(1), [hash, 1]]) {
      expect(() => CONTRACTS['silver.merge'].params.parse({ mappings: [mapping], identityExclude: bad }))
        .toThrow('参数 identityExclude 必须是哈希（64 位小写十六进制）列表');
      try {
        CONTRACTS['silver.merge'].params.parse({ mappings: [mapping], identityExclude: bad });
      } catch (e) {
        expect((e as Error).message).not.toContain('13800000001');
      }
    }
  });
});
