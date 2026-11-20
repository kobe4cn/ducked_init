// app/lib/builtin-names.ts —— 平台内置名称的翻译工具（ADR-0060 翻译边界）：标准实体名、标准字段名与各类内置枚举名称
// 按界面语言展示；租户起的名称（人群名、自定义实体名等）不翻译。前后端共用，这里只依赖 app/lib 下的名单常量，
// .server 里的名称（模板名、任务状态、DSL 类型、RFM 默认人群名）由用到的页面自己传入
import type { T } from './i18n';
import { CANONICAL_ENTITIES, CUSTOM_ENTITY_KINDS, FIELD_TYPES } from './canonical-model';
import { ROLE_LABELS } from './roles';
import { SOURCE_KIND_LABELS } from './sources';
import { KNOWLEDGE_SOURCE_KIND_LABELS } from './knowledge-source';
import { MERGE_RULE_LABELS } from './merge-groups';

/**
 * 翻译一个平台内置名称：zh 在名单 known 里时返回 t(zh)（词典缺键由 translate 回退中文原文），
 * 不在名单时原样返回——不经 ICU，租户名称里的 {、' 不会让格式化抛错或吞掉字符。
 * 不给 known 只用于代码里写死的常量名称（模板名、DSL 类型名）
 */
export function builtinName(t: T, zh: string, known?: ReadonlySet<string>): string {
  if (known !== undefined && !known.has(zh)) return zh;
  return t(zh);
}

/** 标准实体名与标准字段名（CANONICAL_ENTITIES 的 label）：数据来自 canonical-model.ts，展示名才翻译，存储与检索仍是中文 */
export const CANONICAL_NAMES: ReadonlySet<string> = new Set(
  CANONICAL_ENTITIES.flatMap(e => [e.label, ...e.fields.map(f => f.label)]),
);

/** 实体 / 字段名之外的内置枚举名称：字段类型、自定义实体类型、角色、数据源类型、知识源类型、合并规则 */
export const ENUM_LABELS: ReadonlySet<string> = new Set([
  ...Object.values(FIELD_TYPES).map(x => x.label),
  ...Object.values(CUSTOM_ENTITY_KINDS),
  ...Object.values(ROLE_LABELS),
  ...Object.values(SOURCE_KIND_LABELS),
  ...Object.values(KNOWLEDGE_SOURCE_KIND_LABELS),
  ...Object.values(MERGE_RULE_LABELS),
]);
