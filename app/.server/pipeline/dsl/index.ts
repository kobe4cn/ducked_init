// app/.server/pipeline/dsl/index.ts —— DSL 种类的注册表（ADR-0025）：每种定义（指标、标签）的校验、编译与用到的实体。
// 定义的存储、页面与发布流程与种类无关，按 kind 从这里取
import { checkMetric, compileMetric, metricEntities } from './metric-spec';

export const DSL_KINDS = {
  metric: { label: '指标', check: checkMetric, compile: compileMetric, entities: metricEntities },
} as const;

export type DslKind = keyof typeof DSL_KINDS;

export const isDslKind = (kind: string): kind is DslKind => Object.hasOwn(DSL_KINDS, kind);
