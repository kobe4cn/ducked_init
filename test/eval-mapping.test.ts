// test/eval-mapping.test.ts —— 映射评测（#217，ADR-0035）：黄金集的期望 YAML 都能对着自己的表统计过校验、四类样例都有；
// runCase 用假 fetch 跑出的准确率与人工改动项数：与期望一致、改一个表达式少一列、不合 Schema、不过校验时的问题清单（脱敏）（纯函数，不读库）
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { setLlmFetch } from '../app/.server/llm';
import { checkMapping, type FieldSpec } from '../app/.server/pipeline/mapping-spec';
import type { ModelDraft, ModelField } from '../app/.server/pipeline/model-draft';
import { GOLDEN, type GoldenCase } from '../scripts/eval-mapping/golden';
import { redactIssues, runCase, summarize } from '../scripts/eval-mapping/score';
import { fakeLlm, json } from './pipeline/llm-fixtures';

afterEach(() => { setLlmFetch(undefined); });

const PROVIDER = { baseUrl: 'https://llm.example.com/v1', model: 'test-model', apiKey: 'sk-eval-secret', source: 'platform' as const };

/** 期望 YAML 原样转成模型输出：字段、值字典与 dedupe */
function perfectDraft(c: GoldenCase): ModelDraft {
  const spec = parse(c.expectedYaml) as { fields: Record<string, FieldSpec>; dedupe?: { key: string[]; latest?: string } };
  const fields = Object.entries(spec.fields).map(([field, raw]): ModelField => {
    const f = typeof raw === 'string' ? { expr: raw } : raw;
    return {
      field, expr: f.expr, confidence: 0.9, reason: '依据',
      ...(f.dictionary && { dictionary: Object.entries(f.dictionary).map(([from, to]) => ({ from, to })) }),
    };
  });
  return { fields, ...(spec.dedupe && { dedupe: { ...spec.dedupe, confidence: 0.8, reason: '有重复' } }) };
}

const caseNamed = (name: string) => GOLDEN.find(c => c.name === name)!;

describe('映射黄金集', () => {
  it('期望 YAML 都能对着自己的表统计过校验，四类样例都有', () => {
    for (const c of GOLDEN) {
      const r = checkMapping(c.expectedYaml, () => c.profile.columns.map(({ name, type }) => ({ name, type })));
      expect(r.ok ? [] : r.issues, c.name).toEqual([]);
    }
    expect(GOLDEN.length).toBeGreaterThanOrEqual(5);
    expect(new Set(GOLDEN.flatMap(c => c.kinds))).toEqual(new Set(['rename', 'cents', 'status_enum', 'dedupe']));
  });
});

describe('映射评测跑分', () => {
  it('模型输出与期望一致：准确率 1、改动 0', async () => {
    const c = caseNamed('dedupe-orders');
    const { f } = fakeLlm(setLlmFetch, () => json(perfectDraft(c)));
    const r = await runCase(c, PROVIDER);
    expect(r).toEqual({ name: 'dedupe-orders', accuracy: 1, correct: 7, expected: 7, edits: 0 });
    // 不带样本行
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(JSON.parse(body.messages[1].content).table).not.toHaveProperty('samples');
  });

  it('改一个表达式、少一列、没给去重：准确率与改动项数照差异算', async () => {
    const c = caseNamed('dedupe-orders');
    const draft = perfectDraft(c);
    draft.fields = draft.fields.filter(f => f.field !== 'paid_at').map(f => (f.field === 'amount' ? { ...f, expr: 'pay_amount / 100' } : f));
    delete draft.dedupe;
    fakeLlm(setLlmFetch, () => json(draft));
    // 7 列里 paid_at 删了、amount 改了 → 5/7；改动 = 删 1 + 改 1 + 取最新字段 1（去重键回落到实体主键 order_id，与期望相同）
    expect(await runCase(c, PROVIDER)).toEqual({ name: 'dedupe-orders', accuracy: 5 / 7, correct: 5, expected: 7, edits: 3 });
  });

  it('模型返回不合 Schema：失败于模型调用，准确率 0，改动是期望的全部列加去重', async () => {
    const c = caseNamed('dedupe-orders');
    fakeLlm(setLlmFetch, () => json({ fields: [{ field: 'order_id' }] }));
    const r = await runCase(c, PROVIDER);
    expect(r).toMatchObject({ accuracy: 0, correct: 0, expected: 7, edits: 8, failed: { stage: 'model' } });
    expect(r.failed!.message).toContain('不符合 Schema');
  });

  it('转出的映射不过校验：失败于映射校验并记问题数，Key 不出现在结果里', async () => {
    const c = caseNamed('chinese-status');
    fakeLlm(setLlmFetch, () => json({ fields: [{ field: 'order_id', expr: 'no_such_column', confidence: 0.5, reason: '猜的' }] }));
    const r = await runCase(c, PROVIDER);
    expect(r).toMatchObject({ accuracy: 0, expected: 8, edits: 8, failed: { stage: 'mapping', issues: expect.any(Number) } });
    expect(r.failed!.issues).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(PROVIDER.apiKey);
  });

  it('值字典写了非标准枚举值：问题清单带路径与消息，源取值与模型给的值都换成 <值>', async () => {
    const c = caseNamed('chinese-header-code-status');
    const draft = perfectDraft(c);
    const wrong: Record<string, string> = { '3': 'delivering', '4': 'canceled_x', '21': 'refund_done' };
    draft.fields = draft.fields.map(f => (f.field === 'status'
      ? { ...f, dictionary: f.dictionary!.map(d => ({ from: d.from, to: wrong[d.from] ?? d.to })) }
      : f));
    fakeLlm(setLlmFetch, () => json(draft));
    const r = await runCase(c, PROVIDER);
    expect(r.failed).toMatchObject({ stage: 'mapping', issues: 3 });
    expect(r.failed!.problems).toHaveLength(3);
    for (const p of r.failed!.problems!) {
      expect(p).toEqual({ path: 'fields.status.dictionary.<值>', message: expect.stringContaining('<值> 不是标准枚举值（可选：created、') });
    }
    const text = JSON.stringify(r);
    for (const v of [...Object.values(wrong), 'dictionary.3', 'dictionary.21']) expect(text).not.toContain(v);
  });

  it('redactIssues：引号片段、多余的内容换成 <值>，不带 hint 与行列', () => {
    expect(redactIssues([
      { line: 3, col: 5, path: 'fields.amount', message: '多余的内容：abc 123', hint: 'amount: x' },
      { line: 4, col: 1, path: 'fields.order_id', message: '没有列「秘密列」，也没有 "abc" 与 “啊”' },
      { line: 5, col: 1, path: 'fields.status.otherwise', message: 'foo bar 不是标准枚举值（可选：created、paid，或 null）' },
    ])).toEqual([
      { path: 'fields.amount', message: '多余的内容：<值>' },
      { path: 'fields.order_id', message: '没有列「<值>」，也没有 "<值>" 与 “<值>”' },
      { path: 'fields.status.otherwise', message: '<值> 不是标准枚举值（可选：created、paid，或 null）' },
    ]);
  });

  it('总体准确率按列加权，改动项数相加', () => {
    expect(summarize([
      { name: 'a', accuracy: 1, correct: 10, expected: 10, edits: 0 },
      { name: 'b', accuracy: 0, correct: 0, expected: 6, edits: 7, failed: { stage: 'model', message: 'x' } },
    ])).toEqual({ accuracy: 10 / 16, correct: 10, expected: 16, edits: 7 });
  });
});
