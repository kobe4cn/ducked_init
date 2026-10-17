// app/lib/mapping-diff.ts —— 映射两个版本合并计划的结构化差异（发布前审阅草稿用）：列的新增、删除与改动，去重键、取最新字段、身份打通匹配字段、键空间、属性取舍名次、行过滤的变化，自定义断言的增删改。
// 只比用户写的部分：标准枚举（enum）来自标准模型，不算改动；值字典按内容比较，不看键的顺序。
// 自定义断言按断言名（custom:<字段>:<检查>）对齐，结果只有断言名，不带 values / min / max
import type { CustomAssertion } from '~/.server/pipeline/custom-assertions';
import type { MergePlan, PlanColumn } from '~/.server/pipeline/mapping-spec';

/** 列上可能改动的属性 */
export type ColumnField = 'type' | 'expr' | 'dictionary' | 'otherwise' | 'sensitive' | 'keySpace' | 'customerSource';

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
    /** 属性取舍名次（survivorship.priority） */
    survivorship: Change<number | null>;
    /** 行过滤表达式，只比较文本 */
    where: Change<string | null>;
    /** 自定义断言的断言名：新增、删除，以及级别、min / max、values 改了的 */
    assertions: { added: string[]; removed: string[]; changed: string[] };
    /** 两版的计划没有差异 */
    empty: boolean;
  };

const sameDictionary = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) => {
  const ka = Object.keys(a ?? {});
  return ka.length === Object.keys(b ?? {}).length && ka.every(k => b?.[k] === a?.[k]);
};

const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));

/** 与 custom-assertions.ts 的 customAssertionName 相同（app/lib 只引用 .server 的类型） */
const assertionName = (a: Pick<CustomAssertion, 'field' | 'check'>) => `custom:${a.field}:${a.check}`;

const sameAssertion = (a: CustomAssertion, b: CustomAssertion) =>
  a.level === b.level && a.min === b.min && a.max === b.max && sameList(a.values ?? null, b.values ?? null);

/** 自定义断言的增删改；老版本的计划没有 assertions */
function assertionChanges(prev: readonly CustomAssertion[], next: readonly CustomAssertion[]) {
  const before = new Map(prev.map(a => [assertionName(a), a]));
  const after = new Set(next.map(assertionName));
  return {
    added: next.map(assertionName).filter(n => !before.has(n)),
    removed: [...before.keys()].filter(n => !after.has(n)),
    changed: next.filter(a => before.has(assertionName(a)) && !sameAssertion(before.get(assertionName(a))!, a)).map(assertionName),
  };
}

/** 列的哪些属性改了；otherwise 不写（undefined）与写成空（null）含义不同 */
function columnChanges(a: PlanColumn, b: PlanColumn): ColumnField[] {
  return ([
    ['type', a.type === b.type],
    ['expr', a.expr === b.expr],
    ['dictionary', sameDictionary(a.dictionary, b.dictionary)],
    ['otherwise', a.otherwise === b.otherwise],
    ['sensitive', !!a.sensitive === !!b.sensitive],
    ['keySpace', a.keySpace === b.keySpace],
    ['customerSource', a.customerSource === b.customerSource],
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
  const change = <T extends readonly string[] | string | number | null>(from: T, to: T, same: (a: T, b: T) => boolean): Change<T> => (same(from, to) ? null : { from, to });
  const key = change(prev.key, next.key, sameList);
  const latest = change(prev.latest, next.latest, (a, b) => a === b);
  const identity = change(prev.identity?.match ?? null, next.identity?.match ?? null, sameList);
  const keySpace = change(prev.keySpace ?? null, next.keySpace ?? null, (a, b) => a === b);
  const survivorship = change(prev.survivorship?.priority ?? null, next.survivorship?.priority ?? null, (a, b) => a === b);
  const where = change(prev.where ?? null, next.where ?? null, (a, b) => a === b);
  const assertions = assertionChanges(prev.assertions ?? [], next.assertions ?? []);
  return {
    first: false, added, removed, changed, key, latest, identity, keySpace, survivorship, where, assertions,
    empty: !added.length && !removed.length && !changed.length && !key && !latest && !identity && !keySpace && !survivorship && !where
      && !assertions.added.length && !assertions.removed.length && !assertions.changed.length,
  };
}
