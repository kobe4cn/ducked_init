// test/eval-mapping-report.test.ts —— 映射评测结果文件（#218，ADR-0035）：toReport 只记模型、主机、提示词哈希与各例得分，不带 Key 与完整 URL；
// compareReports 按样例名对齐算差值、列出只在一边的样例、标出模型 / 主机 / 提示词是否相同；换一份 Schema 时提示词哈希会变（纯函数）
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
  const results = [
    result('rename', 4, 4, 0),
    result('cents', 0, 6, 7, { failed: { stage: 'mapping', message: '映射校验不过：2 个问题', issues: 2 } }),
  ];
  const r = toReport(results, summarize(results), {
    model: 'org/model-1',
    baseUrl: 'https://user:pw@llm.example.com:8443/v1?api_key=sk-secret',
    startedAt: new Date('2026-10-18T01:02:03.456Z'),
  });

  it('只记主机、提示词哈希与各例得分，失败的带阶段，不含 Key、完整 URL 与失败信息', () => {
    expect(r).toEqual({
      model: 'org/model-1',
      host: 'llm.example.com:8443',
      promptHash: promptHash(),
      startedAt: '2026-10-18T01:02:03.456Z',
      cases: [{ name: 'rename', accuracy: 1, edits: 0 }, { name: 'cents', accuracy: 0, edits: 7, stage: 'mapping' }],
      total: { accuracy: 0.4, edits: 7 },
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
});

describe('promptHash', () => {
  it('12 位十六进制，同一份提示词稳定，换一份 Schema 就变', () => {
    expect(promptHash()).toMatch(/^[0-9a-f]{12}$/);
    expect(promptHash()).toBe(promptHash(MODEL_DRAFT_SCHEMA));
    expect(promptHash({ ...MODEL_DRAFT_SCHEMA, required: ['fields', 'dedupe'] })).not.toBe(promptHash());
  });
});
