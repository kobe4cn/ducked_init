// app/components/key-check-findings.tsx —— 业务主键检查没通过时的明细：空值行数与前几个重复键（主键列像敏感信息时只给次数）。数据源页与任务页共用
// duplicateKeyText（app/lib/sources.ts）返回的中文随 #932 翻译，不在本票
import type { KeyCheckTaskResult } from '~/.server/source-key-check';
import { useT } from '~/lib/i18n';
import { duplicateKeyText } from '~/lib/sources';
import { cn } from '~/lib/utils';

export function KeyCheckFindings({ result: { keyColumns, nullRows, duplicates }, className }: {
  result: Pick<KeyCheckTaskResult, 'keyColumns' | 'nullRows' | 'duplicates'>;
  className?: string;
}) {
  const t = useT();
  return (
    <ul className={cn('text-muted-foreground', className)}>
      {/* 中文没有单复数，plural 只为让 ICU 按界面语言格式化数字（千分位，原来的 toLocaleString） */}
      <li data-keycheck-null-rows>{t('空值 {n, plural, other {# 行}}', { n: nullRows })}</li>
      {duplicates.map((d, i) => <li key={i} data-keycheck-duplicate>{duplicateKeyText(keyColumns, d)}</li>)}
    </ul>
  );
}
