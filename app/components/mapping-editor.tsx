// app/components/mapping-editor.tsx —— 映射 YAML 的编辑框（可在光标处插入文本），以及校验不通过时逐项列出的问题（行、列、位置、说明、改好的写法），
// 保存通过但检查有提示（notices，如 customer_source 写的就是本数据源）时逐项列出的提示，以及编辑时实时校验的结果（点一条问题定位到 YAML 里那一处）
import { useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import type { MappingValidationView } from '~/components/use-mapping-validation';
import { lineRangeOf, offsetOf } from '~/lib/text-offset';

export interface MappingIssueView { line: number; col: number; path: string; message: string; hint?: string }

export interface MappingEditorHandle {
  /** 把文本插入到光标处（替换选中的部分），光标移到插入的文本之后 */
  insert(text: string): void;
  /** 光标移到第 line 行第 col 列（选中到行尾）、聚焦并滚到那一行 */
  jump(line: number, col: number): void;
}

export function MappingEditor({ name = 'yaml', defaultValue, value, readOnly = false, hidden, invalid, ref, onValueChange }: {
  name?: string;
  defaultValue: string;
  /** 给出时由外部控制内容（与 onValueChange 一起用） */
  value?: string;
  readOnly?: boolean;
  /** 隐藏但仍随表单提交 */
  hidden?: boolean;
  /** 实时校验有问题时为真（设 aria-invalid） */
  invalid?: boolean;
  ref?: Ref<MappingEditorHandle>;
  /** 内容变化（输入或插入）后的全文 */
  onValueChange?: (value: string) => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    insert(text) {
      const el = textarea.current;
      if (!el || el.readOnly) return;
      el.focus();
      el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
      onValueChange?.(el.value);
    },
    jump(line, col) {
      const el = textarea.current;
      if (!el) return;
      // 编辑框按行数撑高、很少自己滚动，主要滚的是页面：把那一行滚到视口上部三分之一处
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      const top = (line - 1) * lineHeight;
      el.focus({ preventScroll: true });
      el.setSelectionRange(offsetOf(el.value, line, col), lineRangeOf(el.value, line)[1], 'backward');
      el.scrollTop = Math.max(0, top - el.clientHeight / 3);
      window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY + top - el.scrollTop - window.innerHeight / 3) });
    },
  }), [onValueChange]);
  return (
    <textarea
      ref={textarea}
      name={name}
      onChange={onValueChange && (e => onValueChange(e.target.value))}
      {...(value === undefined ? { defaultValue } : { value })}
      readOnly={readOnly}
      hidden={hidden}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      rows={Math.max(12, (value ?? defaultValue).split('\n').length + 2)}
      className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 read-only:bg-muted"
    />
  );
}

/** 不拦保存与发布的提示（行列 + 文字）；children 是标题下的附加内容 */
export function MappingNotices({ title, notices, children }: { title: string; notices: MappingIssueView[]; children?: ReactNode }) {
  return (
    <Alert role="status" data-mapping-notices>
      <AlertTriangle className="text-amber-600" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {children}
        <ul className="list-disc space-y-0.5 pl-4">
          {notices.map((i, n) => (
            <li key={n} data-notice-line={i.line} data-notice-path={i.path}>{`第 ${i.line} 行第 ${i.col} 列${i.path ? `（${i.path}）` : ''}：${i.message}`}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

const issueText = (i: MappingIssueView) => `第 ${i.line} 行第 ${i.col} 列${i.path ? `（${i.path}）` : ''}：${i.message}`;

/** 保存或发布被拒绝的原因；映射文档的问题逐项给出位置，能给出改法时附上改好的写法。给出 onJump 时每条位置是按钮，点击定位到 YAML 里那一处 */
export function MappingErrors({ error, issues, onJump }: { error: string; issues: MappingIssueView[]; onJump?: (line: number, col: number) => void }) {
  return (
    <Alert variant="destructive" role={onJump ? undefined : 'alert'}>
      <CircleAlert />
      <AlertTitle>{error}</AlertTitle>
      {issues.length > 0 && (
        <AlertDescription>
          <ul className="list-disc space-y-0.5 pl-4">
            {issues.map((i, n) => (
              <li key={n} data-issue-line={i.line} data-issue-path={i.path}>
                {onJump
                  ? <button type="button" className="text-left hover:underline" title="定位到 YAML 里这一处" onClick={() => onJump(i.line, i.col)}>{issueText(i)}</button>
                  : issueText(i)}
                {i.hint && <pre data-issue-hint className="mt-1 whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono text-foreground">{i.hint}</pre>}
              </li>
            ))}
          </ul>
        </AlertDescription>
      )}
    </Alert>
  );
}

/** 实时校验的结果，放在编辑框下方：有问题时逐项列出（点击定位），合格时「校验通过」并列出提示；还没校验过时不显示 */
export function LiveMappingIssues({ validation, onJump }: { validation: MappingValidationView; onJump: (line: number, col: number) => void }) {
  const { state, error, issues, notices } = validation;
  if (state === 'idle') return null;
  return (
    <div data-live-issues={state} aria-live="polite" className="space-y-2">
      {state === 'checking' && (
        <p className="flex items-center gap-1 text-sm text-slate-500"><Loader2 className="size-3.5 animate-spin" />正在校验…</p>
      )}
      {error && <MappingErrors error={error} issues={issues} onJump={onJump} />}
      {state === 'ok' && (
        <p className="flex items-center gap-1 text-sm text-emerald-600"><CheckCircle2 className="size-4" />校验通过</p>
      )}
      {state === 'ok' && notices.length > 0 && <MappingNotices title="保存时会有这些提示（不影响保存）" notices={notices} />}
    </div>
  );
}
