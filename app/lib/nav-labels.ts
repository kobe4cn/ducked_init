// app/lib/nav-labels.ts —— 顶栏导航 label 的翻译（ADR-0060，#1012）：导航定义（app/.server/nav.ts）保持中文
// （label 还被当作 details 的 key 和当前分组的比较值），只在渲染时经这张表换语言。
// 值都写成字面量 t('…') 才能与英文词典对账（test/i18n-catalog.test.ts）；不在表里的（如「API Key」）原样返回
import type { T } from './i18n';

/** 中文 label → 译文；与 app/.server/nav.ts 的全部 label 一一对照，术语以 CONTEXT.md 的英文名为准 */
const NAV_LABELS = (t: T): Record<string, string> => ({
  概览: t('概览'),
  数据接入: t('数据接入'),
  数据源: t('数据源'),
  映射: t('映射'),
  自定义实体: t('自定义实体'),
  数据质量: t('数据质量'),
  数据模型: t('数据模型'),
  标准模型: t('标准模型'),
  数据地图: t('数据地图'),
  业务知识: t('业务知识'),
  分析: t('分析'),
  指标与标签: t('指标与标签'),
  查询: t('查询'),
  任务: t('任务'),
  管理: t('管理'),
  成员: t('成员'),
  模型服务: t('模型服务'),
  模型调用: t('模型调用'),
  审计日志: t('审计日志'),
  解密: t('解密'),
});

export function navLabel(t: T, zh: string): string {
  return NAV_LABELS(t)[zh] ?? zh;
}
