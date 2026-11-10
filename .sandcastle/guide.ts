/**
 * 解析 issue 正文与门槛失败摘要的纯函数：plan() 靠它们判断 blocker 和「两张票改同一个文件」，
 * reportFlaky() 靠 flakyFailures 按报错签名去重开偶发失败的票。单独放出来是为了能测。
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

/** 去掉括号（全角、半角）里的说明，比如「（原为 #472，已拆票）」「(#267 已拆分)」。 */
const stripParens = (line: string) => {
  let prev;
  do {
    prev = line;
    line = line.replace(/[（(][^（）()]*[）)]/g, "");
  } while (line !== prev);
  return line;
};

/**
 * `## Blocked by` 里的 blocker 票号。括号里的票号是说明（「#487（原为 #472，已拆票）」「无（#275 已关闭）」），不算；
 * 括号外的都算，所以一行写几个（「#275、#276」「#305, #306」）也认。曾经把括号里拆过的父票也算成 blocker，
 * 父票拆完一直 open，这些票就永远排不上（2026-11-09 #473–#476）。
 */
export const blockersOf = (body: string): number[] => {
  const refs = section(body, "Blocked by")
    .split("\n")
    .flatMap((line) => [...stripParens(line).matchAll(/#(\d+)/g)].map((m) => Number(m[1])));
  return [...new Set(refs)];
};

/**
 * `## Split into` 里的子票：只认列表项开头的票号（`- [ ] #496 …`、`- #68 …`），同一行后面提到的票、
 * 不以票号开头的列表项（「- 删除 … 挪到 #500，排在 #468 之后」）和说明段落都不算。曾经把这些也算成子票，
 * 其中有一张 open，父票就一直不自动关（2026-11-09 #464 被 #500 挡住，#500 又被 #464 挡住）。
 */
export const splitChildren = (body: string): number[] => {
  const refs = section(body, "Split into")
    .split("\n")
    .map((line) => line.match(/^\s*[-*+]\s+(?:\[[ xX]\]\s*)?#(\d+)/)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return [...new Set(refs)];
};

/** 门槛失败摘要里的 FAIL 行：` FAIL  test/….test.ts > 用例名`（与 GATE_SCRIPT `failures()` 的输出格式一致）。 */
const FAIL_LINE = /^ FAIL +(test\/\S+\.test\.tsx?)/;
/** 报错行之后不该当成报错的行：下一条 FAIL、分隔线（⎯ / = 等）、结尾的统计行、缩进的堆栈上下文。 */
const NOT_ERROR = /^(?: FAIL |[\s⎯━─=*]{3,}| *(?:Test Files|Tests) )/;

/**
 * 报错行的归一化签名：去掉首尾空白，把 `host.containers.internal`、IP、UUID 这类易变值换成占位，
 * 数字串（端口、行号、随机数）换成 `N`，截到 160 字。同一根因只有 IP / 端口 / 行号不同的报错
 * 得到同一个签名，reportFlaky 靠它认出「又出现一次」，不再一个文件开一张票（#607）。
 */
export const flakySignature = (errorLine: string): string =>
  errorLine
    .trim()
    .replace(/host\.containers\.internal/g, "<host>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\d+/g, "N")
    .slice(0, 160);

/**
 * 门槛失败摘要里每个失败文件的报错签名：对每个 FAIL 行取它后面第一条非空行当报错（NOT_ERROR 的行跳过并停），
 * 归一化后作为签名；同一个文件只取第一条报错。摘要可能被门槛脚本的 `head -80` 截断，最后一个文件
 * 只剩 FAIL 行、没有报错时签名为空串，reportFlaky 让它退回只按标题去重的老逻辑。
 */
export const flakyFailures = (summary: string): { file: string; signature: string }[] => {
  const lines = summary.split("\n");
  const firsts = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const file = lines[i]!.match(FAIL_LINE)?.[1];
    if (!file || firsts.has(file)) continue;
    let error: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (!line.trim()) continue;
      if (!NOT_ERROR.test(line)) error = line;
      break;
    }
    firsts.set(file, error === undefined ? "" : flakySignature(error));
  }
  return [...firsts].map(([file, signature]) => ({ file, signature }));
};
