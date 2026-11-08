/**
 * 解析 issue 正文的纯函数：plan() 靠它们判断 blocker 和「两张票改同一个文件」，单独放出来是为了能测。
 * 指引的写法见 docs/agents/ticket-sizing.md 的 `## Implementation guide` 模板。
 */

/** 正文里 `## <title>` 一节的内容（到下一个 `## ` 为止），没有这一节时为空串。 */
export const section = (body: string, title: string) => {
  const m = body.match(new RegExp(`^##\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi"));
  return m?.[1] ?? "";
};

const BULLET = /^(\s*)[-*]\s+(.*)$/;
const CHANGE = /^\*\*Change\*\*/;
/** 反引号里的第一个文件路径（`a/b.ts:12-30` → `a/b.ts`）；不像路径的（函数名、SQL）不算。 */
const firstPath = (text: string) => {
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const p = m[1]!.split(":")[0]!;
    if (/^[\w.@-]+(\/[\w.@-]+)*\.\w+$/.test(p) && (p.includes("/") || /^[\w-]+(\.[\w-]+)*\.(ts|tsx|js|mjs|json|md|sql|ya?ml|sh)$/.test(p))) return p;
  }
  return undefined;
};

/**
 * 指引里要改的已有文件（去掉 `:行号`），两种写法都认：
 * - `- **Change**: \`path:行\` …`，一行一个文件（括号说明、全角冒号也行）；
 * - `- **Change**（说明）：` 下面缩进的子条目，每条开头一个 \`path:行\`。
 * `fallback` 是指引里一条 Change 都没有时的兜底：取除 New / Reuse / ADRs / Tests 之外各条里的 \`path:行号\` 引用。
 * 宁可多认（多排队）也不漏认（两张并行的票改同一个文件，到合并才冲突）。
 */
export const changedFiles = (body: string): { files: string[]; fallback: boolean } => {
  const lines = section(body, "Implementation guide").split("\n");
  const files = new Set<string>();
  let changeIndent: number | undefined;
  for (const line of lines) {
    const b = line.match(BULLET);
    if (!b) continue;
    const indent = b[1]!.replace(/\t/g, "  ").length;
    const text = b[2]!;
    if (CHANGE.test(text)) {
      changeIndent = indent;
      const p = firstPath(text);
      if (p) files.add(p);
    } else if (changeIndent !== undefined && indent > changeIndent) {
      const p = firstPath(text);
      if (p) files.add(p);
    } else changeIndent = undefined;
  }
  if (files.size > 0) return { files: [...files], fallback: false };

  let skip = false;
  for (const line of lines) {
    const b = line.match(BULLET);
    if (b && b[1]!.length === 0) skip = /^\*\*(New|Reuse|ADRs|Tests)\*\*/.test(b[2]!);
    if (skip) continue;
    for (const m of line.matchAll(/`([^`\s]+?):\d+[^`]*`/g)) {
      const p = firstPath(`\`${m[1]}\``);
      if (p) files.add(p);
    }
  }
  return { files: [...files], fallback: files.size > 0 };
};
