// app/components/copy-button.tsx —— 复制按钮：把给定文字写进剪贴板，成功后短暂显示「已复制」。
// 剪贴板在非安全上下文（http 且非 localhost）不可用，这时显示「复制失败」，成员可以手动选中复制
import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from '~/lib/i18n';
import { Button } from '~/components/ui/button';

const RESET_MS = 2000;

export function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), RESET_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = () => {
    // 非安全上下文里 navigator.clipboard 是 undefined，直接按失败处理
    if (!navigator.clipboard) { setState('failed'); return; }
    navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed'));
  };
  let label = t('复制');
  if (state === 'copied') label = t('已复制');
  else if (state === 'failed') label = t('复制失败');
  return (
    <Button type="button" variant="outline" size="xs" onClick={copy} aria-live="polite">
      {state === 'copied' ? <Check /> : <Copy />}
      {label}
    </Button>
  );
}
