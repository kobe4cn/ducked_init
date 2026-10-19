// app/.server/pipeline/templates/test-versions.ts —— 只给测试用的模板新版本：只在环境变量 TEMPLATE_TEST_VERSIONS=1 时生效（ADR-0021），
// 开关打开时 latestTemplate 返回这里的版本，注册表里的当前版本改由 templateAt 按版本号取得；不设开关时注册表与没有这个文件时完全一样。
// 测试版本只改 compile、不改参数键，锁定旧版本的定义参数在新版本下也能校验
import type { Template, TemplateId } from '.';

/** 模板 → 由注册表里的当前版本生成测试用的下一版 */
export const TEST_VERSIONS: Partial<Record<TemplateId, (current: Template<unknown, unknown>) => Template<unknown, unknown>>> = {
  // 每个人的分群都带上 v<版本>: 前缀（现在是 v2:），结果一眼能看出按哪一版算的
  rfm: current => {
    const version = current.version + 1;
    return { ...current, version, compile: (p, has) => `SELECT * REPLACE ('v${version}:' || segment AS segment) FROM (${current.compile(p, has)})` };
  },
};
