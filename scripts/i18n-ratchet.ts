// scripts/i18n-ratchet.ts —— 用法：pnpm i18n:ratchet [--update [--allow-increase]]（ADR-0060，#929）
// 不带参数：打印未接入翻译的中文按目录剩余量（/ops 单独一组，判断是否达到开放标准）。
// --update：把 test/i18n-ratchet-baseline.json 改成当前实际值（只能下调或删条目）；任何文件比基线多
// （新文件算从 0 增加）时拒绝写入、列出 file:line、退出码 1——要调高必须显式 --allow-increase，
// 改动会出现在 JSON diff 里，不会被静默调高。扫描与比较逻辑在 scripts/i18n-ratchet/scan.ts，测试同用
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { cmp } from '../app/lib/compare';
import { compare, summarize, untranslatedLines, updatedBaseline } from './i18n-ratchet/scan';

const root = join(import.meta.dirname, '..');
const baselinePath = join(root, 'test/i18n-ratchet-baseline.json');

const listSourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? listSourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
});

/** app/ 下每个文件计入棘轮的行（计数为 0 的不进 Map），键按字母序 */
function scanApp(): Map<string, { line: number; text: string }[]> {
  const actual = new Map<string, { line: number; text: string }[]>();
  for (const path of listSourceFiles(join(root, 'app')).sort(cmp)) {
    const lines = untranslatedLines(readFileSync(path, 'utf8'));
    if (lines.length) actual.set(relative(root, path).split(sep).join('/'), lines);
  }
  return actual;
}

const actual = scanApp();

if (process.argv.includes('--update')) {
  const baseline = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { files?: Record<string, number> }).files ?? {}
    : {};
  const result = updatedBaseline(baseline, actual, process.argv.includes('--allow-increase'));
  if (!result.ok) {
    console.error(`计数比基线多，拒绝写入（确有理由时加 --allow-increase 并在 PR 里说明）：\n${result.increased.join('\n')}`);
    process.exit(1);
  }
  writeFileSync(baselinePath, `${JSON.stringify({ files: result.files }, null, 2)}\n`);
  const total = Object.values(result.files).reduce((n, c) => n + c, 0);
  console.log(`基线已写入 test/i18n-ratchet-baseline.json：${Object.keys(result.files).length} 个文件，${total} 行`);
} else {
  console.table(summarize(actual));
  const { increased, decreased } = compare(
    existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { files?: Record<string, number> }).files ?? {}
      : {},
    actual,
  );
  if (increased.length) {
    console.error(`\n计数比基线多（test/i18n-ratchet.test.ts 会拦下）：\n${increased.join('\n')}`);
    process.exit(1);
  }
  if (decreased.length) console.log(`\n已接入翻译？跑 pnpm i18n:ratchet --update 把基线改小：\n${decreased.join('\n')}`);
}
