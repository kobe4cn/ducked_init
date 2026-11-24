// test/eval-mapping-report.test.ts —— 映射评测结果文件（#218，ADR-0035）：toReport 只记模型、主机、提示词哈希与各例得分（失败于映射校验的带问题清单），不带 Key 与完整 URL；
// 部分采用的样例带 dropped、总体带整份通过 / 部分采用 / 失败的样例数（#1266）；compareReports 按样例名对齐算差值、列出只在一边的样例、标出模型 / 主机 / 提示词是否相同，
// 两边都有计数时带 counts、旧结果文件没有计数时不带；换一份 Schema 或不带目录时提示词哈希会变（纯函数）
import { describe, expect, it } from 'vitest';
import { MODEL_DRAFT_SCHEMA } from '../app/.server/pipeline/model-draft';
import { compareReports, promptHash, reportFileName, toReport, type EvalReport } from '../scripts/eval-mapping/report';
import { summarize, type CaseResult } from '../scripts/eval-mapping/score';

const result = (name: string, correct: number, expected: number, edits: number, over: Partial<CaseResult> = {}): CaseResult =>
  ({ name, accuracy: correct / expected, correct, expected, edits, ...over });

const report = (over: Partial<EvalReport> = {}): EvalReport => ({
  model: 'gpt-x',
  host: 'llm.example.com',
  promptHash: 'abc123abc123',
  startedAt: '2026-10-18T01:02:03.456Z',
  cases: [],
  total: { accuracy: 1, edits: 0 },
  ...over,
});

describe('toReport', () => {
  const PROBLEMS = [{ path: 'fields.status.dictionary.<值>', message: '<值> 不是标准枚举值（可选：created、paid）' }];
  const results = [
    result('rename', 4, 4, 0),
    result('paid', 6, 7, 1, { partial: true, dropped: ['fields.x'] }),
    result('cents', 0, 6, 7, { failed: { stage: 'mapping', message: '映射校验不过：2 个问题', issues: 2, problems: PROBLEMS } }),
    result('bad', 0, 5, 5, { failed: { stage: 'model', message: '不符合 Schema：sk-secret' } }),
  ];
  const r = toReport(results, summarize(results), {
    model: 'org/model-1',
    baseUrl: 'https://user:pw@llm.example.com:8443/v1?api_key=sk-secret',
    startedAt: new Date('2026-10-18T01:02:03.456Z'),
  });

  it('只记主机、提示词哈希与各例得分，部分采用的带去掉项的路径，总体带整份通过 / 部分采用 / 失败的样例数；失败的带阶段；失败于映射校验的带问题清单，不含 Key、完整 URL 与模型调用的失败信息', () => {
    expect(r).toEqual({
      model: 'org/model-1',
      host: 'llm.example.com:8443',
      promptHash: promptHash(),
      startedAt: '2026-10-18T01:02:03.456Z',
      cases: [
        { name: 'rename', accuracy: 1, edits: 0 },
        { name: 'paid', accuracy: 6 / 7, edits: 1, dropped: ['fields.x'] },
        { name: 'cents', accuracy: 0, edits: 7, stage: 'mapping', problems: PROBLEMS },
        { name: 'bad', accuracy: 0, edits: 5, stage: 'model' },
      ],
      total: { accuracy: 10 / 22, edits: 13, full: 1, partial: 1, failed: 2 },
    });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/sk-secret|api_key|apiKey|\/v1|pw@/);
  });

  it('文件名：时间戳不带冒号与点，模型名里的 / 换成 _', () => {
    expect(reportFileName(r)).toBe('2026-10-18T01-02-03-456Z-org_model-1.json');
  });
});

describe('compareReports', () => {
  const a = report({
    cases: [{ name: 'rename', accuracy: 1, edits: 0 }, { name: 'cents', accuracy: 0.5, edits: 3, stage: 'mapping' }, { name: 'old', accuracy: 1, edits: 0 }],
    total: { accuracy: 0.8, edits: 3 },
  });
  const b = report({
    model: 'gpt-y',
    cases: [{ name: 'cents', accuracy: 1, edits: 0 }, { name: 'rename', accuracy: 0.75, edits: 1 }, { name: 'new', accuracy: 0, edits: 5, stage: 'model' }],
    total: { accuracy: 0.6, edits: 6 },
  });
  const c = compareReports(a, b);

  it('按样例名对齐算差值（b − a），总体也算', () => {
    expect(c.cases).toEqual([
      { name: 'rename', a: { accuracy: 1, edits: 0 }, b: { accuracy: 0.75, edits: 1 }, delta: { accuracy: -0.25, edits: 1 } },
      { name: 'cents', a: { accuracy: 0.5, edits: 3, stage: 'mapping' }, b: { accuracy: 1, edits: 0 }, delta: { accuracy: 0.5, edits: -3 } },
    ]);
    expect(c.total.delta.accuracy).toBeCloseTo(-0.2);
    expect(c.total.delta.edits).toBe(3);
  });

  it('列出只在一边出现的样例', () => {
    expect(c.onlyA).toEqual([{ name: 'old', accuracy: 1, edits: 0 }]);
    expect(c.onlyB).toEqual([{ name: 'new', accuracy: 0, edits: 5, stage: 'model' }]);
  });

  it('标出模型、主机、提示词哈希是否相同', () => {
    expect(c.same).toEqual({ model: false, host: true, promptHash: true });
    expect(compareReports(a, a).same).toEqual({ model: true, host: true, promptHash: true });
  });

  it('旧结果文件没有整份 / 部分计数：不报错，不带 counts，总体差值只算准确率与改动', () => {
    const old = compareReports(report(), report({ total: { accuracy: 0.5, edits: 2, full: 1, partial: 0, failed: 1 } }));
    expect(old).not.toHaveProperty('counts');
    expect(old.total.delta).toEqual({ accuracy: -0.5, edits: 2 });
  });

  it('两边都有计数时带上两边的整份通过 / 部分采用 / 失败数', () => {
    const x = compareReports(
      report({ total: { accuracy: 1, edits: 0, full: 3, partial: 0, failed: 0 } }),
      report({ total: { accuracy: 0.8, edits: 2, full: 1, partial: 1, failed: 1 } }),
    );
    expect(x.counts).toEqual({ a: { full: 3, partial: 0, failed: 0 }, b: { full: 1, partial: 1, failed: 1 } });
    expect(x.total.delta).toEqual({ accuracy: expect.closeTo(-0.2), edits: 2 });
  });
});

describe('promptHash', () => {
  it('12 位十六进制，同一份提示词稳定，换一份 Schema 就变', () => {
    expect(promptHash()).toMatch(/^[0-9a-f]{12}$/);
    expect(promptHash()).toBe(promptHash(MODEL_DRAFT_SCHEMA));
    expect(promptHash({ ...MODEL_DRAFT_SCHEMA, required: ['fields', 'dedupe'] })).not.toBe(promptHash());
  });

  it('按带固定目录的 system 消息算：不带目录时哈希不同', () => {
    expect(promptHash(MODEL_DRAFT_SCHEMA, null)).not.toBe(promptHash());
  });
});
