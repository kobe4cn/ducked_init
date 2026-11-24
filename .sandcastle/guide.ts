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
 * 只追加的索引文件：几张票同时往末尾追加行也不会真冲突（rebase-prompt.md 已写明两边都保留），
 * 不拿来判断「两张票改同一个文件」。曾经因为 `test/CATALOG.md` 几乎每张加测试的票都改，
 * 这类票只能一张接一张做，两个空位经常只用上一个（2026-11 #732）。
 */
// 翻译表 app/i18n/en.*.json 按键增加，几乎每张双语票都改，算追加型文件，双语票才能两张并行（2026-11-22）。
export const APPEND_ONLY = new Set([
  "test/CATALOG.md",
  "test/README.md",
  "CONTEXT.md",
  "docs/adr/README.md",
  "app/i18n/en.client.json",
  "app/i18n/en.server.json",
  // 中文棘轮基线：每张双语票按文件下调计数，冲突时 rebase 用 `npm run i18n:ratchet -- --update` 重算（2026-11-22）。
  "test/i18n-ratchet-baseline.json",
]);

/**
 * 指引里要改的已有文件（去掉 `:行号`），两种写法都认：
 * - `- **Change**: \`path:行\` …`，一行一个文件（括号说明、全角冒号也行）；
 * - `- **Change**（说明）：` 下面缩进的子条目，每条开头一个 \`path:行\`。
 * `fallback` 是指引里一条 Change 都没有时的兜底：取除 New / Reuse / ADRs / Tests 之外各条里的 \`path:行号\` 引用。
 * 只追加的索引文件（APPEND_ONLY）不算：有 Change 行就不走兜底（哪怕全是索引文件），返回的数组里也过滤掉。
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
  if (files.size > 0) return { files: [...files].filter((p) => !APPEND_ONLY.has(p)), fallback: false };

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
  const claimed = [...files].filter((p) => !APPEND_ONLY.has(p));
  return { files: claimed, fallback: claimed.length > 0 };
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

/**
 * reportFlaky 的分组与匹配（#607）：门槛里重跑才通过的文件按 flakyFailures 的签名分组，同签名共用一张票；
 * 解析不到报错（摘要被截断）的文件签名为空串，各自一组、没有标记，只按标题去重。每组生成新票标题
 * （组里第一个文件，多文件加「等 N 个文件」）和正文末尾的隐藏标记 `<!-- flaky-sig: … -->`（签名里的 `-->`
 * 换成 `--›`，免得提前收掉注释），再在已开的 flaky 票里按 ①正文含标记 → ②标题 `偶发失败：<文件>` 找 existing。
 */
export const flakyTickets = (
  files: string[],
  after: string,
  open: { number: number; title: string; body: string }[],
): { files: string[]; signature: string; marker?: string; title: string; existing?: number }[] => {
  const signatures = new Map(flakyFailures(after).map((f) => [f.file, f.signature]));
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const key = signatures.get(file) || `按标题：${file}`;
    const group = groups.get(key);
    if (group) group.push(file);
    else groups.set(key, [file]);
  }
  return [...groups.values()].map((groupFiles) => {
    const signature = signatures.get(groupFiles[0]!) ?? "";
    const marker = signature ? `<!-- flaky-sig: ${signature.replaceAll("-->", "--›")} -->` : undefined;
    const title = `偶发失败：${groupFiles[0]!}${groupFiles.length > 1 ? ` 等 ${groupFiles.length} 个文件` : ""}`;
    const existing = (marker ? open.find((i) => i.body.includes(marker)) : undefined)
      ?? open.find((i) => groupFiles.some((f) => i.title === `偶发失败：${f}`));
    return { files: groupFiles, signature, marker, title, existing: existing?.number };
  });
};

/** 偶发失败的一次出现，记在 .sandcastle/logs/flaky.json，flakyTriage 按它判断「同一文件 7 天内第二次」。 */
export type FlakySighting = { file: string; signature: string; at: string; issue: string };
export const FLAKY_WINDOW_DAYS = 7;

/**
 * 报错只是超时或连不上（负载、并发抢 PG 这类环境症状）：签名含 timeout / timed out / ETIMEDOUT / ECONN* / connect / 超时 / 连接。
 * 签名为空（摘要截断、日志被冲掉）也算：没有报错可查，开票只会是一张没法修的空票（#1236）。
 */
export const flakyEnvironmental = (signature: string): boolean =>
  signature === "" || /time(?:d)? ?out|ETIMEDOUT|ECONN|EPIPE|connect|超时|连接/i.test(signature);

/**
 * 偶发失败开不开票（2026-11-24）：过去 40 多张偶发失败票七成是负载下超时、并发抢资源，修完产品代码不变，
 * 单次负载抖动就开票会把真 bug（#563、#1141）淹掉。规则：
 * - 已有同签名 / 同标题的票：照旧在老票上追加一次出现记录；
 * - 报错是断言失败这类（flakyEnvironmental 为假）：马上开票，可能是真 bug；
 * - 只是超时 / 连不上：同一文件在 FLAKY_WINDOW_DAYS 天内已经出现过才开票，否则只记一次出现、不开票。
 * 返回要开票（或追加）的组、只记录的组，以及去掉窗口外旧记录、加上这次出现后的新历史。
 */
export const flakyTriage = <G extends { files: string[]; signature: string; existing?: number }>(
  groups: G[],
  history: FlakySighting[],
  issue: string,
  now: Date,
): { ticket: G[]; deferred: G[]; history: FlakySighting[] } => {
  const since = now.getTime() - FLAKY_WINDOW_DAYS * 86_400_000;
  const recent = history.filter((h) => Date.parse(h.at) >= since);
  const ticket: G[] = [];
  const deferred: G[] = [];
  for (const g of groups) {
    const seenBefore = recent.some((h) => g.files.includes(h.file));
    (g.existing !== undefined || !flakyEnvironmental(g.signature) || seenBefore ? ticket : deferred).push(g);
  }
  const at = now.toISOString();
  const sightings = groups.flatMap((g) => g.files.map((file) => ({ file, signature: g.signature, at, issue })));
  return { ticket, deferred, history: [...recent, ...sightings] };
};
