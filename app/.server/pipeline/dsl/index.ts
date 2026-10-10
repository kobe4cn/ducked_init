// app/.server/pipeline/dsl/index.ts —— DSL 种类的注册表（ADR-0025）：每种定义（指标、标签）的校验、编译、用到的实体与依赖。
// 定义的存储、页面与发布流程与种类无关，按 kind 从这里取
import { checkMetric, compileMetric, metricDependencies, metricEntities, type Dependencies, type DslCheck, type DslContext } from './metric-spec';
import { checkTag, compileTag, tagDependencies, tagEntities } from './tag-spec';

/** 一种定义：check 通过时得出的 spec 原样交给 compile 与 entities；key 是定义行上不变的键。dependencies 只看结构，已发布版本的 YAML 解析后直接交给它 */
export interface DslKindDef<S = unknown> {
  label: string;
  check: (text: string, ctx: DslContext) => DslCheck<S>;
  compile: (spec: S, ctx: DslContext, asOf: string, key: string) => string;
  entities: (spec: S, ctx: DslContext) => string[];
  dependencies: (spec: S) => Dependencies;
}

/** 在定义处检查各项的 spec 一致，之后按 kind 取用时不再区分 */
const defineKind = <S>(def: DslKindDef<S>) => def as DslKindDef;

export const DSL_KINDS = {
  metric: defineKind({ label: '指标', check: checkMetric, compile: compileMetric, entities: metricEntities, dependencies: metricDependencies }),
  tag: defineKind({ label: '标签', check: checkTag, compile: compileTag, entities: tagEntities, dependencies: tagDependencies }),
};

export type DslKind = keyof typeof DSL_KINDS;

export const isDslKind = (kind: string): kind is DslKind => Object.hasOwn(DSL_KINDS, kind);
