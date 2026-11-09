// app/lib/tag-vocab.ts —— 标签 DSL 的词汇表（前后端共用）：比较运算的常量与中文说明。
// 常量原在 .server/pipeline/dsl/tag-spec.ts；标签表单（tag-form.ts，客户端也要用）需要同一份，
// 又不能从 .server 值 import（React Router 会拦客户端对 .server 的值 import，见 test/client-build.test.ts），所以搬到这里，那边原名 re-export。
// 只能 import app/lib 里的东西（.server 的只能 import type）；说明表的文字写给表单下拉直接用，不另写一套
export const TAG_CONDITIONS = ['gte', 'gt', 'lte', 'lt', 'eq'] as const;
export type TagCondition = (typeof TAG_CONDITIONS)[number];

export const TAG_CONDITION_TEXT = {
  gte: '大于等于取值（≥）',
  gt: '大于取值（>）',
  lte: '小于等于取值（≤）',
  lt: '小于取值（<）',
  eq: '等于取值（=）',
} satisfies Record<TagCondition, string>;
