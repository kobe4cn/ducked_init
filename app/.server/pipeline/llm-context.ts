// app/.server/pipeline/llm-context.ts —— 发给模型服务的表上下文（ADR-0035，纯函数）：默认只有表结构与采集时的列统计；
// 租户打开「发送脱敏样本」时调用方另外传入原始层的几行样本（敏感列已是 ADR-0022 预览用的加盐哈希）。
// 列统计里敏感列本来就不存 top、文本列不存 min / max（ADR-0016），这里原样带过去。
// 逐个字段抄写是有意的：ColumnContext 是发给模型的字段白名单，ColumnProfile 以后加字段不会自动发出去
import type { ColumnProfile, TableProfile } from './source-engine';

export interface ColumnContext {
  name: string;
  type: string;
  nullRate: number;
  distinct: number;
  min: string | null;
  max: string | null;
  length: ColumnProfile['length'] | null;
  formats: ColumnProfile['formats'] | null;
  top: ColumnProfile['top'] | null;
}

export interface TableContext {
  table: string;
  rows: number;
  primaryKey: string[];
  keyCandidates: string[];
  columns: ColumnContext[];
  /** 只在租户允许发送样本、且拿到了样本时才有 */
  samples?: Record<string, unknown>[];
}

/** 表统计（与可选的脱敏样本行）→ 表上下文；samples 为 undefined 时不带这个键 */
export function buildTableContext(profile: TableProfile, samples?: Record<string, unknown>[]): TableContext {
  return {
    table: profile.name,
    rows: profile.rows,
    // 旧的采集结果里没有主键信息
    primaryKey: profile.primaryKey ?? [],
    keyCandidates: profile.keyCandidates ?? [],
    columns: profile.columns.map(c => ({
      name: c.name,
      type: c.type,
      nullRate: c.nullRate,
      distinct: c.distinct,
      min: c.min,
      max: c.max,
      length: c.length ?? null,
      formats: c.formats ?? null,
      top: c.top ?? null,
    })),
    ...(samples !== undefined && { samples }),
  };
}
