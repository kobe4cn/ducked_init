// 映射两个版本合并计划的差异：列的新增 / 删除 / 改动（类型、表达式、值字典、兜底、敏感标记），去重键、取最新字段、身份打通匹配字段的变化；
// 没有已发布版本时是首个版本（纯函数）
import { describe, expect, it } from 'vitest';
import type { MergePlan } from '../app/.server/pipeline/mapping-spec';
import { diffPlans } from '../app/lib/mapping-diff';

const plan = (over: Partial<MergePlan> = {}): MergePlan => ({
  entity: 'order',
  table: 'orders',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'status', type: 'string', expr: 'status', dictionary: { paid: 'paid', refunded: 'refunded' }, enum: ['paid', 'refunded', 'cancelled'], otherwise: null },
    { name: 'email', type: 'string', expr: 'email', sensitive: true },
  ],
  entityColumns: [],
  key: ['order_id'],
  latest: null,
  ...over,
});

describe('映射版本差异', () => {
  it('没有已发布版本时是首个版本', () => {
    expect(diffPlans(null, plan())).toEqual({ first: true });
  });

  it('内容相同（值字典键顺序不同、标准枚举不同）时没有差异', () => {
    const prev = plan();
    const next = plan({
      columns: prev.columns.map(c => (c.name === 'status' ? { ...c, dictionary: { refunded: 'refunded', paid: 'paid' }, enum: ['paid'] } : c)),
    });
    expect(diffPlans(prev, next)).toEqual({ first: false, added: [], removed: [], changed: [], key: null, latest: null, identity: null, keySpace: null, empty: true });
  });

  it('列出新增、删除的列和改了哪些属性的列', () => {
    const prev = plan();
    const next = plan({
      columns: [
        { name: 'order_id', type: 'integer', expr: 'order_id' },
        { name: 'status', type: 'string', expr: 'status', dictionary: { paid: 'paid', refunded: 'cancelled' }, otherwise: 'paid' },
        { name: 'amount', type: 'integer', expr: 'amount' },
      ],
    });
    expect(diffPlans(prev, next)).toMatchObject({
      first: false,
      added: ['amount'],
      removed: ['email'],
      changed: [
        { name: 'order_id', fields: ['type', 'expr'] },
        { name: 'status', fields: ['dictionary', 'otherwise'] },
      ],
      empty: false,
    });
  });

  it('敏感标记、兜底从无到有都算改动；兜底 null 与不写不同', () => {
    const prev = plan({ columns: [{ name: 'phone', type: 'string', expr: 'phone' }, { name: 'status', type: 'string', expr: 'status' }] });
    const next = plan({ columns: [{ name: 'phone', type: 'string', expr: 'phone', sensitive: true }, { name: 'status', type: 'string', expr: 'status', otherwise: null }] });
    expect(diffPlans(prev, next)).toMatchObject({ changed: [{ name: 'phone', fields: ['sensitive'] }, { name: 'status', fields: ['otherwise'] }] });
  });

  it('去重键、取最新字段、身份打通匹配字段的变化给出前后两边', () => {
    const prev = plan({ identity: { match: ['phone', 'email'] } });
    const next = plan({ key: ['order_id', 'email'], latest: 'updated_at' });
    expect(diffPlans(prev, next)).toMatchObject({
      key: { from: ['order_id'], to: ['order_id', 'email'] },
      latest: { from: null, to: 'updated_at' },
      identity: { from: ['phone', 'email'], to: null },
      empty: false,
    });
    // 匹配字段的顺序是优先级，换顺序也是变化
    expect(diffPlans(plan({ identity: { match: ['phone', 'email'] } }), plan({ identity: { match: ['email', 'phone'] } }))).toMatchObject({
      identity: { from: ['phone', 'email'], to: ['email', 'phone'] },
    });
  });

  it('映射级与字段级键空间的变化：映射的键空间给出前后两边，列上算作改了键空间', () => {
    const prev = plan();
    const next = plan({
      keySpace: 'pos',
      columns: prev.columns.map(c => (c.name === 'order_id' ? { ...c, keySpace: 'pos' } : c)),
    });
    expect(diffPlans(prev, next)).toMatchObject({ keySpace: { from: null, to: 'pos' }, changed: [{ name: 'order_id', fields: ['keySpace'] }], empty: false });
    expect(diffPlans(next, next)).toMatchObject({ keySpace: null, changed: [], empty: true });
  });
});
