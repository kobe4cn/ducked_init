// scripts/test-resource-names.ts —— 测试资源命名的纯函数：源端测试账号名（基准名 + 运行后缀 + worker 后缀）与按票后缀
// 匹配要回收的名字，供 scripts/drop-test-resources.ts 与 test/pipeline/source-fixtures.ts 共用，测试直接导入本文件（不连库）。
// - 运行后缀来自 CRM_TEST_RUN_SUFFIX（.sandcastle/main.ts 的 testEnv 在沙箱里设成 _i<票号>），本地不设、为空串，
//   账号名与原来逐字一致（vitest 里 crm_src_reader_w<i>，不在 vitest 里 crm_src_reader）
// - 后缀只能含小写字母、数字、下划线：夹具里 PG 角色名在 SQL 里没加引号，出现别的字符会变成语法错误
import { WORKER_SUFFIX } from '../test/setup-env';

/** 把字符串按字面量转义成正则 */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 票后缀的正则片段：'all' 匹配全部 _i<数字>，否则只匹配列出的那几个后缀 */
export function suffixPattern(suffixes: string[] | 'all'): string {
  return suffixes === 'all' ? '_i\\d+' : `(?:${suffixes.map(escapeRe).join('|')})`;
}

/** base 加票后缀、可能再加 worker 后缀的名字（带锚点，_i33 不会匹配 _i336_w1） */
export function nameMatcher(bases: string[], suffixRe: string): RegExp {
  return new RegExp(`^(?:${bases.map(escapeRe).join('|')})${suffixRe}(?:_w\\d+)?$`);
}

/** 源端测试账号的基准名：PG 角色与 MySQL 用户共用（source-fixtures.ts 的 READER / WRITER），集群级 */
export const SRC_ACCOUNT_BASES = ['crm_src_reader', 'crm_src_writer'];

/** 源端测试账号名：基准名 + 运行后缀（沙箱里 _i<票号>）+ worker 后缀 _w<i> */
export function srcAccountName(base: string, runSuffix = process.env.CRM_TEST_RUN_SUFFIX ?? '', workerSuffix = WORKER_SUFFIX): string {
  return `${base}${runSuffix}${workerSuffix}`;
}

/** 从一组账号名里挑出要回收的源端测试账号：带给定票后缀（正则片段，见 suffixPattern）的 reader / writer */
export function accountsToDrop(names: string[], suffixRe: string): string[] {
  return names.filter(n => nameMatcher(SRC_ACCOUNT_BASES, suffixRe).test(n));
}
