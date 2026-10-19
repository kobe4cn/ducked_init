// app/.server/pipeline/templates/test-versions.ts —— 只给测试用的模板新版本：只在环境变量 TEMPLATE_TEST_VERSIONS=1 时生效（ADR-0021），
// 开关打开时 latestTemplate 返回这里的版本，注册表里的当前版本改由 templateAt 按版本号取得；不设开关时注册表与没有这个文件时完全一样。
// 测试版本不改参数键：RFM 只改 compile，锁定旧版本的定义参数在新版本下也能校验；流失预警另收紧一个参数的范围，用来测新版本拒绝旧参数
import type { Template, TemplateId } from '.';

/** 模板 → 由注册表里的当前版本生成测试用的下一版 */
export const TEST_VERSIONS: Partial<Record<TemplateId, (current: Template<unknown, unknown>) => Template<unknown, unknown>>> = {
  // 每个人的分群都带上 v<版本>: 前缀（现在是 v2:），结果一眼能看出按哪一版算的
  rfm: current => {
    const version = current.version + 1;
    return { ...current, version, compile: (p, has) => `SELECT * REPLACE ('v${version}:' || segment AS segment) FROM (${current.compile(p, has)})` };
  },
  // 每个人的 at_risk 取反（升级预览里每个人都换了取值）；minOrders 收紧到不超过 10
  churn: current => {
    const version = current.version + 1;
    const capped = (params: Record<string, unknown>) => {
      if (typeof params.minOrders === 'number' && params.minOrders > 10) throw new Error('参数 minOrders 在第 2 版不能超过 10');
      return params;
    };
    return {
      ...current, version,
      parse: params => current.parse(capped(params)),
      parseDefinition: params => current.parseDefinition(capped(params)),
      compile: (p, has) => `SELECT * REPLACE (NOT at_risk AS at_risk) FROM (${current.compile(p, has)})`,
    };
  },
};
