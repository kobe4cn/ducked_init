// scripts/i18n-sort.ts —— 用法：pnpm i18n:sort [--check]（ADR-0060）
// 把 app/i18n/en.client.json、en.server.json 的词条按键排序（码点序，app/lib/compare 的 cmp）、2 空格缩进重写。
// 为什么排序：几张双语票并行时都往文件末尾追加词条，落地时必然在末尾文本冲突，要 rebase 后重跑门槛（2026-11-23）。
// 排好序后新词条插在各自的位置，不同页面的词条很少相邻，git / GitHub 能自动合并。
// 同一个键写了两次：译文相同就合并成一条；译文不同时拒绝写入、列出两种译文，退出码 1（人选一个删掉另一个）。
// --check：只检查（未排序或有重复键时退出码 1），不写文件。测试用 sortCatalog 做同样的检查。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmp } from '../app/lib/compare';

export const CATALOG_FILES = ['app/i18n/en.client.json', 'app/i18n/en.server.json'];

/** 一条词条一行（`  "键": "值",`）；返回排好序的文本、重复键里译文不同的冲突，以及译文相同的重复键 */
export function sortCatalog(raw: string): { text: string; conflicts: string[]; duplicates: string[] } {
  const seen = new Map<string, string>();
  const conflicts: string[] = [];
  const duplicates: string[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")\s*,?\s*$/);
    if (!m) continue;
    const key = JSON.parse(m[1]!) as string;
    const value = JSON.parse(m[2]!) as string;
    const prev = seen.get(key);
    if (prev === undefined) seen.set(key, value);
    else if (prev === value) duplicates.push(key);
    else conflicts.push(`「${key}」：${JSON.stringify(prev)} 与 ${JSON.stringify(value)}`);
  }
  // 逐行解析漏掉的格式（多行值等）以 JSON.parse 为准：键数对不上就退回整体解析，不丢词条
  const parsed = JSON.parse(raw) as Record<string, string>;
  const entries = Object.keys(parsed).length === seen.size ? [...seen] : Object.entries(parsed);
  const sorted = Object.fromEntries(entries.sort(([a], [b]) => cmp(a, b)));
  return { text: `${JSON.stringify(sorted, null, 2)}\n`, conflicts, duplicates };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = join(import.meta.dirname, '..');
  const check = process.argv.includes('--check');
  let failed = false;
  for (const file of CATALOG_FILES) {
    const path = join(root, file);
    const raw = readFileSync(path, 'utf8');
    const { text, conflicts, duplicates } = sortCatalog(raw);
    if (conflicts.length) {
      failed = true;
      console.error(`${file} 有同一个键的不同译文，删掉其中一条再跑：\n  ${conflicts.join('\n  ')}`);
      continue;
    }
    if (text === raw) continue;
    if (check) {
      failed = true;
      console.error(`${file} 没有按键排序${duplicates.length ? `（另有重复键 ${duplicates.join('、')}）` : ''}：跑 pnpm i18n:sort`);
    } else {
      writeFileSync(path, text);
      console.log(`${file} 已排序${duplicates.length ? `，合并重复键 ${duplicates.join('、')}` : ''}`);
    }
  }
  if (failed) process.exit(1);
}
