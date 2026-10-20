// app/components/sql-editor.tsx —— 工作台的 SQL 编辑器（ADR-0036「编辑器」）：服务端渲染一个带 name 的 textarea，
// 客户端挂载后动态加载 CodeMirror 6（DuckDB 高亮、按目录补全 schema / 表 / 字段、Ctrl/⌘+Enter 提交表单），隐藏 textarea 并把内容同步回去，
// 所以表单提交方式不变；没有 JS 或加载失败时就是原来的 textarea。codemirror 只在这里动态 import，不进服务端与其他页面的包
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { SQLNamespace } from '@codemirror/lang-sql';
import type { EditorView } from '@codemirror/view';

export interface SqlEditorHandle {
  /** 把文本插入到光标处（替换选中的部分），光标移到插入的文本之后 */
  insert(text: string): void;
}

/** 加载后的编辑器：view 与切换补全 schema 的函数 */
interface Mounted { view: EditorView; setSchema(schema: SQLNamespace): void }

export function SqlEditor({ id, name, defaultValue, placeholder, schema, running = false, ref }: {
  id?: string;
  name: string;
  defaultValue: string;
  placeholder?: string;
  /** 补全用的 schema（completionSchema，来自 loader 已按权限过滤的目录） */
  schema: SQLNamespace;
  /** 表单正在提交：与禁用的执行按钮一致，Ctrl/⌘+Enter 不再提交（再提交会中止进行中的查询） */
  running?: boolean;
  ref?: Ref<SqlEditorHandle>;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<Mounted | null>(null);
  const schemaNow = useRef(schema);
  schemaNow.current = schema;
  const runningNow = useRef(running);
  runningNow.current = running;

  useImperativeHandle(ref, () => ({
    insert(text) {
      const cm = mounted.current?.view;
      if (cm) {
        cm.dispatch(cm.state.replaceSelection(text));
        cm.focus();
        return;
      }
      const el = textarea.current;
      if (!el) return;
      el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
      el.focus();
    },
  }), []);

  useEffect(() => {
    const box = textarea.current;
    const parent = host.current;
    if (!box || !parent) return;
    let cancelled = false;
    void Promise.all([
      import('codemirror'), import('@codemirror/view'), import('@codemirror/state'), import('@codemirror/lang-sql'), import('~/lib/duckdb-sql'),
    ]).then(([{ basicSetup, EditorView }, { keymap, placeholder: placeholderExt }, { Compartment, Prec }, { sql }, { duckdbDialect }]) => {
      if (cancelled) return;
      const language = new Compartment();
      const lang = (s: SQLNamespace) => sql({ dialect: duckdbDialect, schema: s, upperCaseKeywords: true });
      const view = new EditorView({
        parent,
        doc: box.value,
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { if (!runningNow.current) box.form?.requestSubmit(); return true; } }])),
          basicSetup,
          language.of(lang(schemaNow.current)),
          placeholder ? placeholderExt(placeholder) : [],
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'SQL', spellcheck: 'false' }),
          EditorView.updateListener.of(u => { if (u.docChanged) box.value = u.state.doc.toString(); }),
          EditorView.theme({
            '&': { fontSize: '0.875rem' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': { fontFamily: 'inherit', minHeight: '10rem' },
            '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
          }),
        ],
      });
      mounted.current = { view, setSchema: s => view.dispatch({ effects: language.reconfigure(lang(s)) }) };
      // 编辑器接手后 textarea 只负责随表单提交：隐藏起来、不再要求必填（隐藏的必填项会让浏览器拦下提交却无处提示）
      box.hidden = true;
      box.required = false;
      parent.hidden = false;
    }).catch(() => { /* 加载失败时继续用 textarea */ });
    return () => {
      cancelled = true;
      mounted.current?.view.destroy();
      mounted.current = null;
      box.hidden = false;
      box.required = true;
      parent.hidden = true;
    };
  }, [placeholder]);

  // 目录随 loader 刷新时换补全 schema，不重建编辑器（内容与撤销历史保留）
  useEffect(() => { mounted.current?.setSchema(schema); }, [schema]);

  return (
    <>
      <textarea
        id={id} name={name} ref={textarea} rows={8} required defaultValue={defaultValue} spellCheck={false} placeholder={placeholder}
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div
        ref={host} hidden data-sql-editor
        className="overflow-hidden rounded-lg border border-input font-mono focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
      />
    </>
  );
}
