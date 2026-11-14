// test/pipeline/merge-queued.test.ts —— 补进排队中的合并的纯函数 mergeQueued（#485，ADR-0053，不连库）：同一映射换成 incoming 的
// 版本、排队中已带 rebuild 的给补进来的补上、drop 并在一起去重（重复时保留排队中的那条）且排队中被撤下的映射剔除
// （incoming 自己的映射不剔除——恢复映射时撤下它的合并还在排队，要同时带 drop 与它的重建，ADR-0031/#195）、
// identityForce 取或、结果按映射 ID 码点排序、identity 与 survivorship 等整体取 incoming 的
import { describe, expect, it } from 'vitest';
import { mergeQueued } from '../../app/.server/merges';
import type { MergeMappingParam, MergeParams } from '../../app/.server/pipeline/task-contracts';

/** 造一个映射参数：给最小可用的合并计划字段，over 覆盖（区分版本、rebuild 等） */
const mapping = (id: string, over: Partial<MergeMappingParam> = {}): MergeMappingParam => ({
  mapping: id, version: 1, sourceId: 'src', entity: 'customer', table: `t_${id}`,
  columns: [{ name: 'id', type: 'string', expr: 'id' }], entityColumns: [{ name: 'id', type: 'string' }],
  key: ['id'], latest: null, ...over,
});

/** 造一份合并参数：全部字段给全（updateQueuedParams parse 后的形状），over 覆盖 */
const params = (over: Partial<MergeParams> = {}): MergeParams => ({
  mappings: [], drop: [], identity: ['email'], relations: [], identityForce: false,
  consumerSensitive: [], survivorship: { m1: 1 }, identityExclude: [], ...over,
});

describe('补进排队中的合并 mergeQueued', () => {
  it('同一映射换成 incoming 的版本，排队中别的映射保留', () => {
    const merged = mergeQueued(
      params({ mappings: [mapping('m1', { version: 1 }), mapping('m2')] }),
      params({ mappings: [mapping('m1', { version: 2 })] }),
    );
    expect(merged.mappings).toEqual([mapping('m1', { version: 2 }), mapping('m2')]);
  });

  it('排队中的同一映射已带 rebuild 时补进来的也带，incoming 自己带的保留', () => {
    expect(mergeQueued(
      params({ mappings: [mapping('m1', { rebuild: true })] }),
      params({ mappings: [mapping('m1')] }),
    ).mappings).toEqual([mapping('m1', { rebuild: true })]);
    expect(mergeQueued(
      params({ mappings: [mapping('m1')] }),
      params({ mappings: [mapping('m1', { rebuild: true })] }),
    ).mappings).toEqual([mapping('m1', { rebuild: true })]);
  });

  it('drop 并在一起，同一映射去重时保留排队中的那条，排队中被撤下的映射剔除', () => {
    const merged = mergeQueued(
      params({ mappings: [mapping('d2'), mapping('m2')], drop: [{ mapping: 'd1', entity: 'customer' }] }),
      params({ mappings: [mapping('m1')], drop: [{ mapping: 'd1', entity: 'order' }, { mapping: 'd2', entity: 'order' }] }),
    );
    expect(merged.drop).toEqual([{ mapping: 'd1', entity: 'customer' }, { mapping: 'd2', entity: 'order' }]);
    expect(merged.mappings).toEqual([mapping('m1'), mapping('m2')]);
  });

  it('incoming 的映射同时在 drop 里时不剔除（撤下它的合并还在排队时恢复映射）', () => {
    const merged = mergeQueued(
      params({ drop: [{ mapping: 'd1', entity: 'order' }] }),
      params({ mappings: [mapping('m1'), mapping('d1', { entity: 'order' })], drop: [{ mapping: 'd1', entity: 'order' }] }),
    );
    expect(merged.mappings).toEqual([mapping('d1', { entity: 'order' }), mapping('m1')]);
  });

  it('identityForce 取或', () => {
    expect(mergeQueued(params(), params()).identityForce).toBe(false);
    expect(mergeQueued(params({ identityForce: true }), params()).identityForce).toBe(true);
    expect(mergeQueued(params(), params({ identityForce: true })).identityForce).toBe(true);
    expect(mergeQueued(params({ identityForce: true }), params({ identityForce: true })).identityForce).toBe(true);
  });

  it('结果按映射 ID 码点排序（M10 < M2 < Z1 < a1），identity、survivorship 等整体取 incoming 的', () => {
    const merged = mergeQueued(
      params({ mappings: [mapping('M2'), mapping('a1')], identity: ['phone'], survivorship: { old: 2 }, consumerSensitive: ['phone'], identityExclude: ['f'.repeat(64)] }),
      params({ mappings: [mapping('M10'), mapping('Z1')], identity: ['email'], survivorship: { m1: 1 }, consumerSensitive: ['email_1'], identityExclude: ['a'.repeat(64)] }),
    );
    expect(merged.mappings.map(m => m.mapping)).toEqual(['M10', 'M2', 'Z1', 'a1']);
    expect(merged.identity).toEqual(['email']);
    expect(merged.survivorship).toEqual({ m1: 1 });
    expect(merged.consumerSensitive).toEqual(['email_1']);
    expect(merged.identityExclude).toEqual(['a'.repeat(64)]);
  });
});
