// app/components/assistant-markdown.tsx —— 助手回复按 Markdown 渲染（#1186）：加粗、行内代码、列表、GFM 表格、代码块。
// 依赖 react-markdown + remark-gfm，只在助手面板用（docs/agents/ui.md 的例外）；不走 dangerouslySetInnerHTML。
// 安全约束：原始 HTML 由 remarkHtmlAsText 转成文字（<script> 以转义文字出现，不成为元素）；链接只保留站内相对路径，
// 外链、协议相对地址、javascript: 等都渲染成纯文字；图片只显示 alt，不加载外部资源。
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router';

type MdNode = { type: string; value?: string; children?: MdNode[] };

/** 块级位置（根节点或容器的直接子节点、不在段落等行内容器里）的 html 节点要包进段落，否则文字节点没有块级外壳 */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

/** remark 插件：把 mdast 里的 html 节点改成 text 节点，value 不变；行内的原地改，块级的包进 paragraph */
export function remarkHtmlAsText() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.map(child => {
      if (child.type !== 'html') { walk(child); return child; }
      const text: MdNode = { type: 'text', value: child.value ?? '' };
      return BLOCK_PARENTS.has(node.type) ? { type: 'paragraph', children: [text] } : text;
    });
  };
  return (tree: MdNode) => { walk(tree); };
}

/** 站内相对路径：以单个 / 开头，排除 //host 与 /\host 这种会被浏览器当成外链的写法 */
export function isInternalHref(href: string | undefined): href is string {
  return !!href && href.startsWith('/') && href[1] !== '/' && href[1] !== '\\';
}

const components: Components = {
  a: ({ href, children }) => isInternalHref(href)
    ? <Link to={href} className="underline">{children}</Link>
    : <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
  ul: ({ children }) => <ul className="list-disc pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5">{children}</ol>,
  // 面板只有 420px 宽：表格按内容宽度排、单元格最宽 14rem 再折行，列多时整表横向滚动，而不是把窄列挤成一字一行
  table: ({ children }) => <div className="overflow-x-auto"><table className="w-max border-collapse text-xs">{children}</table></div>,
  th: ({ children }) => <th className="whitespace-nowrap border px-2 py-1 text-left align-top font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1 align-top"><div className="max-w-56">{children}</div></td>,
  pre: ({ children }) => <pre className="overflow-x-auto rounded-lg bg-slate-800 p-2 font-mono text-xs text-slate-100">{children}</pre>,
  // 代码块里的 code 继承 pre 的样式，只有行内 code 加浅底：代码块带 language-* 类，或内容以换行结尾（hast 给块级代码补的）
  code: ({ className, children }) => {
    const inBlock = !!className || String(children).endsWith('\n');
    return inBlock ? <code className={className}>{children}</code> : <code className="rounded bg-slate-100 px-1 font-mono text-xs">{children}</code>;
  },
};

/** 助手消息的 Markdown 渲染；成员自己的消息不走这里（仍按纯文本） */
export function AssistantMarkdown({ content }: { content: string }): ReactNode {
  return (
    <div data-markdown className="space-y-2 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkHtmlAsText]} components={components}>{content}</ReactMarkdown>
    </div>
  );
}
