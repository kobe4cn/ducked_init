// test/eval-shared-report.test.ts —— 评测共用结果文件（#1261，ADR-0035）：reportMeta 只留端点主机；hashPrompt 换 Schema 就变；
// writeReport 写到目录下、文件名同 reportFileName（纯函数，只写临时目录）
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reportFileName } from '../scripts/eval-mapping/report';
import { hashPrompt, reportMeta, writeReport } from '../scripts/eval-shared/report';

const META = { model: 'org/model-1', baseUrl: 'https://user:pw@llm.example.com:8443/v1?api_key=sk-secret', startedAt: new Date('2026-10-18T01:02:03.456Z') };

describe('评测共用结果文件', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('reportMeta：baseUrl 带账号与 query 时只剩主机，开始时间是 ISO 文本', () => {
    const m = reportMeta(META, 'abc123abc123');
    expect(m).toEqual({ model: 'org/model-1', host: 'llm.example.com:8443', promptHash: 'abc123abc123', startedAt: '2026-10-18T01:02:03.456Z' });
    expect(JSON.stringify(m)).not.toMatch(/sk-secret|api_key|\/v1|pw@/);
  });

  it('hashPrompt：12 位十六进制，同输入稳定，换 Schema 或提示词就变', () => {
    const schema = { type: 'object', required: ['a'] };
    expect(hashPrompt('sys', schema)).toMatch(/^[0-9a-f]{12}$/);
    expect(hashPrompt('sys', schema)).toBe(hashPrompt('sys', { ...schema }));
    expect(hashPrompt('sys', { ...schema, required: ['a', 'b'] })).not.toBe(hashPrompt('sys', schema));
    expect(hashPrompt('sys2', schema)).not.toBe(hashPrompt('sys', schema));
  });

  it('writeReport：建目录、写 JSON，文件名同 reportFileName', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-report-'));
    dirs.push(root);
    const dir = join(root, 'out');
    const report = { ...reportMeta(META, 'abc123abc123'), cases: [{ name: 'a', pass: true }, { name: 'b', pass: false, stage: 'model' }], total: { passRate: 0.5 } };
    const file = writeReport(dir, report);
    expect(file).toBe(join(dir, reportFileName(report)));
    expect(readdirSync(dir)).toEqual(['2026-10-18T01-02-03-456Z-org_model-1.json']);
    const text = readFileSync(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(report);
  });
});
