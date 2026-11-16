// test/pipeline/model-draft.test.ts —— 模型输出转映射 YAML（纯函数，ADR-0035）：以规则草稿为底换掉 fields / dedupe / identity，字典数组转对象，理由成行尾注释；
// 个别项不过校验时去掉这些项（退回规则草稿里的同名项，没有就删掉）；模型建议的断言只换 assertions 块
import { parse, parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { assertionsToYaml, dropItems, modelOutputToYaml, type AssertionDraft, type ModelDraft } from '../../app/.server/pipeline/model-draft';
import type { MappingIssue } from '../../app/.server/pipeline/mapping-spec';
import { readForm } from '../../app/lib/mapping-form';
import { entityOf } from '../../app/lib/canonical-model';

const RULES = `# 按规则生成的草稿
model: 1
entity: order
table: orders
fields:
  order_id: string(order_id) # 同名列
  status: { expr: status, dictionary: { paid: paid, refunded: null } }
dedupe:
  key: [order_id]
extensions:
  x_note: { type: string, expr: note }
# 没有对应上的标准字段：
#   channel
`;

const OUT: ModelDraft = {
  fields: [
    { field: 'order_id', expr: 'string(order_id)', confidence: 0.95, reason: '源表主键\n与实体主键同名' },
    { field: 'status', expr: 'status', dictionary: [{ from: 'paid', to: 'paid' }, { from: 'refunded', to: 'refunded' }], otherwise: null, confidence: 0.8, reason: '常见取值 paid / refunded' },
    { field: 'amount', expr: 'amount', confidence: 0.6, reason: '金额列' },
  ],
};

describe('模型输出转映射 YAML', () => {
  it('保留 table、entity、extensions 等顶层键，fields 整体换成模型给的，字典数组转成对象', () => {
    const { yaml } = modelOutputToYaml(RULES, OUT);
    const spec = parse(yaml);
    expect(spec).toMatchObject({ model: 1, entity: 'order', table: 'orders', extensions: { x_note: { type: 'string', expr: 'note' } } });
    expect(spec.fields).toEqual({
      order_id: 'string(order_id)',
      status: { expr: 'status', dictionary: { paid: 'paid', refunded: 'refunded' }, otherwise: null },
      amount: 'amount',
    });
    expect(yaml).toMatch(/^# 模型生成的草稿/);
    expect(yaml).not.toContain('按规则生成');
    expect(yaml).not.toContain('没有对应上的标准字段');
  });

  it('没给 dedupe / identity 时删掉规则草稿里的，给了时写入；items 记下每项的置信度与理由', () => {
    expect(parse(modelOutputToYaml(RULES, OUT).yaml)).not.toHaveProperty('dedupe');
    const { yaml, items } = modelOutputToYaml(RULES, {
      ...OUT,
      dedupe: { key: ['order_id', 'amount'], latest: 'amount', confidence: 0.5, reason: '同一订单多行' },
      identity: { match: ['order_id'], confidence: 0.3, reason: '试试' },
    });
    expect(parse(yaml)).toMatchObject({ dedupe: { key: ['order_id', 'amount'], latest: 'amount' }, identity: { match: ['order_id'] } });
    expect(yaml).toContain('key: [ order_id, amount ] # 同一订单多行');
    expect(items).toEqual([
      { path: 'fields.order_id', confidence: 0.95, reason: '源表主键\n与实体主键同名' },
      { path: 'fields.status', confidence: 0.8, reason: '常见取值 paid / refunded' },
      { path: 'fields.amount', confidence: 0.6, reason: '金额列' },
      { path: 'dedupe', confidence: 0.5, reason: '同一订单多行' },
      { path: 'identity', confidence: 0.3, reason: '试试' },
    ]);
  });

  it('理由写成表达式的行尾注释（换行压成一行），表单把它显示为依据', () => {
    const { yaml } = modelOutputToYaml(RULES, OUT);
    expect(yaml).toContain('order_id: string(order_id) # 源表主键 与实体主键同名');
    const form = readForm(parseDocument(yaml), entityOf('order')!);
    expect(form.find(f => f.field === 'status')?.basis).toBe('常见取值 paid / refunded');
    expect(form.find(f => f.field === 'amount')?.basis).toBe('金额列');
  });
});

describe('校验问题落在个别项时去掉这些项', () => {
  const issue = (path: string, message: string): MappingIssue => ({ line: 2, col: 3, path, message });

  /** 规则草稿里带 identity 的版本（identity 退回规则草稿用） */
  const RULES_ID = `# 按规则生成的草稿
model: 1
entity: order
table: orders
fields:
  order_id: string(order_id) # 同名列
  status: { expr: status, dictionary: { paid: paid, refunded: null } }
identity:
  match: [email]
`;

  const OUT_FULL: ModelDraft = {
    ...OUT,
    dedupe: { key: ['amount'], latest: 'amount', confidence: 0.5, reason: '同一订单多行' },
    identity: { match: ['order_id'], confidence: 0.3, reason: '试试' },
  };

  it('字段的问题：用规则草稿里的同名字段替换，模型其余字段与行尾理由保留；items 对应项保留置信度与理由、另带 dropped', () => {
    const { yaml, items } = modelOutputToYaml(RULES, OUT);
    const dropped = dropItems(RULES, yaml, items, [issue('fields.status.dictionary', 'refunded 不是标准取值')])!;
    expect(dropped).not.toBeNull();
    // status 退回规则草稿里的写法（refunded 的兜底是 null），其余照旧
    expect(parse(dropped.yaml).fields).toEqual({
      order_id: 'string(order_id)',
      status: { expr: 'status', dictionary: { paid: 'paid', refunded: null } },
      amount: 'amount',
    });
    expect(dropped.yaml).toContain('order_id: string(order_id) # 源表主键 与实体主键同名');
    expect(dropped.yaml).toContain('amount: amount # 金额列');
    expect(dropped.items).toEqual([
      { path: 'fields.order_id', confidence: 0.95, reason: '源表主键\n与实体主键同名' },
      { path: 'fields.status', confidence: 0.8, reason: '常见取值 paid / refunded', dropped: 'refunded 不是标准取值' },
      { path: 'fields.amount', confidence: 0.6, reason: '金额列' },
    ]);
  });

  it('规则草稿没有这个字段时删掉；同一项有多条问题时消息用「；」连接', () => {
    const { yaml, items } = modelOutputToYaml(RULES, OUT);
    const dropped = dropItems(RULES, yaml, items, [issue('fields.amount.expr', 'no_such_col 列不存在'), issue('fields.amount', 'amount 不能是文本')])!;
    expect(parse(dropped.yaml).fields).toEqual({
      order_id: 'string(order_id)',
      status: { expr: 'status', dictionary: { paid: 'paid', refunded: 'refunded' }, otherwise: null },
    });
    expect(dropped.items[2]).toEqual({ path: 'fields.amount', confidence: 0.6, reason: '金额列', dropped: 'no_such_col 列不存在；amount 不能是文本' });
  });

  it('identity 退回规则草稿里的；dedupe / identity 在规则草稿里没有时删掉', () => {
    // RULES_ID 没有 dedupe、有 identity：identity 退回规则草稿，dedupe 删掉
    const a = modelOutputToYaml(RULES_ID, OUT_FULL);
    const reverted = dropItems(RULES_ID, a.yaml, a.items, [issue('identity.match.0', '匹配字段 order_id 不是敏感字段')])!;
    expect(parse(reverted.yaml).identity).toEqual({ match: ['email'] });
    const deleted = dropItems(RULES_ID, a.yaml, a.items, [issue('dedupe.latest', '取最新字段 amount 应为时间、日期或数字')])!;
    expect(parse(deleted.yaml)).not.toHaveProperty('dedupe');
    expect(deleted.items[3]).toMatchObject({ path: 'dedupe', dropped: '取最新字段 amount 应为时间、日期或数字' });

    // RULES 有 dedupe、没有 identity：dedupe 退回规则草稿，identity 删掉
    const b = modelOutputToYaml(RULES, OUT_FULL);
    const both = dropItems(RULES, b.yaml, b.items, [issue('dedupe.latest', '取最新字段 amount 应为时间、日期或数字'), issue('identity', '只有消费者（customer）映射能配置身份打通的匹配规则')])!;
    const spec = parse(both.yaml);
    expect(spec.dedupe).toEqual({ key: ['order_id'] });
    expect(spec).not.toHaveProperty('identity');
    expect(both.items[4]).toMatchObject({ path: 'identity', dropped: '只有消费者（customer）映射能配置身份打通的匹配规则' });
  });

  it('有定位不到 fields.<字段>、dedupe、identity 的问题时返回 null（整份不采用）', () => {
    const { yaml, items } = modelOutputToYaml(RULES, OUT);
    for (const path of ['fields', 'entity', 'key_space', 'where', '']) {
      expect(dropItems(RULES, yaml, items, [issue(path, '问题')])).toBeNull();
    }
    // 与可定位的问题混在一起也一样
    expect(dropItems(RULES, yaml, items, [issue('fields.amount.expr', '列不存在'), issue('where', 'where 必须是返回布尔的表达式')])).toBeNull();
  });
});

const MAPPING = `# 已发布映射的头注释
model: 1
entity: order
table: orders
fields:
  order_id: string(order_id) # 主键
  amount: amount
assertions:
  - { field: order_id, check: unique, level: error }
# 末尾注释
`;

const SUGGESTED: AssertionDraft = {
  assertions: [
    { field: 'order_id', check: 'not_null', level: 'error', confidence: 0.95, reason: '主键\n空值率 0' },
    { field: 'amount', check: 'range', level: 'warn', min: 0, max: 50000, confidence: 0.6, reason: '列统计 min 0、max 4999' },
  ],
};

describe('模型建议的断言转映射 YAML', () => {
  it('只换掉 assertions 块，其他键与注释保留；理由写成行尾注释，items 的位置是 assertions.<i>', () => {
    const { yaml, items } = assertionsToYaml(MAPPING, SUGGESTED);
    const spec = parse(yaml);
    expect(spec).toMatchObject({ model: 1, entity: 'order', table: 'orders', fields: { order_id: 'string(order_id)', amount: 'amount' } });
    expect(spec.assertions).toEqual([
      { field: 'order_id', check: 'not_null', level: 'error' },
      { field: 'amount', check: 'range', level: 'warn', min: 0, max: 50000 },
    ]);
    expect(yaml).toMatch(/^# 已发布映射的头注释/);
    expect(yaml).toContain('order_id: string(order_id) # 主键');
    expect(yaml).toContain('# 主键 空值率 0');
    expect(yaml).toContain('# 末尾注释');
    expect(items).toEqual([
      { path: 'assertions.0', confidence: 0.95, reason: '主键\n空值率 0' },
      { path: 'assertions.1', confidence: 0.6, reason: '列统计 min 0、max 4999' },
    ]);
  });

  it('in 带 values；模型没给断言时删掉 assertions 块', () => {
    const { yaml } = assertionsToYaml(MAPPING, { assertions: [{ field: 'status', check: 'in', level: 'warn', values: ['paid', 'refunded'], confidence: 0.8, reason: '常见取值' }] });
    expect(parse(yaml).assertions).toEqual([{ field: 'status', check: 'in', level: 'warn', values: ['paid', 'refunded'] }]);
    expect(parse(assertionsToYaml(MAPPING, { assertions: [] }).yaml)).not.toHaveProperty('assertions');
  });
});
