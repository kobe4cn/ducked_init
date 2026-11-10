// test/prune-seaweed-iam-policies.test.ts —— policies.json 孤儿内联策略清理的纯函数：只删账号不存在的那一侧，别的字段一律不动
import { describe, expect, it } from 'vitest';
import { prunePolicies } from '../scripts/prune-seaweed-iam-policies';

const doc = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::crm-lake/a/*'] }] };

describe('prunePolicies', () => {
  it('删掉账号已不存在的内联策略，现存账号的条目原样保留', () => {
    const collection = {
      policies: {},
      inlinePolicies: {
        'lake-gone': { 'tenant-lake': doc },
        'lake-01e91650': { 'tenant-lake': doc },
        'src-rw-gone': { source: doc },
      },
    };
    const { pruned, removedUsers } = prunePolicies(collection, new Set(['lake-01e91650']));
    expect(removedUsers).toEqual(['lake-gone', 'src-rw-gone']);
    expect(Object.keys(pruned.inlinePolicies ?? {})).toEqual(['lake-01e91650']);
    expect(pruned.inlinePolicies).toEqual({ 'lake-01e91650': collection.inlinePolicies['lake-01e91650'] });
  });

  it('没有 inlinePolicies、空的 inlinePolicies 或它不是对象时，原样返回且没有可删条目', () => {
    expect(prunePolicies({}, new Set(['a']))).toEqual({ pruned: {}, removedUsers: [] });
    expect(prunePolicies({ policies: {} }, new Set())).toEqual({ pruned: { policies: {} }, removedUsers: [] });
    expect(prunePolicies({ inlinePolicies: {} }, new Set())).toEqual({ pruned: { inlinePolicies: {} }, removedUsers: [] });
    expect(prunePolicies({ inlinePolicies: '坏数据' }, new Set(['a'])))
      .toEqual({ pruned: { inlinePolicies: '坏数据' }, removedUsers: [] });
  });

  it('inlinePolicies 之外的字段（policies、groupInlinePolicies、未知的键）原样保留', () => {
    const collection = {
      policies: { managed: doc },
      groupInlinePolicies: { 'eng-group': { x: doc } },
      unknown: { 保持: true },
      inlinePolicies: { 'lake-gone': { 'tenant-lake': doc } },
    };
    const { pruned, removedUsers } = prunePolicies(collection, new Set(['无关账号']));
    expect(removedUsers).toEqual(['lake-gone']);
    expect(pruned.policies).toBe(collection.policies);
    expect(pruned.groupInlinePolicies).toBe(collection.groupInlinePolicies);
    expect(pruned.unknown).toBe(collection.unknown);
    expect(pruned.inlinePolicies).toEqual({});
  });

  it('全部条目都属于现存账号时没有可删条目，返回原对象', () => {
    const collection = { inlinePolicies: { 'lake-a': { 'tenant-lake': doc } } };
    expect(prunePolicies(collection, new Set(['lake-a']))).toEqual({ pruned: collection, removedUsers: [] });
  });
});
