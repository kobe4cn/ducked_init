// app/lib/custom-entity-text.ts —— 自定义实体详情页的说明文字按界面语言出句子（#1044，ADR-0060）：
// 丢弃草稿的说明只出现在 DraftActions 的 confirm() 里（SSR 不输出事件处理器，HTTP 测试测不到），提成纯函数单测。
// 句子不拼碎片：有没有配套映射草稿各是一条完整词条；映射按「{source}」{table} 拼、分隔符走 t('、')（英文 ', '）
import type { T } from './i18n';

/** 丢弃草稿的确认说明：发布过的回到已发布版本；从没发布过的整个实体被删，配套的映射草稿（loader 下发 {source, table}）一并丢弃 */
export function discardHint(t: T, live: boolean, unpublishedMappings: readonly { source: string; table: string }[]): string {
  if (live) return t('回到最近的已发布版本');
  if (!unpublishedMappings.length) return t('这个自定义实体从没发布过，将被删除');
  return t('这个自定义实体从没发布过，将被删除，目标是它的映射草稿一并丢弃：{list}', {
    list: unpublishedMappings.map(m => t('「{source}」{table}', { source: m.source, table: m.table })).join(t('、')),
  });
}
