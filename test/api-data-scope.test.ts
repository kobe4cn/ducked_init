// test/api-data-scope.test.ts —— API Key 数据范围的纯函数（ADR-0061「数据范围」，#975）：
// templateInScope 只认 tag:<key> / metric:<key> / rfm 三种模板，其他模板一律范围外；filterProfile 把点查结果裁到范围内，all 全开时原样返回
import { describe, expect, it } from 'vitest';
import { templateInScope, type ApiDataScope } from '../app/lib/api-data-scope';
import { filterProfile } from '../app/.server/api-data-scope';
import type { ConsumerProfile } from '../app/.server/serving-reader';

const ALL: ApiDataScope = { all: true };
const NARROW: ApiDataScope = { all: false, tags: ['milk_fans'], metrics: ['gmv_365d'], rfm: false };
const RFM_ONLY: ApiDataScope = { all: false, tags: [], metrics: [], rfm: true };

describe('templateInScope', () => {
  it('all: true 时任何模板都在范围内', () => {
    for (const template of ['tag:value_tier', 'metric:revenue', 'rfm', 'user360', 'cohort']) {
      expect(templateInScope(template, ALL)).toBe(true);
    }
  });

  it('all: false 时 tag:<key> 看 tags、metric:<key> 看 metrics、rfm 看 rfm，范围内的 key 与写法前缀完全相同', () => {
    expect(templateInScope('tag:milk_fans', NARROW)).toBe(true);
    expect(templateInScope('tag:milk', NARROW)).toBe(false); // 不是前缀匹配
    expect(templateInScope('metric:gmv_365d', NARROW)).toBe(true);
    expect(templateInScope('metric:gmv', NARROW)).toBe(false);
    expect(templateInScope('rfm', NARROW)).toBe(false); // rfm: false
    expect(templateInScope('rfm', RFM_ONLY)).toBe(true);
  });

  it('其他模板（user360 / cohort / repurchase / clv / churn）即使 rfm 开着也一律 false', () => {
    for (const template of ['user360', 'cohort', 'repurchase', 'clv', 'churn']) {
      expect(templateInScope(template, NARROW)).toBe(false);
      expect(templateInScope(template, RFM_ONLY)).toBe(false);
    }
  });

  it('jsonb 读出来缺字段时按空数组 / false 处理，不报错', () => {
    const sparse = { all: false } as ApiDataScope;
    expect(templateInScope('tag:milk_fans', sparse)).toBe(false);
    expect(templateInScope('metric:gmv_365d', sparse)).toBe(false);
    expect(templateInScope('rfm', sparse)).toBe(false);
  });
});

const profile: ConsumerProfile = {
  consumer_id: 'c1',
  requested_id: 'c1',
  serving_version: 3,
  tags: { value_tier: 'high', milk_fans: 'yes' },
  metrics: {
    gmv_365d: [{ dims: {}, value: 120 }],
    revenue: [{ dims: { city: '北京' }, value: 80 }],
  },
  rfm: { segment: '高价值', r: 5, f: 4, m: 3, recency_days: 2, frequency: 6, monetary: '99.90' },
  snapshots: [
    { id: 's1', template: 'tag:milk_fans', definitionVersion: 2, createdAt: '2026-11-01T00:00:00Z', incomplete: false },
    { id: 's2', template: 'tag:value_tier', definitionVersion: 1, createdAt: '2026-11-01T00:00:00Z', incomplete: false },
    { id: 's3', template: 'metric:gmv_365d', definitionVersion: null, createdAt: '2026-11-01T00:00:00Z', incomplete: true },
    { id: 's4', template: 'metric:revenue', definitionVersion: 4, createdAt: '2026-11-01T00:00:00Z', incomplete: false },
    { id: 's5', template: 'rfm', definitionVersion: null, createdAt: '2026-11-01T00:00:00Z', incomplete: false },
  ],
};

describe('filterProfile', () => {
  it('all: true 原样返回同一个对象', () => {
    expect(filterProfile(profile, ALL)).toBe(profile);
  });

  it('只留范围内的 tags / metrics（保持原字段顺序），rfm 为 null，snapshots 只留范围内模板的项', () => {
    const filtered = filterProfile(profile, NARROW);
    expect(filtered).not.toBe(profile);
    expect(Object.keys(filtered)).toEqual(['consumer_id', 'requested_id', 'serving_version', 'tags', 'metrics', 'rfm', 'snapshots']);
    expect(filtered.tags).toEqual({ milk_fans: 'yes' }); // value_tier 不在 tags 范围里
    expect(Object.keys(filtered.metrics)).toEqual(['gmv_365d']); // revenue 不在 metrics 范围里，顺序保持 profile 里的
    expect(filtered.metrics.gmv_365d).toEqual(profile.metrics.gmv_365d);
    expect(filtered.rfm).toBeNull(); // rfm: false
    expect(filtered.snapshots).toEqual([profile.snapshots[0], profile.snapshots[2]]); // tag:milk_fans 与 metric:gmv_365d，其余（含 rfm）都去掉
    expect(filtered.consumer_id).toBe('c1');
    expect(filtered.serving_version).toBe(3);
  });

  it('rfm 开着时 rfm 原样保留，rfm 快照也保留；范围外定义的快照即使内容有值也不出现', () => {
    const filtered = filterProfile(profile, RFM_ONLY);
    expect(filtered.tags).toEqual({});
    expect(filtered.metrics).toEqual({});
    expect(filtered.rfm).toEqual(profile.rfm);
    expect(filtered.snapshots).toEqual([profile.snapshots[4]]);
  });

  it('范围内什么都没有时 tags / metrics / snapshots 为空、rfm 为 null，不抛错', () => {
    const filtered = filterProfile(profile, { all: false, tags: ['nope'], metrics: [], rfm: false });
    expect(filtered.tags).toEqual({});
    expect(filtered.metrics).toEqual({});
    expect(filtered.rfm).toBeNull();
    expect(filtered.snapshots).toEqual([]);
  });

  it('jsonb 读出来缺字段时按空数组 / false 处理', () => {
    const filtered = filterProfile(profile, { all: false } as ApiDataScope);
    expect(filtered.tags).toEqual({});
    expect(filtered.metrics).toEqual({});
    expect(filtered.rfm).toBeNull();
    expect(filtered.snapshots).toEqual([]);
  });
});
