// app/components/draft-version.tsx —— 双人发布的版本（映射、模板定义共用，ADR-0015）：版本状态，以及草稿的发布与丢弃（发布不了时在按钮位置说明原因）
import { CheckCircle2, Lock, PencilLine, Trash2, Upload } from 'lucide-react';
import { Form } from 'react-router';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/utils';

/** 页面上的一个版本；publishBlocker 是当前成员发布不了这一版草稿的原因（服务端 publishReason），可以发布时为 null */
interface DraftVersion { status: string; version: number; publishBlocker: string | null }

/** 版本状态：已发布（锁定）或草稿，颜色配图标和文字（见 docs/agents/ui.md） */
export function VersionStatus({ v }: { v: Pick<DraftVersion, 'status'> }) {
  return v.status === 'published'
    ? <span className="inline-flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-3.5" />已发布</span>
    : <span className="inline-flex items-center gap-1 text-sm text-amber-600"><PencilLine className="size-3.5" />草稿</span>;
}

/** 草稿的发布（intent=publish，带 version）与丢弃（intent=discard）；discardHint 是丢弃后回到哪里，丢弃前请成员确认 */
export function DraftActions({ v, canDiscard, discardHint, submitting, className }: {
  v: DraftVersion;
  canDiscard: boolean;
  discardHint: string;
  submitting: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      {v.publishBlocker ? (
        <span className="flex max-w-xs items-center gap-1 text-sm text-slate-500" data-publish-blocker><Lock className="size-3.5 shrink-0" />{v.publishBlocker}</span>
      ) : (
        <Form method="post">
          <input type="hidden" name="intent" value="publish" />
          <input type="hidden" name="version" value={v.version} />
          <Button type="submit" disabled={submitting}><Upload />{`发布 v${v.version}`}</Button>
        </Form>
      )}
      {canDiscard && (
        <Form
          method="post"
          onSubmit={e => {
            if (!confirm(`丢弃第 ${v.version} 版草稿？${discardHint}。`)) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="discard" />
          <Button type="submit" variant="destructive" disabled={submitting}><Trash2 />丢弃草稿</Button>
        </Form>
      )}
    </div>
  );
}
