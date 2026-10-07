// app/lib/mapping-diff.ts —— 映射两个版本合并计划的结构化差异（发布前审阅草稿用）：列的新增、删除与改动，去重键、取最新字段、身份打通匹配字段、键空间的变化。
// 只比用户写的部分：标准枚举（enum）来自标准模型，不算改动；值字典按内容比较，不看键的顺序
import type { MergePlan, PlanColumn } from '~/.server/pipeline/mapping-spec';

/** 列上可能改动的属性 */
export type ColumnField = 'type' | 'expr' | 'dictionary' | 'otherwise' | 'sensitive' | 'keySpace';

/** 一项配置前后的值，没变化时整项为 null */
export type Change<T> = { from: T; to: T } | null;

export type PlanDiff =
  | { first: true }
  | {
    first: false;
    added: string[];
    removed: string[];
    changed: { name: string; fields: ColumnField[] }[];
    key: Change<string[]>;
    latest: Change<string | null>;
    identity: Change<string[] | null>;
    /** 映射的键空间 */
    keySpace: Change<string | null>;
    /** 两版的计划没有差异 */
    empty: boolean;
  };

const sameDictionary = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) => {
  const ka = Object.keys(a ?? {});
  return ka.length === Object.keys(b ?? {}).length && ka.every(k => b?.[k] === a?.[k]);
};

const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/** 列的哪些属性改了；otherwise 不写（undefined）与写成空（null）含义不同 */
function columnChanges(a: PlanColumn, b: PlanColumn): ColumnField[] {
  return ([
    ['type', a.type === b.type],
    ['expr', a.expr === b.expr],
    ['dictionary', sameDictionary(a.dictionary, b.dictionary)],
    ['otherwise', a.otherwise === b.otherwise],
    ['sensitive', !!a.sensitive === !!b.sensitive],
    ['keySpace', a.keySpace === b.keySpace],
  ] as const).flatMap(([field, same]) => (same ? [] : [field]));
}

/** next 相对 prev（最新的已发布版本）的差异；prev 为 null 表示 next 是首个版本 */
export function diffPlans(prev: MergePlan | null, next: MergePlan): PlanDiff {
  if (!prev) return { first: true };
  const before = new Map(prev.columns.map(c => [c.name, c]));
  const after = new Set(next.columns.map(c => c.name));
  const added = next.columns.filter(c => !before.has(c.name)).map(c => c.name);
  const removed = prev.columns.filter(c => !after.has(c.name)).map(c => c.name);
  const changed = next.columns.flatMap(c => {
    const old = before.get(c.name);
    const fields = old ? columnChanges(old, c) : [];
    return fields.length ? [{ name: c.name, fields }] : [];
  });
  const change = <T extends readonly string[] | string | null>(from: T, to: T, same: (a: T, b: T) => boolean): Change<T> => (same(from, to) ? null : { from, to });
  const key = change(prev.key, next.key, sameList);
  const latest = change(prev.latest, next.latest, (a, b) => a === b);
  const identity = change(prev.identity?.match ?? null, next.identity?.match ?? null, sameList);
  const keySpace = change(prev.keySpace ?? null, next.keySpace ?? null, (a, b) => a === b);
  return {
    first: false, added, removed, changed, key, latest, identity, keySpace,
    empty: !added.length && !removed.length && !changed.length && !key && !latest && !identity && !keySpace,
  };
}
