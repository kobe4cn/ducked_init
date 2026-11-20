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
      const literal = line.slice(m.index! + m[0].length).match(/^\s*'([^']*)'/);
      if (literal) {
        const catalog = fn === 't' ? client : server;
        if (!(literal[1]! in catalog)) {
          problems.push(`${file}:${i + 1} ${fn}('${literal[1]}') 不在 en.${fn === 't' ? 'client' : 'server'}.json`);
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
    ].join('\n');
    expect(checkUsages(source, 'demo.tsx', { 在词典里的句子: 'ok' }, {})).toEqual([
      "demo.tsx:2 t('不在词典里的句子') 不在 en.client.json",
      'demo.tsx:3 msg(…) 的参数不是字符串字面量',
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
});
