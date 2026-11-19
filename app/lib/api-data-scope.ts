// app/lib/api-data-scope.ts —— API Key 的数据范围（ADR-0061「数据范围」，#975）：点查只返回范围内的标签、指标与 RFM。
// 类型与模板判定放 lib 前后端共用（下一个子 issue 的创建页面也要用）；按 Key 裁剪响应的 filterProfile 在 .server/api-data-scope.ts。
// 不叫 api-data-scopes：单个范围只有一份，与接口范围的 app/lib/api-scopes.ts 也只差一个 s，命名分开免得混
/** 全开（迁移默认值），或收窄到指定 key 的标签、指标与 RFM 开关 */
export type ApiDataScope = { all: true } | { all: false; tags: string[]; metrics: string[]; rfm: boolean };

/** 模板在不在数据范围内：all 全开一律在；否则 tag:<key> 看 tags、metric:<key> 看 metrics、rfm 看 rfm，
 *  其他模板（user360 / cohort / repurchase / clv / churn）一律不在。jsonb 读出来没校验，缺的字段按空数组 / false 处理 */
export function templateInScope(template: string, scope: ApiDataScope): boolean {
  if (scope.all === true) return true;
  if (template.startsWith('tag:')) return (scope.tags ?? []).includes(template.slice('tag:'.length));
  if (template.startsWith('metric:')) return (scope.metrics ?? []).includes(template.slice('metric:'.length));
  return template === 'rfm' && scope.rfm === true;
}
