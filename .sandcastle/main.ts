// Sandcastle：prep → plan → implement + review → 门槛 → 合并（不能合并的留 PR）
//
// 每一轮：
//   Phase 0 (Prep):  人工给 issue 打上 `Sandcastle` 标签即为「选中」。还没有
//                    `sandcastle:prepped` 的选中票逐张（串行）跑 prep-ticket：
//                    够小且指引新鲜 → 打 prepped；太大 → 拆成子票（子票继承
//                    `Sandcastle`，父票去掉）；要人拍板 → 打 sandcastle:stuck。
//   Phase 1 (Plan):  只看 `Sandcastle` + `sandcastle:prepped`、且没有 pr-open / stuck
//                    的票，排除仍有未关闭 blocker 的票。
//   Phase 2 (Build): 每张票一个沙箱，从 origin/main 建分支：implementer（每次迭代
//                    都是全新的 Claude 会话）→ reviewer（给出 merge / pr 结论）→
//                    门槛（脚本自己跑 typecheck + 完整测试，失败时让 implementer 修一次）。
//                    最多 MAX_PARALLEL 张并行，每个沙箱用独立的测试库与前缀。
//   Phase 3 (Land):  在宿主机上 push、开 PR（`Closes #n`）。reviewer 说 merge 且门槛通过
//                    → `gh pr merge --rebase`，issue 自动关闭；否则打 sandcastle:pr-open 等人审。
//
// 标签状态机见 docs/agents/sandcastle.md。
//
// Usage: npm run run:sandcastle

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 10; // prep→plan→build→land 的轮数上限
const MAX_PARALLEL = 2; // 同时实现的票数：受 PG max_connections 与机器负载限制
const IMPLEMENT_MAX_ITERATIONS = 3; // 一张票最多开几次全新会话；超过说明票太大，交给人
const CONTEXT_BUDGET = 150_000; // 单个会话的上下文预算（CLAUDE.md「Context budget」）
const REMOTE = "origin";
const BASE_BRANCH = "main";
// 从远端 main 建分支：上一轮合并的代码在远端，不动宿主机本地 main 的工作区。
const BASE_REF = `${REMOTE}/${BASE_BRANCH}`;
const MODEL = "claude-opus-5-5";

const LABEL = {
  picked: "Sandcastle", // 人工选中
  prepped: "sandcastle:prepped", // prep 已确认可实现
  prOpen: "sandcastle:pr-open", // 已开 PR，等人审
  stuck: "sandcastle:stuck", // 需要人介入（见 issue 评论）
} as const;

// 同一会话超过预算前自动压缩；预算本身靠 prep 把票切小来保证。
const claudeEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CONTEXT_BUDGET) };
const agent = (env: Record<string, string> = {}) =>
  sandcastle.claudeCode(MODEL, { env: { ...claudeEnv, ...env } });

// ---------------------------------------------------------------------------
// 测试依赖的服务：宿主机 apple container 里的 PG / MySQL / MongoDB / SeaweedFS，
// 端口发布在宿主机上，podman 容器经 host.containers.internal 访问。
// 连接信息取自宿主机的 .env（S3_*）与 .env.test（TEST_*），把 localhost 换成宿主机地址；
// 每张票的库名 / 前缀再加 `_i<n>`，并行的沙箱互不清表（worker 后缀 `_w<i>` 加在它后面）。
// ---------------------------------------------------------------------------

const HOST_FROM_CONTAINER = "host.containers.internal";
const readEnvFile = (file: string): Record<string, string | undefined> =>
  existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
const hostEnv = { ...readEnvFile(".env"), ...readEnvFile(".env.test") };
const toContainer = (value: string) =>
  value.replace(/\b(localhost|127\.0\.0\.1)\b/g, HOST_FROM_CONTAINER);
const withDbSuffix = (url: string, suffix: string) => {
  const u = new URL(url);
  u.pathname = `${u.pathname}${suffix}`;
  return u.toString();
};

const SERVICE_KEYS = ["S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_URL_STYLE", "S3_USE_SSL"];
const serviceEnv = Object.fromEntries(
  SERVICE_KEYS.flatMap((k) => (hostEnv[k] ? [[k, toContainer(hostEnv[k])]] : [])),
);

function testEnv(issueId: string): Record<string, string> {
  const suffix = `_i${issueId}`;
  const env: Record<string, string> = {
    ...serviceEnv,
    TEST_PLATFORM_DATABASE_URL: withDbSuffix(toContainer("postgres://crm:crm@localhost:5432/crm_platform_test"), suffix),
    TEST_SOURCE_DATABASE_URL: withDbSuffix(toContainer("postgres://crm:crm@localhost:5432/crm_source_test"), suffix),
    CRM_TEST_WORKERS: "4",
  };
  const { TEST_MONGO_URL, TEST_MYSQL_URL, TEST_S3_LAKE_URI } = hostEnv;
  if (TEST_MONGO_URL) env.TEST_MONGO_URL = withDbSuffix(toContainer(TEST_MONGO_URL), suffix);
  if (TEST_MYSQL_URL) env.TEST_MYSQL_URL = withDbSuffix(toContainer(TEST_MYSQL_URL), suffix);
  if (TEST_S3_LAKE_URI) env.TEST_S3_LAKE_URI = TEST_S3_LAKE_URI + suffix;
  return env;
}

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const envPrefix = (env: Record<string, string>) =>
  `env ${Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")}`;

// 合并门槛：脚本自己跑，不信 agent 的口头结论。retrieval-golden 的 KNOWN_GAPS 是 it.fails，不影响退出码。
const GATE_SCRIPT = [
  "npm run typecheck > /tmp/gate-typecheck.log 2>&1 || { tail -40 /tmp/gate-typecheck.log; exit 1; }",
  'npm run test > /tmp/gate-test.log 2>&1 || { grep -nE "FAIL|Test Files|Tests |Error" /tmp/gate-test.log | tail -60; exit 1; }',
  'grep -E "Test Files|Tests " /tmp/gate-test.log | tail -2',
].join("; ");

const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};
const copyToWorktree = ["node_modules"];

const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

// ---------------------------------------------------------------------------
// Host helpers
// ---------------------------------------------------------------------------

const sh = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: "utf8" }).trim();

const trySh = (cmd: string, args: string[]) => {
  try {
    return { ok: true as const, out: sh(cmd, args) };
  } catch (e) {
    return { ok: false as const, out: String((e as { stderr?: unknown }).stderr ?? e) };
  }
};

const searchIssues = (query: string): { number: number; title: string }[] =>
  JSON.parse(
    sh("gh", [
      "issue", "list", "--state", "open", "--limit", "100",
      "--search", query, "--json", "number,title",
    ]),
  );

const q = (label: string) => `label:"${label}"`;
const notIn = (...labels: string[]) => labels.map((l) => `-${q(l)}`).join(" ");

/** 每次迭代结束时的上下文大小（最后一条 assistant 消息的输入 token）。 */
const peakContext = (...runs: (sandcastle.SandboxRunResult | undefined)[]) =>
  Math.max(
    0,
    ...runs.flatMap((run) =>
      (run?.iterations ?? []).map((it) =>
        it.usage
          ? it.usage.inputTokens + it.usage.cacheCreationInputTokens + it.usage.cacheReadInputTokens
          : 0,
      ),
    ),
  );

const tagged = (stdout: string, tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(stdout)?.[1]?.trim();

type Issue = { id: string; title: string; branch: string };

function pushAndOpenPr(issue: Issue, notes: string): string {
  sh("git", ["push", "--force-with-lease", "-u", REMOTE, issue.branch]);
  const existing = sh("gh", [
    "pr", "list", "--head", issue.branch, "--state", "open", "--json", "number", "--jq", ".[0].number",
  ]);
  if (existing) {
    sh("gh", ["pr", "comment", existing, "--body", `Sandcastle 更新了这个分支。\n\n${notes}`]);
    return existing;
  }
  const commits = sh("git", ["log", `${BASE_REF}..${issue.branch}`, "--format=- %B"]);
  const body = `Closes #${issue.id}\n\n${notes}\n\n## Commits\n\n${commits}`;
  const url = sh("gh", [
    "pr", "create", "--base", BASE_BRANCH, "--head", issue.branch,
    "--title", `${issue.title} (#${issue.id})`, "--body", body,
  ]);
  return url.split("/").pop()!;
}

function leaveForHuman(issue: Issue, pr: string, reason: string) {
  sh("gh", ["issue", "edit", issue.id, "--add-label", LABEL.prOpen]);
  sh("gh", ["pr", "comment", pr, "--body", `没有自动合并：${reason}`]);
}

function markStuck(issueId: string, reason: string) {
  sh("gh", ["issue", "edit", issueId, "--add-label", LABEL.stuck]);
  sh("gh", ["issue", "comment", issueId, "--body", `Sandcastle 停下了：${reason}`]);
}

// ---------------------------------------------------------------------------
// Build one issue inside its own sandbox
// ---------------------------------------------------------------------------

async function build(issue: Issue) {
  const env = testEnv(issue.id);
  const sandbox = await sandcastle.createSandbox({
    branch: issue.branch,
    baseBranch: BASE_REF,
    sandbox: podman(),
    hooks,
    copyToWorktree,
  });
  try {
    const implement = await sandbox.run({
      name: `implement-${issue.id}`,
      maxIterations: IMPLEMENT_MAX_ITERATIONS,
      agent: agent(env),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: { TASK_ID: issue.id, ISSUE_TITLE: issue.title, BRANCH: issue.branch },
    });
    if (!implement.completionSignal || implement.commits.length === 0) {
      return { done: false as const, implement };
    }

    const review = await sandbox.run({
      name: `review-${issue.id}`,
      maxIterations: 1,
      agent: agent(env),
      promptFile: "./.sandcastle/review-prompt.md",
      promptArgs: { TASK_ID: issue.id, BRANCH: issue.branch },
    });

    const gate = () => sandbox.exec(`${envPrefix(env)} sh -c ${shellQuote(GATE_SCRIPT)}`);
    let gateResult = await gate();
    let fix: sandcastle.SandboxRunResult | undefined;
    if (gateResult.exitCode !== 0) {
      // 给 implementer 一次修的机会（新会话），再跑一次门槛。
      fix = await sandbox.run({
        name: `fix-${issue.id}`,
        maxIterations: 1,
        agent: agent(env),
        prompt: [
          `分支 ${issue.branch}（issue #${issue.id}）在合并门槛上失败，摘要如下；完整日志在 /tmp/gate-typecheck.log 与 /tmp/gate-test.log（用 grep 看，不要整读）。`,
          "```", gateResult.stdout.slice(-4000), "```",
          "只修这些失败：用 `npx vitest run <file>` 跑失败的文件确认变绿，按仓库风格写中文提交信息、末尾 (#" + issue.id + ")。",
          "如果失败与本票改动无关（偶发、环境问题）或不能确定怎么修，不要改代码，在输出里说明原因。",
          "最后输出 <promise>COMPLETE</promise>。",
        ].join("\n"),
      });
      gateResult = await gate();
    }

    return {
      done: true as const,
      implement,
      review,
      fix,
      verdict: tagged(review.stdout, "verdict"),
      summary: tagged(review.stdout, "review-summary") ?? "（reviewer 没有给出摘要）",
      gate: { ok: gateResult.exitCode === 0, output: gateResult.stdout.slice(-3000) },
    };
  } finally {
    await sandbox.close();
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
  sh("git", ["fetch", REMOTE, BASE_BRANCH]); // 上一轮合并进远端 main 的代码

  // Phase 0: Prep —— 串行，因为拆票会改别的票的 Blocked by。
  // 每轮重新查询，所以上一轮拆出来的子票（继承了 Sandcastle 标签）这里会被看到。
  const toPrep = searchIssues(
    `${q(LABEL.picked)} ${notIn(LABEL.prepped, LABEL.prOpen, LABEL.stuck)}`,
  );
  for (const issue of toPrep) {
    console.log(`Prep #${issue.number}: ${issue.title}`);
    await sandcastle.run({
      sandbox: podman(),
      name: `prep-${issue.number}`,
      maxIterations: 1,
      agent: agent(),
      promptFile: "./.sandcastle/prep-prompt.md",
      promptArgs: { TASK_ID: issue.number, LABEL_PICKED: LABEL.picked, LABEL_PREPPED: LABEL.prepped, LABEL_STUCK: LABEL.stuck },
    });
  }

  // Phase 1: Plan
  const plan = await sandcastle.run({
    sandbox: podman(),
    name: "planner",
    maxIterations: 1,
    agent: agent(),
    promptFile: "./.sandcastle/plan-prompt.md",
    promptArgs: {
      QUERY: `${q(LABEL.picked)} ${q(LABEL.prepped)} ${notIn(LABEL.prOpen, LABEL.stuck)}`,
    },
    output: sandcastle.Output.object({ tag: "plan", schema: planSchema }),
  });

  const issues = plan.output.issues.slice(0, MAX_PARALLEL);
  if (issues.length === 0) {
    console.log("没有可以开工的票（都在等 blocker、等人审 PR，或需要人处理）。");
    break;
  }
  for (const issue of issues) console.log(`  #${issue.id}: ${issue.title} → ${issue.branch}`);

  // Phase 2: Build
  const settled = await Promise.allSettled(issues.map(build));

  // Phase 3: Land —— 在宿主机上逐个做：用宿主机的 git / gh 凭据，沙箱没有写仓库的权限。
  for (const [i, outcome] of settled.entries()) {
    const issue = issues[i]!;
    if (outcome.status === "rejected") {
      console.error(`  ✗ #${issue.id} 失败：${outcome.reason}`);
      markStuck(issue.id, `沙箱出错：${String(outcome.reason).slice(0, 500)}`);
      continue;
    }
    const result = outcome.value;
    const peak = result.done
      ? peakContext(result.implement, result.review, result.fix)
      : peakContext(result.implement);
    const budgetNote = `上下文峰值约 ${Math.round(peak / 1000)}k / ${CONTEXT_BUDGET / 1000}k，implement 用了 ${result.implement.iterations.length} 次会话。`;
    if (!result.done) {
      markStuck(
        issue.id,
        `${IMPLEMENT_MAX_ITERATIONS} 次会话内没有完成（见上面 implementer 的评论）。${budgetNote} 通常说明票太大，请重新 /prep-ticket 后去掉 ${LABEL.stuck}。`,
      );
      continue;
    }

    const overBudget = peak > CONTEXT_BUDGET ? "\n\n⚠️ 超过上下文预算，考虑把同类票切得更小。" : "";
    const gateNote = result.gate.ok
      ? `typecheck 与完整测试通过（沙箱内）。\n\n\`\`\`\n${result.gate.output.slice(-500)}\n\`\`\``
      : `❌ 门槛失败：\n\n\`\`\`\n${result.gate.output}\n\`\`\``;
    const pr = pushAndOpenPr(
      issue,
      `## Review\n\n${result.summary}\n\n## Gate\n\n${gateNote}\n\n## Budget\n\n${budgetNote}${overBudget}`,
    );

    if (result.verdict !== "merge") {
      leaveForHuman(issue, pr, "reviewer 认为需要人审（见 PR 正文的 Review）。");
      console.log(`  ◐ #${issue.id} 留 PR #${pr} 等人审`);
      continue;
    }
    if (!result.gate.ok) {
      leaveForHuman(issue, pr, "typecheck 或完整测试没通过（见 PR 正文的 Gate）。");
      console.log(`  ◐ #${issue.id} 门槛失败，留 PR #${pr}`);
      continue;
    }
    // 同一轮先合并的票可能让这张冲突：GitHub 拒绝 rebase 合并时留给人。
    const merged = trySh("gh", ["pr", "merge", pr, "--rebase"]);
    if (!merged.ok) {
      leaveForHuman(issue, pr, `合并失败（多半与同一轮先合并的票冲突）：${merged.out.slice(0, 500)}`);
      console.log(`  ◐ #${issue.id} 合并失败，留 PR #${pr}`);
      continue;
    }
    trySh("git", ["push", REMOTE, "--delete", issue.branch]);
    trySh("git", ["branch", "-D", issue.branch]);
    console.log(`  ✓ #${issue.id} 已合并（PR #${pr}）`);
  }
}

console.log(`\nAll done. 本地 main 落后于 ${BASE_REF} 时记得 git pull；带 ${LABEL.prOpen} 的票在 GitHub 上等你审。`);
