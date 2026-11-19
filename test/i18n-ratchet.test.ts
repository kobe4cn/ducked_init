// test/i18n-ratchet.test.ts —— 守卫：未接入翻译的中文文案只减不增（ADR-0060，#929）
// 扫描与比较是 scripts/i18n-ratchet/scan.ts 的纯函数（CLI 是 scripts/i18n-ratchet.ts，用法 pnpm i18n:ratchet）。
// 基线 test/i18n-ratchet-baseline.json 必须等于实际值：新增未接入翻译的中文时变红并给出 file:line；
// 接入翻译后「少于基线」也变红，跑 pnpm i18n:ratchet --update 把基线改小并一起提交（调高要显式 --allow-increase）
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmp } from '../app/lib/compare';
import baseline from './i18n-ratchet-baseline.json';
import { bucketOf, compare, summarize, untranslatedLines, updatedBaseline } from '../scripts/i18n-ratchet/scan';

const root = join(import.meta.dirname, '..');

const listSourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? listSourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
});

/** app/ 下每个文件未接入翻译的中文行（计数为 0 的文件不进 Map），键按字母序，与 CLI 的口径一致 */
function scanApp(): Map<string, { line: number; text: string }[]> {
  const actual = new Map<string, { line: number; text: string }[]>();
  for (const path of listSourceFiles(join(root, 'app')).sort(cmp)) {
    const lines = untranslatedLines(readFileSync(path, 'utf8'));
    if (lines.length) actual.set(relative(root, path).split(sep).join('/'), lines);
  }
  return actual;
}

describe('守卫：未接入翻译的中文只减不增（ADR-0060）', () => {
  it('app/ 的实际计数不多于基线：新增未接入翻译的中文会以 file:line 列出', () => {
    const { increased } = compare(baseline.files, scanApp());
    expect(increased.join('\n')).toBe('');
  });

  it('app/ 的实际计数不少于基线：接入翻译后跑 pnpm i18n:ratchet --update 下调基线并一起提交', () => {
    const { decreased } = compare(baseline.files, scanApp());
    expect(decreased.join('\n'), '已接入翻译？跑 pnpm i18n:ratchet --update 把基线改小，和代码一起提交').toBe('');
  });

  it('untranslatedLines：注释与 t()/msg() 的键不计，字符串 / 模板 / JSX 文本的汉字按行计数', () => {
    const source = [
      '// 全行注释',                                                     // 1
      'foo(); // 行尾注释',                                             // 2
      '/* 块注释',                                                      // 3
      ' * 中间行',                                                      // 4
      " */ '中文'",                                                     // 5 块注释结束后计入
      '{/* 中文 */}',                                                   // 6 JSX 注释
      "t('中文键')",                                                    // 7 翻译键
      "msg('中文 {n}', { n })",                                         // 8 翻译键
      "'中文'",                                                         // 9
      '`中文${x}`',                                                     // 10 模板字符串
      '<p>中文</p>',                                                    // 11 JSX 文本
      "throw new Error('中文')",                                        // 12 内部报错也计
      "t('键') + '中文'",                                               // 13 同一行只计 1
      "const a = 'http://x'; const b = '中文'",                         // 14 字符串里的 // 不是注释
      'const label = t(',                                               // 15
      "  '跨行的键',",                                                  // 16 t( 的第一个参数跨行仍是键
      ');',                                                             // 17
    ].join('\n');
    expect(untranslatedLines(source)).toEqual([
      { line: 5, text: "*/ '中文'" },
      { line: 9, text: "'中文'" },
      { line: 10, text: '`中文${x}`' },
      { line: 11, text: '<p>中文</p>' },
      { line: 12, text: "throw new Error('中文')" },
      { line: 13, text: "t('键') + '中文'" },
      { line: 14, text: "const a = 'http://x'; const b = '中文'" },
    ]);
  });

  it('compare：某文件多一行时 increased 列出该行 file:line，少一行或文件消失时 decreased 给出汇总', () => {
    const baseline = { 'app/a.tsx': 1, 'app/gone.tsx': 2 };
    const actual = new Map([
      ['app/a.tsx', [{ line: 1, text: '一行' }, { line: 4, text: '新增' }]],
      ['app/new.tsx', [{ line: 2, text: '新文件' }]],
    ]);
    expect(compare(baseline, actual)).toEqual({
      increased: [
        'app/a.tsx 基线 1，实际 2',
        'app/a.tsx:1 一行',
        'app/a.tsx:4 新增',
        'app/new.tsx 基线 0，实际 1',
        'app/new.tsx:2 新文件',
      ],
      decreased: ['app/gone.tsx 基线 2，实际 0'],
    });
  });

  it('updatedBaseline：只下调或删掉条目；有增加时拒绝，显式 --allow-increase 才写入调高后的值', () => {
    const baseline = { 'app/a.tsx': 3, 'app/b.tsx': 1 };
    const down = new Map([['app/a.tsx', [{ line: 1, text: 'x' }, { line: 2, text: 'y' }]]]);
    // b.tsx 计数归 0：条目删掉；下降不拦
    expect(updatedBaseline(baseline, down, false)).toEqual({ ok: true, files: { 'app/a.tsx': 2 } });
    const up = new Map([['app/a.tsx', [{ line: 1, text: 'x' }, { line: 2, text: 'y' }, { line: 3, text: 'z' }, { line: 4, text: 'w' }]]]);
    const increased = ['app/a.tsx 基线 3，实际 4', 'app/a.tsx:1 x', 'app/a.tsx:2 y', 'app/a.tsx:3 z', 'app/a.tsx:4 w'];
    expect(updatedBaseline(baseline, up, false)).toEqual({ ok: false, increased });
    expect(updatedBaseline(baseline, up, true)).toEqual({ ok: true, files: { 'app/a.tsx': 4 } });
  });

  it('bucketOf：ops 页面单独成组，其余按 app/ 下前两级目录，根上文件归 app', () => {
    expect(bucketOf('app/routes/ops.tsx')).toBe('/ops');
    expect(bucketOf('app/routes/ops.tenants.tsx')).toBe('/ops');
    expect(bucketOf('app/components/ops-shell.tsx')).toBe('/ops');
    expect(bucketOf('app/.server/ops-auth.ts')).toBe('/ops');
    expect(bucketOf('app/routes/login.tsx')).toBe('app/routes');
    expect(bucketOf('app/.server/pipeline/x.ts')).toBe('app/.server/pipeline');
    expect(bucketOf('app/.server/x.ts')).toBe('app/.server');
    expect(bucketOf('app/root.tsx')).toBe('app');
  });

  it('summarize：按目录给文件数与行数，末尾附「/ops 以外合计」与「总计」，合计不含 /ops', () => {
    const actual = new Map([
      ['app/routes/ops.tenants.tsx', [{ line: 1, text: 'a' }, { line: 2, text: 'b' }]],
      ['app/routes/login.tsx', [{ line: 3, text: 'c' }]],
      ['app/lib/x.ts', [{ line: 4, text: 'd' }]],
      ['app/root.tsx', [{ line: 5, text: 'e' }]],
    ]);
    expect(summarize(actual)).toEqual([
      { bucket: '/ops', files: 1, lines: 2 },
      { bucket: 'app', files: 1, lines: 1 },
      { bucket: 'app/lib', files: 1, lines: 1 },
      { bucket: 'app/routes', files: 1, lines: 1 },
      { bucket: '/ops 以外合计', files: 3, lines: 3 },
      { bucket: '总计', files: 4, lines: 5 },
    ]);
  });
});
