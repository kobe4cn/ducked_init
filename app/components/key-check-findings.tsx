// app/components/key-check-findings.tsx —— 业务主键检查没通过时的明细：空值行数与前几个重复键（主键列像敏感信息时只给次数）。数据源页与任务页共用
import type { KeyCheckTaskResult } from '~/.server/source-key-check';
import { duplicateKeyText } from '~/lib/sources';
import { cn } from '~/lib/utils';

export function KeyCheckFindings({ result: { keyColumns, nullRows, duplicates }, className }: {
  result: Pick<KeyCheckTaskResult, 'keyColumns' | 'nullRows' | 'duplicates'>;
  className?: string;
}) {
  return (
    <ul className={cn('text-muted-foreground', className)}>
      <li data-keycheck-null-rows>{`空值 ${nullRows.toLocaleString('zh-CN')} 行`}</li>
      {duplicates.map((d, i) => <li key={i} data-keycheck-duplicate>{duplicateKeyText(keyColumns, d)}</li>)}
    </ul>
  );
}
