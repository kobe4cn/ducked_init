// 新建映射换选数据源 / 表 / 实体时编辑框内容的替换决定（纯函数）：换普通表给「按新表与实体取规则草稿」的指令（要走 action，不在这里生成），
// 换源视图给所选实体的空白模板（`view:` 指向所选视图、首行注释写「源视图」，自定义实体写所选实体名、fields 下提示手写，不回退成第一个标准实体），
// 上一个表 / 实体的字段与「按规则生成的草稿：源表 …」注释不再出现；编辑框内容与上次生成的一致（没手改过）时不要求确认；
// mappingTemplate（迁自服务端模块）与 withTarget（迁自路由）输出不变
import { describe, expect, it } from 'vitest';
import { applyDraft, mappingTemplate, reselect, VIEW_PREFIX, viewTemplate, withTarget } from '../app/lib/mapping-template';

/** 第一个数据源按规则生成的 consent 草稿：换选前编辑框里的内容（issue #776 的现场） */
const CONSENT_DRAFT = `# 按规则生成的草稿：源表 consents → 营销同意（consent）
model: 1
entity: consent
table: consents
fields:
  customer_id: string(customer_id)
  channel: channel
  status: status
  granted_at: granted_at
dedupe:
  key: [customer_id, channel]
`;

describe('mappingTemplate（迁自 mapping-spec，输出不变）', () => {
  it('样例文档：首行注释写「源表」，实体、前四个字段与去重键', () => {
    expect(mappingTemplate('order', 'orders')).toBe(`# 映射：源表 orders → 订单（order）
model: 1
entity: order
table: orders
fields:
  order_id: order_id
  customer_id: customer_id
  status: status  # 标准枚举：created、paid、shipped、completed、cancelled、refunded
  amount: amount
dedupe:
  key: [order_id]
`);
  });

  it('认不出的实体回退成第一个标准实体（loader 的既有行为）', () => {
    expect(mappingTemplate('custom_store', 't')).toContain('entity: customer');
  });
});

describe('viewTemplate 源视图的空白模板', () => {
  it('标准实体：首行注释写「源视图」、view 指向所选视图，字段是所选实体的前四个', () => {
    const yaml = viewTemplate('customer', 'jd_buyers');
    expect(yaml).toMatch(/^# 映射：源视图 jd_buyers → 消费者（customer）\n/);
    expect(yaml).toContain('entity: customer');
    expect(yaml).toContain('view: jd_buyers');
    expect(yaml).not.toContain('table:');
    expect(yaml).toContain('customer_id: customer_id');
    expect(yaml).toContain('dedupe:\n  key: [customer_id]');
  });

  it('自定义实体：写所选实体名、fields 下提示手写，不回退成第一个标准实体', () => {
    const yaml = viewTemplate('custom_buyer', 'jd_buyers');
    expect(yaml).toContain('entity: custom_buyer');
    expect(yaml).not.toContain('entity: customer');
    expect(yaml).toMatch(/fields:\n  # /);
  });
});

describe('reselect 换选后编辑框的去向', () => {
  const yamlOf = (next: ReturnType<typeof reselect>['next']) => (next.kind === 'template' ? next.yaml : '');

  it('普通表：给按新表与实体取规则草稿的指令，带走 sourceId / table / entity', () => {
    expect(reselect({ sourceId: 'jd', input: 'buyers', entity: 'customer', yaml: CONSENT_DRAFT, lastGenerated: CONSENT_DRAFT }))
      .toEqual({ needsConfirm: false, next: { kind: 'fetch-draft', sourceId: 'jd', table: 'buyers', entity: 'customer' } });
  });

  it('源视图：给所选实体的空白模板，不残留上一个实体的字段与「源表 …」注释', () => {
    const { next } = reselect({ sourceId: 'jd', input: `${VIEW_PREFIX}jd_buyers`, entity: 'customer', yaml: CONSENT_DRAFT, lastGenerated: CONSENT_DRAFT });
    expect(next).toEqual({ kind: 'template', yaml: viewTemplate('customer', 'jd_buyers') });
    for (const stale of ['channel: channel', 'status: status', 'granted_at: granted_at', '源表 consents', '按规则生成的草稿'])
      expect(yamlOf(next)).not.toContain(stale);
  });

  it('没手改过（yaml 与上次生成的一致）不要求确认；手改过要确认（表与源视图都一样）', () => {
    const untouched = { sourceId: 'jd', entity: 'customer', yaml: CONSENT_DRAFT, lastGenerated: CONSENT_DRAFT };
    expect(reselect({ ...untouched, input: 'buyers' }).needsConfirm).toBe(false);
    expect(reselect({ ...untouched, input: `${VIEW_PREFIX}jd_buyers` }).needsConfirm).toBe(false);
    const edited = { ...untouched, yaml: `${CONSENT_DRAFT}  revoked_at: revoked_at\n` };
    expect(reselect({ ...edited, input: 'buyers' }).needsConfirm).toBe(true);
    expect(reselect({ ...edited, input: `${VIEW_PREFIX}jd_buyers` }).needsConfirm).toBe(true);
  });
});

describe('applyDraft 规则草稿回来时要不要先确认', () => {
  it('请求发出后编辑框没再改过时直接替换，取草稿在途期间手改过则先确认', () => {
    expect(applyDraft({ yaml: CONSENT_DRAFT, yamlAtRequest: CONSENT_DRAFT }).needsConfirm).toBe(false);
    expect(applyDraft({ yaml: `${CONSENT_DRAFT}  pin: pin\n`, yamlAtRequest: CONSENT_DRAFT }).needsConfirm).toBe(true);
  });
});

describe('withTarget 原位改写 table / view / entity（迁自路由）', () => {
  it('换成视图时原地改键名，换成实体只改实体行，其余内容与注释保留', () => {
    const asView = withTarget(CONSENT_DRAFT, 'view', 'jd_buyers');
    expect(asView).toContain('view: jd_buyers');
    expect(asView).not.toContain('table: consents');
    expect(asView).toContain('# 按规则生成的草稿');
    expect(withTarget(asView, 'entity', 'customer')).toContain('entity: customer');
  });

  it('换成表时删掉 view_key，YAML 解析不了时不动', () => {
    expect(withTarget(withTarget(CONSENT_DRAFT, 'view', 'jd_buyers') + 'view_key: pos\n', 'table', 'buyers')).not.toContain('view_key');
    const broken = '# 没冒号的内容\n';
    expect(withTarget(broken, 'entity', 'customer')).toBe(broken);
  });
});
