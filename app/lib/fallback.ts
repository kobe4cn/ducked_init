// app/lib/fallback.ts —— 落入兜底的取值怎么显示：映射页的合并记录与数据地图的字段抽屉共用（前后端共用的纯函数）
import type { FallbackStat } from '~/.server/pipeline/merge-engine';

/** 一列落入兜底的情况，如「订单状态有 2 种取值（共 312 行）落入兜底：closed（300）、pending_review（12）」；what 换掉「落入兜底」 */
export function fallbackText(label: string, f: Omit<FallbackStat, 'column'>, what = '落入兜底') {
  const values = f.values.map(v => `${v.value}（${v.rows.toLocaleString('zh-CN')}）`).join('、');
  return `${label}有 ${f.distinct} 种取值（共 ${f.rows.toLocaleString('zh-CN')} 行）${what}：${values}${f.distinct > f.values.length ? ' 等' : ''}`;
}
