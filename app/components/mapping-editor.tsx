// app/components/mapping-editor.tsx —— 映射 YAML 的编辑框（可在光标处插入文本），以及校验不通过时逐项列出的问题（行、列、位置、说明）
import { useImperativeHandle, useRef, type Ref } from 'react';
import { CircleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';

export interface MappingIssueView { line: number; col: number; path: string; message: string }

export interface MappingEditorHandle {
  /** 把文本插入到光标处（替换选中的部分），光标移到插入的文本之后 */
  insert(text: string): void;
}

export function MappingEditor({ name = 'yaml', defaultValue, readOnly = false, ref, onValueChange }: {
  name?: string;
  defaultValue: string;
  readOnly?: boolean;
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
  }), [onValueChange]);
  return (
    <textarea
      ref={textarea}
      name={name}
      onChange={onValueChange && (e => onValueChange(e.target.value))}
      defaultValue={defaultValue}
      readOnly={readOnly}
      spellCheck={false}
      rows={Math.max(12, defaultValue.split('\n').length + 2)}
      className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted"
    />
  );
}

/** 保存或发布被拒绝的原因；映射文档的问题逐项给出位置 */
export function MappingErrors({ error, issues }: { error: string; issues: MappingIssueView[] }) {
  return (
    <Alert variant="destructive" role="alert">
      <CircleAlert />
      <AlertTitle>{error}</AlertTitle>
      {issues.length > 0 && (
        <AlertDescription>
          <ul className="list-disc space-y-0.5 pl-4">
            {issues.map((i, n) => (
              <li key={n} data-issue-line={i.line} data-issue-path={i.path}>
                {`第 ${i.line} 行第 ${i.col} 列${i.path ? `（${i.path}）` : ''}：${i.message}`}
              </li>
            ))}
          </ul>
        </AlertDescription>
      )}
    </Alert>
  );
}
