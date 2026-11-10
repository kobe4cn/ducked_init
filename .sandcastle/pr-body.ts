// .sandcastle/pr-body.ts —— 拼 Sandcastle PR 正文、检查验收说明格式的纯函数（不 import main.ts、不跑命令），
// 测试在 test/sandcastle-pr-body.test.ts。验收说明是 implementer 写在 worktree `.pr-notes/验收说明.md`（不提交）、
// 给验收 PR 的人看的：做了什么、在宿主机上怎么一步步验证、最终效果。脚本（main.ts 的 land）把固定准备段落
// 拼在它前面，放进 PR 正文最前面的 `## 验收说明` 一节；缺失或格式不对时正文写警告、不自动合并。

/** `## 标题` 二级标题行的标题（`###` 小标题、`##x` 这种不是标题的都不认）；不是二级标题行时 undefined。 */
const headingOf = (line: string): string | undefined => (/^##(\s|$)/.test(line) ? line.replace(/^##\s*/, "") : undefined);

/** 验收说明必须有的三个小标题；`## ` 二级标题不能出现（replaceSection 按它切节，会被切错）。 */
const NOTE_HEADINGS = ["### 做了什么", "### 怎么验证", "### 最终效果"] as const;

/**
 * 验收说明的问题列表（空数组 = 合格）：文件没写、缺三个小标题之一、「怎么验证」下没有编号步骤、
 * 文件里出现 `## ` 二级标题。main.ts 的 land 有问题时留 PR 不自动合并，reviewer 另有一道独立检查。
 */
export const checkAcceptanceNotes = (md: string | undefined): string[] => {
  if (md === undefined) return ["文件不存在"];
  const lines = md.split("\n");
  const problems: string[] = [];
  for (const heading of NOTE_HEADINGS) {
    if (!lines.some((line) => line.trim().startsWith(heading))) problems.push(`缺 \`${heading}\` 小标题`);
  }
  const verifyAt = lines.findIndex((line) => line.trim().startsWith(NOTE_HEADINGS[1]));
  if (verifyAt >= 0) {
    const steps: string[] = [];
    for (const line of lines.slice(verifyAt + 1)) {
      if (line.trim().startsWith("###")) break; // 到下一个小标题为止
      steps.push(line);
    }
    if (!steps.some((line) => /^\s*\d+\./.test(line))) problems.push("「怎么验证」下面没有编号步骤");
  }
  if (lines.some((line) => headingOf(line) !== undefined)) {
    problems.push("文件里出现了 `## ` 二级标题（只能写 `###` 小标题，二级标题会让替换这一节时切错）");
  }
  return problems;
};

/** 二级标题行降成 `###`：格式不对的原文照样进正文，但不能有 `## ` 行留在这一节里，否则重做时 replaceSection 在它那儿切断、旧尾巴永远留着。 */
const demoteHeadings = (md: string): string =>
  md
    .split("\n")
    .map((line) => (headingOf(line) === undefined ? line : `#${line}`))
    .join("\n");

/**
 * PR 正文 `## 验收说明` 一节的内容（标题由 main.ts 的 pushAndOpenPr 加）：固定准备段落 + 文件内容，
 * 让验收的人能在宿主机上照做。不合格时给警告（文件不存在）或「格式不对」+ 问题列表 + 原文（二级标题降成 `###`），照样进正文让人看见。
 * pageChanged：有 `.browser-check/`（改了页面）的票给完整四步准备；其余只要 checkout，不用起 dev server。
 */
export const acceptanceSection = (branch: string, md: string | undefined, opts: { pageChanged: boolean }): string => {
  const problems = checkAcceptanceNotes(md);
  if (problems.length > 0) {
    return md === undefined
      ? "⚠️ implementer 没有写验收说明"
      : `⚠️ 验收说明格式不对：${problems.join("；")}\n\n${demoteHeadings(md)}`;
  }
  const prep = opts.pageChanged
    ? [
        "### 准备（在宿主机上，连开发库 `crm_platform`）",
        "",
        `1. \`git checkout ${branch}\``,
        "2. 起 dev server：`MAILER=console npm run dev`（Magic Link 登录链接会打印在它的终端里）",
        "3. 建验收数据：`PLATFORM_DATABASE_URL` 指向开发库 `crm_platform` 跑 `node --import tsx scripts/browser-lab.ts`——对 `crm_platform` 跑迁移，建租户 `crmlab-smoke` 和成员 `admin@` / `eng@` / `an@crmlab-smoke.test`（可重复跑）",
        "4. 打开 `http://localhost:5173/login`，填上面的邮箱点「发送登录链接」，从 dev server 的终端里取链接登录",
      ].join("\n")
    : `### 准备\n\n\`git checkout ${branch}\`（本票没改页面，不用起 dev server）`;
  return `${prep}\n\n${md}`;
};

/** 一节折进 `<details>`：PR 正文默认收起，验收的人需要时展开。 */
const details = (title: string, content: string) => `<details><summary>${title}</summary>\n\n${content}\n\n</details>`;

/** Gate / Budget / Usage 的内容（不含 `## 标题` 行）。 */
export type RestSections = {
  /** Review 一节：reviewer 摘要 + 打回记录。 */
  review: string;
  /** Browser check 一节（RESULT.md 与截图说明）；没做浏览器验收时 undefined，不放这一节。 */
  browser?: string;
  gate: string;
  budget: string;
  /** Usage 一节的表格（models.ts 的 usageTable）。 */
  usage: string;
};

/** PR 正文除「验收说明」外的其余各节：Review → Browser check 在外面，Gate / Budget / Usage 折进 details。 */
export const restSections = (s: RestSections): string =>
  [
    `## Review\n\n${s.review}`,
    s.browser === undefined ? undefined : `## Browser check\n\n${s.browser}`,
    details("Gate", s.gate),
    details("Budget", s.budget),
    details("Usage", s.usage),
  ]
    .filter((x): x is string => x !== undefined)
    .join("\n\n");

/**
 * 把正文里 `## <title>` 一节（标题行到下一个二级标题前，含节与下一节之间的空行）整节换成 content，
 * 其余逐字不变；正文里没有这一节时插在第一行（`Closes #n`）后面，空一行隔开。
 * 按行比对标题（不是拼正则），title 里的正则元字符不用转义。
 */
export const replaceSection = (body: string, title: string, content: string): string => {
  const lines = body.split("\n");
  const section = content.replace(/\s+$/, "").split("\n"); // 收尾空行不进正文，与下一节之间统一空一行
  const start = lines.findIndex((line) => (headingOf(line) ?? "").startsWith(title));
  if (start === -1) {
    const after = lines.slice(1);
    return [...lines.slice(0, 1), "", ...section, ...(after.length > 0 && after[0]!.trim() !== "" ? [""] : []), ...after].join("\n");
  }
  const stop = lines.findIndex((line, i) => i > start && headingOf(line) !== undefined);
  const end = stop === -1 ? lines.length : stop;
  return [...lines.slice(0, start), ...section, ...(end < lines.length ? [""] : []), ...lines.slice(end)].join("\n");
};
