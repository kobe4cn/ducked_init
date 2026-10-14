// app/lib/merge-groups.ts —— 合并组的存活规则（ADR-0032）。前后端共用（页面要显示规则名称与说明）
export const MERGE_RULE_KINDS = ['priority', 'latest', 'coalesce'] as const;
export type MergeRuleKind = (typeof MERGE_RULE_KINDS)[number];

/** 存活规则：priority 整行取优先级最高且有该键的映射；latest 整行取 field 最新的一边，平手按优先级；coalesce 逐字段按优先级取第一个非空值 */
export type MergeRule = { kind: 'priority' } | { kind: 'latest'; field: string } | { kind: 'coalesce' };

export const MERGE_RULE_LABELS: Record<MergeRuleKind, string> = {
  priority: '按优先级',
  latest: '取最新',
  coalesce: '逐字段补齐',
};

export const MERGE_RULE_HINTS: Record<MergeRuleKind, string> = {
  priority: '整行取优先级最高、有这个主键的映射',
  latest: '整行取所选字段最新的一边，一样新时按优先级',
  coalesce: '逐个字段按优先级取第一个非空值',
};

/** 规则的文字说明（如「取最新（updated_at）」） */
export const ruleText = (rule: MergeRule) => (rule.kind === 'latest' ? `${MERGE_RULE_LABELS.latest}（${rule.field}）` : MERGE_RULE_LABELS[rule.kind]);
