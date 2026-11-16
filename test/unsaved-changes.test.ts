// test/unsaved-changes.test.ts —— 新建定义页「有没有还没保存的内容」的判断（app/lib/unsaved-changes.ts，纯函数，#797）：
// 快照只取 key / yaml / form / sentence / request 五个字段（固定顺序），intent、kind 等其余字段不参与——切换按钮的 intent 不算改动；
// 有 action 回显时一律算有未保存内容（本页的 action 只有保存成功才跳走，回显的都是还没保存的）；
// 否则与基线比：改了键、YAML 或构建器隐藏字段 form（构建器的增删行按钮不触发 change 事件，靠比较它的值记脏）为真，一致为假；还没有基线（表单没挂载）不算有
import { describe, expect, it } from 'vitest';
import { hasUnsavedChanges, snapshotOf } from '../app/lib/unsaved-changes';

const data = (entries: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(entries)) form.append(name, value);
  return form;
};

describe('snapshotOf', () => {
  it('只取 key / yaml / form / sentence / request，按固定顺序 JSON 序列化；intent、kind 等其余字段不参与', () => {
    expect(snapshotOf(data({ key: 'rev', yaml: 'base: order\n', intent: 'to-builder', kind: 'metric', parsed: '{}' })))
      .toBe(snapshotOf(data({ key: 'rev', yaml: 'base: order\n' })));
    expect(snapshotOf(data({ key: 'rev', yaml: 'base: order\n' }))).toBe('["rev","base: order\\n",null,null,null]');
  });
});

describe('hasUnsavedChanges', () => {
  const baseline = snapshotOf(data({ key: 'rev', yaml: 'base: order\n', form: '', sentence: '', request: '' }));

  it('有 action 回显时一律为真：回显的都是还没保存的内容，与基线一致也算', () => {
    expect(hasUnsavedChanges({ echoed: true, baseline, current: baseline })).toBe(true);
  });

  it('改了键、YAML 或构建器隐藏字段 form（增删行不走 change 事件）为真', () => {
    expect(hasUnsavedChanges({ echoed: false, baseline, current: snapshotOf(data({ key: 'other', yaml: 'base: order\n', form: '', sentence: '', request: '' })) })).toBe(true);
    expect(hasUnsavedChanges({ echoed: false, baseline, current: snapshotOf(data({ key: 'rev', yaml: 'base: customer\n', form: '', sentence: '', request: '' })) })).toBe(true);
    expect(hasUnsavedChanges({ echoed: false, baseline, current: snapshotOf(data({ key: 'rev', yaml: 'base: order\n', form: '{"base":"order","agg":"count"}', sentence: '', request: '' })) })).toBe(true);
  });

  it('改了「一句话」或需求框同样为真', () => {
    expect(hasUnsavedChanges({ echoed: false, baseline, current: snapshotOf(data({ key: 'rev', yaml: 'base: order\n', form: '', sentence: '近 30 天的金额合计', request: '' })) })).toBe(true);
    expect(hasUnsavedChanges({ echoed: false, baseline, current: snapshotOf(data({ key: 'rev', yaml: 'base: order\n', form: '', sentence: '', request: '近 30 天的金额合计' })) })).toBe(true);
  });

  it('与基线一致为假；还没有基线（表单没挂载）也不算有未保存内容', () => {
    expect(hasUnsavedChanges({ echoed: false, baseline, current: baseline })).toBe(false);
    expect(hasUnsavedChanges({ echoed: false, baseline: undefined, current: baseline })).toBe(false);
  });
});
