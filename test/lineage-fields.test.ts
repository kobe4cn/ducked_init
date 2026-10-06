// test/lineage-fields.test.ts —— 数据地图的标准层表字段抽屉：一张标准层表每个字段在各已发布映射里的源表、源列与表达式，敏感哈希、值字典、扩展字段与兜底标记，
// 兜底的字段附上最近一次合并的兜底统计；给查看者的只留字段说明（纯函数）
import { describe, expect, it } from 'vitest';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';
import { deriveLineage } from '../app/lib/lineage';
import { entityFields, redactFields } from '../app/lib/lineage-fields';

const plan = (over: Partial<MergeMappingParam> = {}): MergeMappingParam => ({
  mapping: 'm-order',
  version: 3,
  sourceId: 's-shop',
  entity: 'order',
  table: 'orders',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'status', type: 'string', expr: 'status', dictionary: { paid: 'paid' }, enum: ['paid', 'refunded', 'cancelled'], otherwise: null },
    { name: 'total_amount', type: 'decimal', expr: 'coalesce(amount, 0) - discount + amount' },
    { name: 'x_buyer_phone', type: 'string', expr: 'phone', sensitive: true },
  ],
  entityColumns: [],
  key: ['order_id'],
  latest: null,
  ...over,
});

const sources = [
  { id: 's-shop', name: '商城', kind: 'postgres' },
  { id: 's-erp', name: 'ERP', kind: 'mysql' },
];

const plans = [
  plan(),
  plan({
    mapping: 'm-erp-order', version: 1, sourceId: 's-erp', table: 'sales',
    columns: [
      { name: 'order_id', type: 'string', expr: 'no' },
      { name: 'status', type: 'string', expr: 'state', enum: ['paid', 'refunded', 'cancelled'], otherwise: 'cancelled' },
    ],
  }),
  plan({
    mapping: 'm-store', version: 2, sourceId: 's-erp', entity: 'custom_store', table: 'stores',
    columns: [{ name: 'store_id', type: 'string', expr: 'id' }, { name: 'x_region', type: 'string', expr: 'region' }],
    key: ['store_id'],
  }),
];

const lineage = deriveLineage({ plans, sources });
const declared = [
  { name: 'order_id', label: '订单号', description: '订单的唯一编号' },
  { name: 'customer_id', label: '消费者', description: '下单的消费者' },
  { name: 'status', label: '订单状态', description: '支付、退款或取消' },
  { name: 'total_amount', label: '订单金额', description: '实付金额' },
];

describe('标准层表字段抽屉', () => {
  it('按实体登记的顺序列出映射到的字段（没有映射到的不列，扩展字段排在后面），每个字段带各映射的源表、源列与表达式和几类标记', () => {
    const fields = entityFields(lineage, 'order', declared, {});
    expect(fields.map(f => f.name)).toEqual(['order_id', 'status', 'total_amount', 'x_buyer_phone']);
    const by = (name: string) => fields.find(f => f.name === name)!;

    expect(by('order_id')).toMatchObject({ label: '订单号', description: '订单的唯一编号' });
    expect(by('order_id').sources).toEqual([
      { mapping: 'm-erp-order', version: 1, sourceName: 'ERP', table: 'sales', expr: 'no', sourceColumns: ['no'], sensitive: false, dictionary: false, extension: false, fallback: null },
      { mapping: 'm-order', version: 3, sourceName: '商城', table: 'orders', expr: 'string(order_id)', sourceColumns: ['order_id'], sensitive: false, dictionary: false, extension: false, fallback: null },
    ]);
    expect(by('total_amount').sources[0]).toMatchObject({ sourceColumns: ['amount', 'discount'] });
    expect(by('x_buyer_phone')).toMatchObject({ label: 'x_buyer_phone', description: '' });
    expect(by('x_buyer_phone').sources[0]).toMatchObject({ sensitive: true, extension: true });

    // 兜底：otherwise: null 是写成空；还没有合并过就没有统计
    expect(by('status').sources.map(s => [s.mapping, s.dictionary, s.fallback])).toEqual([
      ['m-erp-order', false, { value: 'cancelled', stat: null }],
      ['m-order', true, { value: null, stat: null }],
    ]);
    // 值字典只标出有，不输出字典内容
    expect(JSON.stringify(fields)).not.toContain('"paid"');
  });

  it('兜底的字段附上最近一次合并的兜底统计（行数、不同取值数与出现最多的取值）', () => {
    const stat = { column: 'status', values: [{ value: '已关闭', rows: 7 }, { value: '作废', rows: 2 }], distinct: 2, rows: 9 };
    const fields = entityFields(lineage, 'order', declared, { 'm-order': [stat, { column: 'other', values: [], distinct: 0, rows: 0 }] });
    const status = fields.find(f => f.name === 'status')!;
    expect(status.sources.find(s => s.mapping === 'm-order')!.fallback).toEqual({
      value: null, stat: { rows: 9, distinct: 2, values: [{ value: '已关闭', rows: 7 }, { value: '作废', rows: 2 }] },
    });
    expect(status.sources.find(s => s.mapping === 'm-erp-order')!.fallback).toEqual({ value: 'cancelled', stat: null });
  });

  it('自定义实体的字段说明取自实体登记，x_ 开头的列不算扩展字段；给查看者的只留字段名、名称与说明', () => {
    const fields = entityFields(lineage, 'custom_store', [{ name: 'store_id', description: '门店编号' }, { name: 'x_region', description: '大区' }], {});
    expect(fields.map(f => [f.name, f.label, f.description])).toEqual([['store_id', 'store_id', '门店编号'], ['x_region', 'x_region', '大区']]);
    expect(fields[1].sources[0]).toMatchObject({ extension: false, table: 'stores' });

    const redacted = redactFields(fields);
    expect(redacted).toEqual([
      { name: 'store_id', label: 'store_id', description: '门店编号' },
      { name: 'x_region', label: 'x_region', description: '大区' },
    ]);
    expect(JSON.stringify(redacted)).not.toMatch(/stores|ERP|sources/);
  });

  it('没有映射到的实体没有字段', () => {
    expect(entityFields(lineage, 'product', declared, {})).toEqual([]);
  });
});
