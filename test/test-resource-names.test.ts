// scripts/test-resource-names.ts 的纯函数用例（不连库）：源端测试账号名 = 基准名 + 运行后缀（沙箱里 _i<票号>）+ worker 后缀，
// 不设运行后缀时与本地原来的名字逐字一致；回收的匹配规则只挑带本票后缀的账号，不碰别的票与不带运行后缀的本地账号
import { describe, expect, it, vi } from 'vitest';
import { accountsToDrop, SRC_ACCOUNT_BASES, srcAccountName, suffixPattern } from '../scripts/test-resource-names';
import { WORKER_SUFFIX } from './setup-env';

const READER_BASE = SRC_ACCOUNT_BASES[0]!;
const WRITER_BASE = SRC_ACCOUNT_BASES[1]!;
const W1 = '_w1';

describe('srcAccountName', () => {
  it('不设运行后缀时账号名与原来逐字一致', async () => {
    expect(srcAccountName(READER_BASE, '', W1)).toBe(`${READER_BASE}${W1}`);
    expect(srcAccountName(READER_BASE, '', '')).toBe(READER_BASE);
    // 夹具的账号在没设 CRM_TEST_RUN_SUFFIX 时名字不变（动态导入保证断言时环境可控）
    vi.stubEnv('CRM_TEST_RUN_SUFFIX', '');
    const { READER, WRITER } = await import('./pipeline/source-fixtures');
    vi.unstubAllEnvs();
    expect(READER.user).toBe(`${READER_BASE}${WORKER_SUFFIX}`);
    expect(WRITER.user).toBe(`${WRITER_BASE}${WORKER_SUFFIX}`);
  });

  it('同一个 worker、不同运行后缀得到的账号名不同', () => {
    const a = srcAccountName(READER_BASE, '_i1', W1);
    const b = srcAccountName(READER_BASE, '_i2', W1);
    expect(a).not.toBe(b);
    expect(a.endsWith(W1)).toBe(true);
    expect(b.endsWith(W1)).toBe(true);
    expect(a).toContain('_i1');
    expect(b).toContain('_i2');
    // MySQL 用户名最长 32 字符：最长的名字（四位数票号、两位数 worker）也不超
    for (const base of SRC_ACCOUNT_BASES) expect(srcAccountName(base, '_i9999', '_w16').length).toBeLessThanOrEqual(32);
  });
});

describe('accountsToDrop', () => {
  it('只挑带本票后缀的账号：别的票、前缀相近的、不带运行后缀的都不动', () => {
    const A = '_i3', B = '_i6';
    const name = (run: string, worker: string) => srcAccountName(READER_BASE, run, worker);
    const names = [name(A, W1), name(A, '_w2'), name(B, W1), name(`${A}9`, W1), `${READER_BASE}${W1}`, 'lake_1'];
    // 回收 A 票：只有 A 的两个；B 票的还在，_i39 是别的票，不带运行后缀的本地账号与 lake 角色都不碰
    expect(accountsToDrop(names, suffixPattern([A]))).toEqual([name(A, W1), name(A, '_w2')]);
    // --all：全部带 _i<数字> 的都收，不含不带运行后缀的本地账号
    expect(accountsToDrop(names, suffixPattern('all'))).toEqual([name(A, W1), name(A, '_w2'), name(B, W1), name(`${A}9`, W1)]);
  });
});
