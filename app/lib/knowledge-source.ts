// app/lib/knowledge-source.ts —— 知识来源（ADR-0046 入口③）的种类登记表与上限：成员粘贴的数据字典、指标说明或 SQL 原文按段落、版本保存（#525）。
// 前后端共用：服务端用它们校验，粘贴页（#527）用种类名称与字数、段数上限做提示。上限只防把整篇文档粘进来，不做内容识别
export const KNOWLEDGE_SOURCE_KINDS = ['dictionary', 'metric', 'sql'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];
export const KNOWLEDGE_SOURCE_KIND_LABELS: Record<KnowledgeSourceKind, string> = {
  dictionary: '数据字典',
  metric: '指标说明',
  sql: 'SQL',
};

/** 标题去掉首尾空白后最多的字数 */
export const KNOWLEDGE_SOURCE_TITLE_MAX = 100;
/** 正文去掉首尾空白后最多的字数 */
export const KNOWLEDGE_SOURCE_BODY_MAX = 20_000;
/** 正文按种类切段后最多的段数 */
export const KNOWLEDGE_SOURCE_PARAGRAPHS_MAX = 200;
