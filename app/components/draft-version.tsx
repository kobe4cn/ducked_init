// app/components/draft-version.tsx —— 双人发布的版本（映射、模板定义、源视图共用，ADR-0015）：版本状态，以及草稿的发布与丢弃（发布不了时在按钮位置说明原因）
import { CheckCircle2, Equal, Lock, PencilLine, Trash2, Upload } from 'lucide-react';
import { Form } from 'react-router';
import { Button } from '~/components/ui/button';
import { useT } from '~/lib/i18n';
import { cn } from '~/lib/utils';

/** 页面上的一个版本；publishBlocker 是当前成员发布不了这一版草稿的原因（服务端 publishReason，中文，随 #932 翻译），可以发布时为 null */
interface DraftVersion { status: string; version: number; publishBlocker: string | null }

/** 版本状态：已发布（锁定）或草稿，颜色配图标和文字（见 docs/agents/ui.md）；
 * sameAs 有值时草稿另标「与 vN 相同」（与当前生效已发布版内容相同，服务端 sameAsPublished 算出），发布会被拒 */
export function VersionStatus({ v, sameAs }: { v: Pick<DraftVersion, 'status'>; sameAs?: number | null }) {
  const t = useT();
  return v.status === 'published'
    ? <span className="inline-flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-3.5" />{t('已发布')}</span>
    : (
      <span className="inline-flex items-center gap-1 text-sm text-amber-600">
        <PencilLine className="size-3.5" />{t('草稿')}
        {sameAs != null && <span className="inline-flex items-center gap-1" data-same-as><Equal className="size-3.5" />{t('与 v{n} 相同', { n: sameAs })}</span>}
      </span>
    );
}

/** 草稿的发布（intent=publish，带 version）与丢弃（intent=discard）；discardHint 是丢弃后回到哪里（中文，随 #932 翻译），丢弃前请成员确认 */
export function DraftActions({ v, canDiscard, discardHint, submitting, className }: {
  v: DraftVersion;
  canDiscard: boolean;
  discardHint: string;
  submitting: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {v.publishBlocker ? (
        <span className="flex max-w-xs items-center gap-1 text-sm text-slate-500" data-publish-blocker><Lock className="size-3.5 shrink-0" />{v.publishBlocker}</span>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="publish" />
          <input type="hidden" name="version" value={v.version} />
          <Button type="submit" disabled={submitting}><Upload />{t('发布 v{n}', { n: v.version })}</Button>
        </Form>
      )}
      {canDiscard && (
        <Form
          method="post"
          onSubmit={e => {
            if (!confirm(t('丢弃第 {version} 版草稿？{hint}。', { version: v.version, hint: discardHint }))) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="discard" />
          <Button type="submit" variant="destructive" disabled={submitting}><Trash2 />{t('丢弃草稿')}</Button>
        </Form>
      )}
    </div>
  );
}
