// test/i18n-catalog.test.ts —— 守卫：app/ 里 t()/msg() 的字面量键必须都在英文词典里（t 查 en.client.json、msg 查 en.server.json，ADR-0060 的分工），
// 两份词典的中英文句式变量名一致。防止改了中文文案忘了同步词典
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';
import { describe, expect, it } from 'vitest';
import enClient from '../app/i18n/en.client.json';
import enServer from '../app/i18n/en.server.json';
import { CANONICAL_NAMES, ENUM_LABELS } from '../app/lib/builtin-names';
import { TEMPLATES } from '../app/.server/pipeline/templates/index';
import { RFM_DEFAULTS } from '../app/.server/pipeline/templates/rfm';
import { TASK_STATUS_LABELS } from '../app/.server/tasks';
import { DSL_KINDS } from '../app/.server/pipeline/dsl/index';
import { CATALOG_FILES, sortCatalog } from '../scripts/i18n-sort';

type Catalog = Record<string, string>;
const root = join(import.meta.dirname, '..');

const listSourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? listSourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
});

/**
 * 检查源码里 t('…') / msg('…') 的调用（跳过注释行）：
 * 字面量键必须在对应词典里；参数不是字符串字面量也算问题（没法静态对账）。
 * 非字面量的检查只对 import 了 i18n 模块的文件生效，避免 SQL 里的表别名 t(i) 这类同名写法误报。
 * 唯一的豁免是 builtin-names.ts：它把名单里的名称变量递给 t()，这些键由「所有平台内置名称都在 en.client.json」的用例对账。
 */
const DYNAMIC_KEYS_ALLOWED = new Set(['app/lib/builtin-names.ts']);

function checkUsages(source: string, file: string, client: Catalog, server: Catalog): string[] {
  const problems: string[] = [];
  const usesI18n = /from\s+['"][^'"]*i18n['"]/.test(source);
  for (const [i, line] of source.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const m of line.matchAll(/\b(?:t|msg)\(/g)) {
      const fn = m[0].slice(0, -1) as 't' | 'msg';
      // 字面量可以是单引号或双引号：含单引号的键（date(x[, '格式'])、in ('a', 'b')）只能用双引号写
      const literal = line.slice(m.index! + m[0].length).match(/^\s*(?:'([^']*)'|"([^"]*)")/);
      if (literal) {
        const key = literal[1] ?? literal[2]!;
        const catalog = fn === 't' ? client : server;
        if (!(key in catalog)) {
          problems.push(`${file}:${i + 1} ${fn}('${key}') 不在 en.${fn === 't' ? 'client' : 'server'}.json`);
        }
      } else if (usesI18n && !DYNAMIC_KEYS_ALLOWED.has(file)) {
        problems.push(`${file}:${i + 1} ${fn}(…) 的参数不是字符串字面量`);
      }
    }
  }
  return problems;
}

/** ICU 句式里的变量名集合：argument / number / date / time / select / plural / tag 节点的 value 是变量名，literal 节点的 value 是文字 */
function variables(pattern: string): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const element = node as { type?: number; value?: unknown };
    if (element.type !== undefined) {
      // ICU AST 节点：非 literal 的 value 是变量名；literal 的 value 是文字，不收
      if (element.type !== TYPE.literal && typeof element.value === 'string') names.add(element.value);
      else walk(element.value);
    } else {
      // 非 AST 节点的对象（plural / select 的各分支）：所有字段都往下走，分支子句式里的变量也算
      for (const value of Object.values(node as Record<string, unknown>)) walk(value);
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (key !== 'value') walk((node as Record<string, unknown>)[key]); // options、children 等
    }
  };
  walk(parse(pattern));
  return names;
}

/** 检查词典：每条中英文句式都能被 ICU 解析，且变量名集合一致（英文侧 plural 的变量也算在内） */
function checkCatalog(catalog: Catalog, label: string): string[] {
  const problems: string[] = [];
  for (const [zh, en] of Object.entries(catalog)) {
    let zhVars: Set<string>;
    let enVars: Set<string>;
    try {
      zhVars = variables(zh);
      enVars = variables(en);
    } catch (e) {
      problems.push(`${label}「${zh}」不是合法的 ICU 句式：${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const diff = [...zhVars].filter(v => !enVars.has(v)).concat([...enVars].filter(v => !zhVars.has(v)));
    if (diff.length) {
      problems.push(`${label}「${zh}」的变量中英不一致：中文 [${[...zhVars].join(', ')}]，英文 [${[...enVars].join(', ')}]`);
    }
  }
  return problems;
}

describe('守卫：翻译键与英文词典对账（ADR-0060）', () => {
  it("app/ 里 t('…') 的键都在 en.client.json，msg('…') 的键都在 en.server.json，参数都是字面量", () => {
    const violations = listSourceFiles(join(root, 'app'))
      .flatMap((path) => checkUsages(readFileSync(path, 'utf8'), relative(root, path), enClient, enServer));
    expect(violations.join('\n')).toBe('');
  });

  it("app/lib、app/components 里 msg('…') 的键也在 en.client.json：前后端共用的 lib（如 ExprError，#1042）两边词典都要有", () => {
    const violations = [...listSourceFiles(join(root, 'app/lib')), ...listSourceFiles(join(root, 'app/components'))]
      .flatMap((path) => checkUsages(readFileSync(path, 'utf8'), relative(root, path), enClient, enClient));
    expect(violations.join('\n')).toBe('');
  });

  it('所有平台内置名称都在 en.client.json', () => {
    const builtin = [
      ...CANONICAL_NAMES,
      ...ENUM_LABELS,
      ...Object.values(TEMPLATES).map(template => template.label),
      ...RFM_DEFAULTS.segments.map(segment => segment.name),
      ...Object.values(TASK_STATUS_LABELS),
      ...Object.values(DSL_KINDS).map(kind => kind.label),
    ];
    expect(builtin.filter(name => !(name in enClient)).join('\n')).toBe('');
  });

  it('两份词典中英文句式的变量名一致', () => {
    const violations = [...checkCatalog(enClient, 'en.client.json'), ...checkCatalog(enServer, 'en.server.json')];
    expect(violations.join('\n')).toBe('');
  });

  it('checkUsages 能抓到缺键与非字面量参数（喂一份故意有问题的源码）', () => {
    const source = [
      "import { t, msg } from '~/lib/i18n';",
      "t('不在词典里的句子')",
      'msg(dynamicKey)',
      "// t('注释里的不算')",
      "translate('也不是它')",
      't("双引号也不在词典里")',
    ].join('\n');
    expect(checkUsages(source, 'demo.tsx', { 在词典里的句子: 'ok' }, {})).toEqual([
      "demo.tsx:2 t('不在词典里的句子') 不在 en.client.json",
      'demo.tsx:3 msg(…) 的参数不是字符串字面量',
      "demo.tsx:6 t('双引号也不在词典里') 不在 en.client.json",
    ]);
  });

  it('checkCatalog 能抓到变量名不一致（喂一份变量对不上的词典）', () => {
    expect(checkCatalog({ '共 {n} 条': 'There are {count} rows' }, 'demo.json')).toEqual([
      'demo.json「共 {n} 条」的变量中英不一致：中文 [n]，英文 [count]',
    ]);
    // plural 分支子句式里的变量也算
    expect(checkCatalog({ '{c} 条：{n, plural, other {{x} 行}}': '{c} rows: {n, plural, other {{y} lines}}' }, 'demo.json')).toEqual([
      'demo.json「{c} 条：{n, plural, other {{x} 行}}」的变量中英不一致：中文 [c, n, x]，英文 [c, n, y]',
    ]);
  });

  // 排序让并行的双语票各自插在不同位置，落地时 git 能自动合并；重复键时 JSON 后者覆盖前者，没人发现（2026-11-23）
  it('两份词典按键排序、没有重复键（不满足时跑 pnpm i18n:sort）', () => {
    for (const file of CATALOG_FILES) {
      const raw = readFileSync(join(root, file), 'utf8');
      const { text, conflicts, duplicates } = sortCatalog(raw);
      expect(conflicts, `${file} 同一个键有不同译文`).toEqual([]);
      expect(duplicates, `${file} 有重复键`).toEqual([]);
      expect(raw === text, `${file} 没有按键排序：跑 pnpm i18n:sort`).toBe(true);
    }
  });

  it('sortCatalog 按码点排序，合并相同的重复键，报出译文不同的重复键', () => {
    const raw = '{\n  "乙": "B",\n  "甲": "A",\n  "乙": "B",\n  "丙": "C1",\n  "丙": "C2"\n}\n';
    const { text, conflicts, duplicates } = sortCatalog(raw);
    expect(duplicates).toEqual(['乙']);
    expect(conflicts).toEqual(['「丙」："C1" 与 "C2"']);
    expect(Object.keys(JSON.parse(text))).toEqual(['丙', '乙', '甲']);
  });
});
