// Sandcastle：prep → plan → implement + review → 门槛 → 合并（不能合并的留 PR）
//
// 调度（不分轮）：最多 MAX_PARALLEL 个空位。有空位时做一次「整理 → prep → plan」，把空位补满；每张票
// 独立跑 build → land，做完马上让出空位并触发下一次调度。有空位但开不了工时每 POLL_INTERVAL_MS 轮询一次
// （人合并了 PR、blocker 关了、去掉了 stuck，都能在下一次轮询开工）；没票在做、也开不出新票算一次空转，
// 连续 MAX_ITERATIONS 次空转就结束。宿主机上的 git / 标签操作（调度与落地）串行，build 在沙箱里并行。
//
// 每次调度与每张票：
//   Phase 0 (Prep):  人工给 issue 打上 `Sandcastle` 标签即为「选中」。还没有
//                    `sandcastle:prepped` 的选中票逐张（串行）跑 prep-ticket（`## Blocked by` 里
//                    还有 open 票的脚本直接跳过，不开会话）：
//                    够小且指引新鲜 → 打 prepped；太大 → 拆成子票（子票继承
//                    `Sandcastle`，父票去掉）；要人拍板 → 打 sandcastle:stuck（能代拍板的按 .sandcastle/DECISIONS.md 自己定）。
//   Phase 1 (Plan):  脚本自己算（不用 agent）：只看 `Sandcastle` + `sandcastle:prepped`、且没有
//                    pr-open / stuck 的票，排除仍有未关闭 blocker 的票；剩下的按编号从小到大，
//                    和已选的票或等人审（pr-open）的票改同一个文件（指引的 Change 行）就跳过。
//   Phase 2 (Build): 每张票一个沙箱，从 origin/main 建分支：implementer（每次迭代
//                    都是全新的 Claude 会话）→ reviewer（给出 merge / revise / pr 结论；revise
//                    时把修改意见交给新的 implementer 会话改完再审，最多 REVISE_MAX 次）→
//                    门槛（脚本自己跑 typecheck + 完整测试，失败时让 implementer 修一次）。
//                    最多 MAX_PARALLEL 张并行，每个沙箱用独立的测试库与前缀。
//   Phase 3 (Land):  在宿主机上 push、开 PR（`Closes #n`）。reviewer 说 merge 且门槛通过
//                    → `gh pr merge --rebase`，issue 自动关闭；否则打 sandcastle:pr-open 等人审。
//                    合并不了（先合并的票造成冲突，或 drizzle 迁移链分叉）时，rebase 到
//                    最新的 origin/main（冲突与迁移交给 agent，rebase-prompt.md），重跑门槛后再合并一次。
//   每次调度开头：等人审的 PR 上有晚于分支最新提交的打回信号（`/sandcastle` 开头的评论或 review，
//                    或别人点的 Request changes）→ 去掉 issue 的 sandcastle:pr-open，这张票这次
//                    重新进入 plan，implementer 先读 PR 上的意见。
//   外部 PR：别人开的、`Closes` 了 Sandcastle 票的 PR（分支不是 `sandcastle/` 开头），打回后在它的分支上
//                    接着改：只做普通 push，不 rebase、不合并、不删分支，结果评论在 PR 上留给人合并。
//
// 每个阶段用哪个模型（Claude 订阅或别家的 Anthropic 兼容接口）、撞限额时换哪个：.sandcastle/models.json（models.ts）。
// 标签状态机见 docs/agents/sandcastle.md。
//
// Usage: npm run run:sandcastle
//        SANDCASTLE_ONLY=328,329 npm run run:sandcastle   只处理这几张票（试跑、单独补跑）

import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseEnv, promisify } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import {
  AllProfilesLimited, CLAUDE_LIMIT_PATTERN, agentFor, limitResetAt, recordUsage, reloadModels, runWithProfile, usageTable,
  type AgentRun, type Phase, type UsageRecord,
} from "./models.ts";
import { blockersOf, changedFiles, flakyTickets, splitChildren } from "./guide.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10 * 60_000; // 有空位时隔多久重新调度一次（整理 → prep → plan），看有没有新开得了工的票
const MAX_ITERATIONS = 12; // 连续空转（没有票在做、也开不出新票）多少次就结束运行：12 × 10 分钟，等人审 PR 最多等约 2 小时
const MAX_PARALLEL = 2; // 同时实现的票数：受 PG max_connections（每个沙箱 4 个 worker 约 150 个连接，2 个要 300）与机器负载限制；3 个门槛同时跑完整测试会大面积超时（2026-11-07）
const IMPLEMENT_MAX_ITERATIONS = 3; // 一张票最多开几次全新会话；超过说明票太大，交给人
/** 第一次没做完时脚本留在 issue 上的标记；prep 看到它就按「实现没做完」重新准备，再没做完才打 stuck。 */
const REPREP_MARK = "<!-- sandcastle:reprep -->";
/** implementer 的两个完成信号：做完了；遇到必须由人拍板的设计决定（.sandcastle/DECISIONS.md），票直接交给人，不再开新会话。 */
const COMPLETE = "<promise>COMPLETE</promise>";
const NEEDS_DECISION = "<promise>NEEDS_DECISION</promise>";
/** agent 代拍板时 issue 评论的第一行（.sandcastle/DECISIONS.md）；落地时脚本据此打 sandcastle:decided 并把评论贴到 PR 上。 */
const DECIDED_MARK = "<!-- sandcastle:decided -->";
const REVISE_MAX = 2; // reviewer 给 revise 时最多打回几次；之后仍不行就留 PR 给人
const CONTEXT_BUDGET = 150_000; // 单个会话的上下文预算（CLAUDE.md「Context budget」）
const REMOTE = "origin";
const BASE_BRANCH = "main";
// 从远端 main 建分支：已合并的代码在远端，不动宿主机本地 main 的工作区。
const BASE_REF = `${REMOTE}/${BASE_BRANCH}`;
// 只处理这几张票（逗号分隔）；不设则处理全部带 Sandcastle 标签的票。拆出来的子票不在名单里，要另外加。
const ONLY = new Set((process.env.SANDCASTLE_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const allowed = (id: string | number) => ONLY.size === 0 || ONLY.has(String(id).replace(/^#/, ""));

const LABEL = {
  picked: "Sandcastle", // 人工选中
  prepped: "sandcastle:prepped", // prep 已确认可实现
  prOpen: "sandcastle:pr-open", // 已开 PR，等人审
  stuck: "sandcastle:stuck", // 需要人介入（见 issue 评论）
  decided: "sandcastle:decided", // agent 代拍板过设计决定，等人事后确认（人看过后去掉）
  flaky: "flaky", // 门槛里重跑才通过的测试文件，脚本自动开票
} as const;

// 同一会话超过预算前自动压缩；预算本身靠 prep 把票切小来保证。
const claudeEnv = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(CONTEXT_BUDGET) };

/**
 * 跑一次 agent 会话：阶段用哪个档案（模型、厂商）由 .sandcastle/models.json 决定，撞限额换下一个（models.ts）。
 * 用量追加到 .sandcastle/logs/usage.jsonl，也放进 usage（落地时写进 PR）。
 */
async function runAgent<T extends AgentRun>(
  phase: Phase,
  issue: string,
  name: string,
  env: Record<string, string>,
  usage: UsageRecord[],
  fn: (agent: sandcastle.AgentProvider) => Promise<T>,
): Promise<T> {
  const { run, profile } = await runWithProfile(phase, name, (p) => fn(agentFor(p, { ...claudeEnv, ...env })));
  usage.push(recordUsage(issue, phase, run, name, profile));
  return run;
}

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
    // 源端测试账号名按票区分（scripts/test-resource-names.ts 的 CRM_TEST_RUN_SUFFIX），并行的沙箱不共用账号
    CRM_TEST_RUN_SUFFIX: suffix,
    CRM_TEST_WORKERS: "4",
    // 沙箱负载比本地约慢一倍（#439），vitest.config.ts 把 testTimeout / hookTimeout 乘成 180 s / 120 s，超时类偶发失败不再逐文件放宽（#461）
    CRM_TEST_TIMEOUT_SCALE: "2",
  };
  const { TEST_MONGO_URL, TEST_MYSQL_URL, TEST_S3_LAKE_URI } = hostEnv;
  if (TEST_MONGO_URL) env.TEST_MONGO_URL = withDbSuffix(toContainer(TEST_MONGO_URL), suffix);
  if (TEST_MYSQL_URL) env.TEST_MYSQL_URL = withDbSuffix(toContainer(TEST_MYSQL_URL), suffix);
  if (TEST_S3_LAKE_URI) env.TEST_S3_LAKE_URI = TEST_S3_LAKE_URI + suffix;
  return { ...env, ...browserEnv(suffix) };
}

// 关沙箱后回收这张票的测试资源（scripts/drop-test-resources.ts：PG 库与租户角色、PG / MySQL 源端测试账号、MySQL / MongoDB 库、对象存储前缀与账号）。
// 每次关沙箱都收，不等票合并：再跑这张票（revise、rebase）时 global-setup 与夹具会重新建库。
// 在宿主机上跑，连接取自宿主机的 .env / .env.test（不做 host.containers.internal 替换）；异步执行，不卡住并行的另一张票。
// 回收失败只打日志，不影响票的结果；留下的可以之后 `pnpm sandcastle:cleanup --all` 补收。
async function dropTestResources(issueId: string) {
  const args = ["--env-file-if-exists=.env", "--env-file-if-exists=.env.test", "--import", "tsx", "scripts/drop-test-resources.ts", `_i${issueId}`];
  try {
    const { stdout } = await promisify(execFile)("node", args, { encoding: "utf8" });
    console.log(`  🧹 #${issueId} ${stdout.trim().split("\n").slice(1).join("；")}`);
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: string; stderr?: string };
    console.warn(`  ⚠ #${issueId} 测试资源回收失败（之后可用 pnpm sandcastle:cleanup _i${issueId} 补收）：${(stderr || stdout || String(e)).trim().slice(0, 500)}`);
  }
}

// 本机 seaweedfs 的 filer 元数据日志会一直占卷，卷数到上限后门槛里对象存储全部超时（见 docs/agents/sandcastle.md）。
// 每次调度开头删两天前的日志目录和已清空的整卷；失败只打日志。
function pruneSeaweedMetalog() {
  const r = trySh("scripts/prune-seaweed-metalog.sh", []);
  console.log(r.ok ? `  🧹 ${r.out}` : `  ⚠ 元数据日志清理失败：${r.out.slice(0, 300)}`);
}

// 浏览器验收用的 dev server 与 scripts/browser-lab.ts：独立的平台库（不碰开发库 crm_platform，也不被测试清表）、
// 本地湖目录、固定的测试主密钥、发信打到日志。vitest.config.ts 会为测试覆盖这几个变量，门槛不受影响。
function browserEnv(suffix: string): Record<string, string> {
  return {
    PLATFORM_DATABASE_URL: withDbSuffix(toContainer("postgres://crm:crm@localhost:5432/crm_platform_browser"), suffix),
    PLATFORM_LAKE_URI: "/tmp/crm_browser_lake",
    PLATFORM_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
    MAILER: "console",
  };
}

// 浏览器验收的产物：implementer 写在 worktree 的 .browser-check/（.gitignore 忽略），
// 关沙箱前拷到宿主机，开 PR 时把截图用 `gh --attach` 附上、RESULT.md 写进正文。
const BROWSER_DIR = ".browser-check";
const SHOTS_ROOT = join(tmpdir(), "sandcastle-browser-check");

function collectBrowserCheck(worktreePath: string, issueId: string) {
  const from = join(worktreePath, BROWSER_DIR);
  if (!existsSync(from)) return undefined;
  const to = join(SHOTS_ROOT, `issue-${issueId}`);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  const resultFile = join(to, "RESULT.md");
  return {
    result: existsSync(resultFile) ? readFileSync(resultFile, "utf8").trim() : undefined,
    shots: readdirSync(to).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort().map((f) => join(to, f)),
  };
}

const shellQuote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
const envPrefix = (env: Record<string, string>) =>
  `env ${Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")}`;

// 合并门槛：脚本自己跑，不信 agent 的口头结论。retrieval-golden 的 KNOWN_GAPS 是 it.fails，不影响退出码。
// 完整测试在沙箱里要跑 ~40 分钟，负载下个别用例会偶发失败（hook 超时、随机数据撞上断言）：
// 失败的文件不超过 GATE_RERUN_MAX 个时单独重跑一次，重跑通过算通过，但输出 GATE_FLAKY 让 PR 上标出来。
// 失败摘要只取 vitest 的 Failed Tests / Failed Suites 一节（去掉颜色、每行截断），不 grep 日志里的 Error。
const GATE_RERUN_MAX = 3;
const GATE_SCRIPT = String.raw`
plain() { sed 's/\[[0-9;]*m//g' "$1"; }
failures() { plain "$1" | sed -n '/Failed \(Tests\|Suites\)/,/Test Files/p' | grep -v 'Test Files' | cut -c1-300 | head -80; }
totals() { plain "$1" | grep -E "Test Files|Tests " | tail -2; }
npm run typecheck > /tmp/gate-typecheck.log 2>&1 || { plain /tmp/gate-typecheck.log | tail -40; exit 1; }
npm run test > /tmp/gate-test.log 2>&1 && { totals /tmp/gate-test.log; exit 0; }
files=$(plain /tmp/gate-test.log | grep -oE "FAIL +test/[^ ]+\.test\.tsx?" | awk '{print $2}' | sort -u)
count=$(printf '%s
' "$files" | grep -c .)
if [ "$count" -eq 0 ] || [ "$count" -gt ${GATE_RERUN_MAX} ]; then
  echo "完整测试失败（失败文件 $count 个，不重跑）："; failures /tmp/gate-test.log; totals /tmp/gate-test.log; exit 1
fi
echo "完整测试有 $count 个文件失败，单独重跑一次："; echo "$files"
npx vitest run $files > /tmp/gate-rerun.log 2>&1 || {
  echo "重跑仍失败："; failures /tmp/gate-rerun.log; totals /tmp/gate-rerun.log; exit 1
}
echo "GATE_FLAKY: 重跑通过。第一次的失败："; failures /tmp/gate-test.log; totals /tmp/gate-test.log
`;

// 仓库用 pnpm（package.json 的 packageManager）。拷进来的 node_modules 是宿主机 darwin 的，
// 缺 linux 原生包（rolldown、typescript-go），npm install 补不上，要用 pnpm 按锁文件重装。
const PNPM = JSON.parse(readFileSync("package.json", "utf8")).packageManager as string;
const hooks = {
  sandbox: { onSandboxReady: [{ command: `npx -y ${PNPM} install --frozen-lockfile` }] },
};
const copyToWorktree = ["node_modules"];

// createSandbox 里的 sandbox.run 不使用 agent provider 的 env，只有容器启动时 podman({env}) 的 env
// 才进得了 agent 的 shell，所以测试库连接与上下文预算都在这里注入。
const sandboxFor = (env: Record<string, string>) => podman({ env: { ...claudeEnv, ...env } });

// ---------------------------------------------------------------------------
// Host helpers
// ---------------------------------------------------------------------------

// 宿主机命令一律带超时：2026-11-07 机器睡眠醒来后一个 git fetch 挂了一个多小时不返回，整个运行停在那里。
// 超时抛的错带 TIMEOUT_TEXT，被 TRANSIENT 认作临时错误。
const SH_TIMEOUT_MS = 10 * 60_000;
const GIT_REMOTE_TIMEOUT_MS = 5 * 60_000;
const TIMEOUT_TEXT = "命令超时";
const sh = (cmd: string, args: string[], timeout = SH_TIMEOUT_MS) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, killSignal: "SIGKILL" }).trim();
  } catch (e) {
    if ((e as { code?: unknown }).code === "ETIMEDOUT") throw new Error(`${TIMEOUT_TEXT}（${timeout / 1000} 秒）：${cmd} ${args.join(" ").slice(0, 200)}`);
    throw e;
  }
};

const trySh = (cmd: string, args: string[], timeout?: number) => {
  try {
    return { ok: true as const, out: sh(cmd, args, timeout) };
  } catch (e) {
    return { ok: false as const, out: String((e as { stderr?: unknown }).stderr || e) };
  }
};

// 连远端的 git（fetch / push）偶尔撞上 SSH、DNS、网络抖动（2026-11-04 一次
// `Permission denied (publickey)` 让 #390 落地失败、下次开头的 fetch 直接让进程崩了）。
// 这类错误等一会儿重试，最多等约半小时；被拒（non-fast-forward、lease 过期）之类的照常立即失败。
const REMOTE_TRANSIENT = new RegExp(
  [
    "Permission denied \\(publickey\\)", "Could not read from remote repository", "Could not resolve host",
    "Connection (timed out|reset|refused|closed)", "Operation timed out", "Network is unreachable", "early EOF",
    "unexpected disconnect", "kex_exchange_identification", "ssh_exchange_identification", "unable to access",
    "RPC failed", "HTTP 5\\d\\d", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "TLS handshake timeout", TIMEOUT_TEXT,
  ].join("|"),
  "i",
);
const REMOTE_RETRY_WAITS_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];

async function gitRemote(args: string[]) {
  for (let attempt = 0; ; attempt++) {
    const result = trySh("git", args, GIT_REMOTE_TIMEOUT_MS);
    const wait = REMOTE_RETRY_WAITS_MS[attempt];
    if (result.ok || wait === undefined || !REMOTE_TRANSIENT.test(result.out)) return result;
    console.warn(`  ⚠ git ${args.join(" ")} 连不上远端（${result.out.split("\n")[0].slice(0, 160)}），${wait / 1000} 秒后重试（第 ${attempt + 1}/${REMOTE_RETRY_WAITS_MS.length} 次）`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** 同 gitRemote，重试用完仍失败就抛错（原来直接用 sh 的地方）。 */
async function gitRemoteOrThrow(args: string[]) {
  const result = await gitRemote(args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} 失败：${result.out.slice(0, 500)}`);
  return result.out;
}

// 沙箱和落地里的临时错误（2026-11-07 机器睡眠醒来后：复制 node_modules 到工作区超过 60 秒、
// GitHub API 读超时）不直接打 stuck：等一会儿整步重跑。build 在原分支上重跑，implementer 会接着已有提交做；
// land 开头会查 issue 是否已关、PR 是否已开，重跑最多多出一条评论。
const TRANSIENT = new RegExp(`${REMOTE_TRANSIENT.source}|CopyToWorktreeTimeoutError|timed out`, "i");
const TRANSIENT_RETRY_WAITS_MS = [60_000, 300_000, 900_000];

async function retryTransient<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = String((e as { stderr?: unknown }).stderr || e);
      const wait = TRANSIENT_RETRY_WAITS_MS[attempt];
      if (wait === undefined || !TRANSIENT.test(message)) throw e;
      console.warn(`  ⚠ ${what} 撞上临时错误（${message.split("\n")[0].slice(0, 160)}），${wait / 1000} 秒后重跑（第 ${attempt + 1}/${TRANSIENT_RETRY_WAITS_MS.length} 次）`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * prep 与 plan 不建分支，podman 是挂载型沙箱，默认挂的是宿主机工作区（本地 HEAD），
 * 不是 origin/main。本地 main 落后时，prep 的 Explore 读到旧代码：指引的 file:line 对不上，
 * 刚合并的 blocker 也看不到。所以每次调度 fetch 后把本地 main 快进到 origin/main。
 * 只在当前分支是 main 时做；--ff-only 遇到本地领先或分叉、或会覆盖未提交改动时 git 自己拒绝，
 * 这时只打警告，不动工作区。
 */
function syncHostBase() {
  const branch = trySh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  if (branch !== BASE_BRANCH) {
    console.warn(`  ⚠ 宿主机当前在 ${branch}，不是 ${BASE_BRANCH}：prep / plan 读到的是这个分支的代码，可能不是 ${BASE_REF}`);
    return;
  }
  const merged = trySh("git", ["merge", "--ff-only", "--quiet", BASE_REF]);
  if (!merged.ok) {
    console.warn(`  ⚠ 本地 ${BASE_BRANCH} 没能快进到 ${BASE_REF}，prep / plan 可能读到旧代码：${merged.out.slice(0, 300)}`);
  }
}

/**
 * 带全部 `include` 标签、不带任何 `exclude` 标签的 open 票。
 * 用 `--label`（issues 列表接口，实时）而不是 `--search`（搜索索引）：索引有延迟，刚打上的标签要过一阵
 * 才查得到。2026-11-05 #393 刚打上 prepped，plan 用 --search 没查到，脚本以为没票可做就退出了。
 * 排除的标签在本地过滤。
 */
const listIssues = (include: string[], exclude: string[] = []): { number: number; title: string; body: string; updatedAt: string }[] =>
  (JSON.parse(
    sh("gh", [
      "issue", "list", "--state", "open", "--limit", "200",
      ...include.flatMap((label) => ["--label", label]), "--json", "number,title,body,labels,updatedAt",
    ]),
  ) as { number: number; title: string; body: string; labels: { name: string }[]; updatedAt: string }[])
    .filter((issue) => !issue.labels.some((label) => exclude.includes(label.name)))
    .map(({ number, title, body, updatedAt }) => ({ number, title, body, updatedAt }));

const q = (label: string) => `label:"${label}"`;
const notIn = (...labels: string[]) => labels.map((l) => `-${q(l)}`).join(" ");

// ---------------------------------------------------------------------------
// Plan：确定性计算，不交给 agent（planner agent 曾把「同文件只留编号小的」比反）
// ---------------------------------------------------------------------------

/** 票的 open 状态，每次调度开头清空（blocker 可能在两次调度之间被合并）。 */
const openStates = new Map<number, boolean>();
function isOpen(n: number): boolean {
  if (!openStates.has(n)) {
    const r = trySh("gh", ["issue", "view", String(n), "--json", "state", "--jq", ".state"]);
    openStates.set(n, !r.ok || r.out === "OPEN"); // 查不到时当作 open，宁可少做
  }
  return openStates.get(n)!;
}

/** `## Blocked by` 里还没关的票。 */
const openBlockers = (body: string) => blockersOf(body).filter(isOpen);

/**
 * 拆过的父票：prep 拆票时去掉父票的 Sandcastle，正文加 `## Split into`，之后没人管它，
 * 被它 block 的票就一直排不上（2026-11-04 #381 的子票 #389、#390 都合并了，#382 仍在等 #381）。
 * 每次调度开头查不带 Sandcastle、有 `## Split into` 的 open 票，子票全关了就勾上清单、关掉父票。
 * 「上下文不够」那种父票保留 Sandcastle、由自己的 PR 关，不在这里处理。gh 出错只打警告。
 */
function closeFinishedParents() {
  const parents = trySh("gh", [
    "issue", "list", "--state", "open", "--limit", "100",
    "--search", `"Split into" in:body ${notIn(LABEL.picked)}`, "--json", "number,body",
  ]);
  if (!parents.ok) {
    console.warn(`  ⚠ 查拆过的父票失败：${parents.out.slice(0, 200)}`);
    return;
  }
  for (const parent of JSON.parse(parents.out) as { number: number; body: string }[]) {
    const children = splitChildren(parent.body);
    if (children.length === 0 || children.some(isOpen)) continue;
    const body = parent.body.replace(/^(\s*[-*]\s*)\[ \](?=\s*#\d+)/gm, "$1[x]");
    const list = children.map((n) => `#${n}`).join("、");
    if (body !== parent.body) trySh("gh", ["issue", "edit", String(parent.number), "--body", body]);
    const closed = trySh("gh", ["issue", "close", String(parent.number), "--comment", `子票 ${list} 都已关闭，Sandcastle 关闭父票。`]);
    if (closed.ok) {
      openStates.set(parent.number, false);
      console.log(`  ✓ 父票 #${parent.number} 的子票 ${list} 都已关闭，已关闭父票`);
    } else {
      console.warn(`  ⚠ 关闭父票 #${parent.number} 失败：${closed.out.slice(0, 200)}`);
    }
  }
}

/**
 * 已关闭票的残留：人在 GitHub 上手动合并 Sandcastle 的 PR、或在运行中途合并 / 关掉正在做的票时，
 * land 不会走到删分支那一步（2026-11-08 #450：PR #456 由人合并），远端分支、本地 worktree 与分支、
 * sandcastle:* 状态标签都留着。每次调度开头清一次：
 * - 已关闭票上的 prepped / pr-open / stuck 去掉（decided 等人事后确认、flaky 是分类，不动）；
 * - `sandcastle/issue-<n>` 只在票已关闭、且这个分支有已合并的 PR 时删：远端分支、本地 worktree、本地分支。
 *   worktree 有未提交改动时 git 拒绝删除，留着并警告。没合并就关掉的票（不做了）分支留着，里面的提交可能还有人要看。
 * 出错只打警告。
 */
async function cleanupClosedIssues() {
  for (const label of [LABEL.prepped, LABEL.prOpen, LABEL.stuck]) {
    const closed = trySh("gh", [
      "issue", "list", "--state", "closed", "--label", label, "--limit", "100", "--json", "number", "--jq", ".[].number",
    ]);
    if (!closed.ok) {
      console.warn(`  ⚠ 查带 ${label} 的已关闭票失败：${closed.out.slice(0, 200)}`);
      continue;
    }
    const cleared: string[] = [];
    for (const n of closed.out.split("\n").filter(Boolean)) {
      const edited = trySh("gh", ["issue", "edit", n, "--remove-label", label]);
      if (edited.ok) cleared.push(`#${n}`);
      else console.warn(`  ⚠ 去掉 #${n} 的 ${label} 失败：${edited.out.slice(0, 200)}`);
    }
    if (cleared.length > 0) console.log(`  🧹 已关闭的票去掉 ${label}：${cleared.join("、")}`);
  }

  const branchOf = /^sandcastle\/issue-(\d+)$/;
  const remote = await gitRemote(["ls-remote", "--heads", REMOTE, "sandcastle/issue-*"]);
  if (!remote.ok) console.warn(`  ⚠ 列远端的 sandcastle 分支失败：${remote.out.slice(0, 200)}`);
  const remoteBranches = remote.ok
    ? remote.out.split("\n").map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, "") ?? "").filter((b) => branchOf.test(b))
    : [];
  const local = trySh("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/sandcastle/"]);
  const localBranches = local.ok ? local.out.split("\n").filter((b) => branchOf.test(b)) : [];
  // git worktree list --porcelain：每个 worktree 一段，`worktree <path>` 后面跟 `branch refs/heads/<name>`
  const worktrees = new Map<string, string>();
  let path = "";
  for (const line of trySh("git", ["worktree", "list", "--porcelain"]).out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) worktrees.set(line.slice("branch refs/heads/".length), path);
  }

  for (const branch of new Set([...remoteBranches, ...localBranches])) {
    const id = branch.match(branchOf)![1]!;
    if (!issueClosed(id)) continue;
    const pr = trySh("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "number", "--jq", ".[0].number"]);
    if (!pr.ok || !pr.out) continue;
    const removed: string[] = [];
    if (remoteBranches.includes(branch)) {
      const deleted = await gitRemote(["push", REMOTE, "--delete", branch]);
      if (deleted.ok) removed.push("远端分支");
      else console.warn(`  ⚠ 删除远端分支 ${branch} 失败：${deleted.out.slice(0, 200)}`);
    }
    const worktree = worktrees.get(branch);
    if (worktree) {
      const gone = trySh("git", ["worktree", "remove", worktree]);
      if (!gone.ok) {
        console.warn(`  ⚠ #${id} 的 worktree ${worktree} 没删（有未提交改动？）：${gone.out.slice(0, 200)}`);
        continue;
      }
      removed.push("worktree");
    }
    if (localBranches.includes(branch) && trySh("git", ["branch", "-D", branch]).ok) removed.push("本地分支");
    if (removed.length > 0) console.log(`  🧹 #${id} 已关闭、PR #${pr.out} 已合并，删除${removed.join("、")}`);
  }
}

/**
 * 能在 main 上开工、且可以并行的票，按编号从小到大。
 * blocker 没关（包括已开 PR 未合并）的跳过；和已选的票、或等人审（pr-open）的票改同一个文件的跳过，
 * 所以冲突时总是编号小的先做，等人审的 PR 合入或关闭前不会有第二个 PR 改同一个文件。
 * 被 blocker 挡住的票不占文件，不会连带挡住编号大的票。
 * running 是正在 build / 落地的票：不再选，它们改的文件和等人审的票一样先占上；最多补满 slots 张。
 */
function plan(running: ReadonlySet<string>, slots: number): Issue[] {
  const candidates = listIssues([LABEL.picked, LABEL.prepped], [LABEL.prOpen, LABEL.stuck]);
  // 等人审的 PR 还没合进 main：它们改的文件先占上，免得新票在旧 main 上改同一个文件，两个 PR 互相冲突。
  const waiting = listIssues([LABEL.picked, LABEL.prOpen]);
  const taken = new Map<string, number>();
  const awaitingReview = new Set<number>();
  for (const w of waiting.sort((a, b) => a.number - b.number)) {
    awaitingReview.add(w.number);
    for (const f of changedFiles(w.body).files) if (!taken.has(f)) taken.set(f, w.number);
  }
  for (const r of candidates.filter((c) => running.has(String(c.number)))) {
    for (const f of changedFiles(r.body).files) if (!taken.has(f)) taken.set(f, r.number);
  }
  const picked: Issue[] = [];
  for (const issue of candidates.filter((c) => allowed(c.number) && !running.has(String(c.number))).sort((a, b) => a.number - b.number)) {
    const open = openBlockers(issue.body);
    if (open.length > 0) {
      console.log(`  跳过 #${issue.number}：blocker ${open.map((n) => `#${n}`).join("、")} 还没关`);
      continue;
    }
    const { files, fallback } = changedFiles(issue.body);
    if (fallback) console.warn(`  ⚠ #${issue.number} 的指引里没认出 Change 行，按指引引用的文件处理：${files.join("、")}`);
    else if (files.length === 0) console.warn(`  ⚠ #${issue.number} 的指引里没认出要改的文件，按不改已有文件处理`);
    const clash = files.find((f) => taken.has(f));
    if (clash) {
      const owner = taken.get(clash)!;
      const why = awaitingReview.has(owner)
        ? `等人审的 #${owner}（PR 合入或关闭后再做）`
        : running.has(String(owner)) ? `正在做的 #${owner}` : `#${owner}`;
      console.log(`  跳过 #${issue.number}：和${why}都改 ${clash}`);
      continue;
    }
    if (picked.length >= slots) break;
    for (const f of files) taken.set(f, issue.number);
    // 已有外部 PR（`Closes` 了这张票）时在它的分支上接着改；否则照旧用自己的分支。
    const pr = prFor(issue.number);
    const branch = pr && !pr.headRefName.startsWith("sandcastle/") ? pr.headRefName : ownBranch(issue.number);
    picked.push({ id: String(issue.number), title: issue.title, branch });
  }
  return picked;
}

/** 每次迭代结束时的上下文大小（最后一条 assistant 消息的输入 token）。 */
/** implement 的几次会话合在一起（每次会话单独挑档案，分开跑）。 */
type Sessions = { iterations: sandcastle.IterationResult[]; stdout: string; completionSignal?: string };
const peakContext = (...runs: ({ readonly iterations: readonly sandcastle.IterationResult[] } | undefined)[]) =>
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

const ownBranch = (issueId: string | number) => `sandcastle/issue-${issueId}`;
/**
 * 外部 PR：别人（其他 agent、人）开的、`Closes` 了这张票的 PR，分支不是 `sandcastle/` 开头。
 * Sandcastle 在它的分支上接着改，但只做普通 push：不 force、不 rebase、不合并、不删分支，合并留给人。
 */
const isExternal = (issue: Issue) => !issue.branch.startsWith("sandcastle/");

/** 推分支：自己的分支照旧 force-with-lease（rebase 过）；外部分支只做普通 push，被拒就报错。 */
function pushBranch(issue: Issue) {
  return gitRemote(isExternal(issue)
    ? ["push", REMOTE, `${issue.branch}:${issue.branch}`]
    : ["push", "--force-with-lease", "-u", REMOTE, issue.branch]);
}

type LinkedPr = {
  number: number;
  state: string;
  headRefName: string;
  isCrossRepository: boolean;
  reviews: { state: string; body: string; submittedAt: string }[];
  comments: { body: string; createdAt: string }[];
  commits: { committedDate: string }[];
};
const PR_FIELDS = "number,state,headRefName,isCrossRepository,reviews,comments,commits";

/**
 * 这张票的 open PR：先按 issue 关联（PR 正文的 `Closes #n`），同时有自己的分支时用自己的；
 * 关联里只有一个本仓库的外部 PR 时用它；有多个外部 PR 时不猜，返回 null 并打日志。
 * 关联查不到（接口出错、没有关联）时退回按分支名 `sandcastle/issue-n` 查，和改之前一样。
 */
function prFor(issueId: string | number): LinkedPr | null {
  const view = (ref: string): LinkedPr | null => {
    const r = trySh("gh", ["pr", "view", ref, "--json", PR_FIELDS]);
    if (!r.ok) return null;
    const pr = JSON.parse(r.out) as LinkedPr;
    return pr.state === "OPEN" ? pr : null;
  };
  const linked = trySh("gh", ["issue", "view", String(issueId), "--json", "closedByPullRequestsReferences", "--jq", ".closedByPullRequestsReferences[].number"]);
  const prs = linked.ok
    ? linked.out.split("\n").filter(Boolean).map(view).filter((pr): pr is LinkedPr => pr !== null && !pr.isCrossRepository)
    : [];
  const own = prs.find((pr) => pr.headRefName === ownBranch(issueId));
  if (own) return own;
  const external = prs.filter((pr) => !pr.headRefName.startsWith("sandcastle/"));
  if (external.length > 1) {
    console.warn(`  ⚠ #${issueId} 关联了多个外部 PR（${external.map((pr) => `#${pr.number}`).join("、")}），不知道在哪个上改，跳过`);
    return null;
  }
  return external[0] ?? view(ownBranch(issueId));
}

/**
 * 外部 PR 的分支：开沙箱前同步到宿主机本地（沙箱从本地分支建 worktree，本地没有就会从 main 新建，丢掉对方的提交）。
 * 本地没有就从远端建；本地落后就快进；本地领先（上次没推上去）就保留；两边分叉就报错，交给人。
 */
async function syncExternalBranch(issue: Issue) {
  await gitRemoteOrThrow(["fetch", REMOTE, issue.branch]);
  const remote = `${REMOTE}/${issue.branch}`;
  if (!trySh("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${issue.branch}`]).ok) {
    sh("git", ["branch", issue.branch, remote]);
  } else if (trySh("git", ["merge-base", "--is-ancestor", issue.branch, remote]).ok) {
    sh("git", ["branch", "-f", issue.branch, remote]);
  } else if (!trySh("git", ["merge-base", "--is-ancestor", remote, issue.branch]).ok) {
    throw new Error(`本地分支 ${issue.branch} 和 ${remote} 分叉了（PR 作者在 Sandcastle 处理期间推过提交？），请人合并后再跑。`);
  }
}

/** 截图附件：gh 2.99+ 的 --attach 上传图片，没在正文里引用的附在末尾 */
const attachArgs = (shots: string[]) =>
  shots.flatMap((file) => ["--attach", `${file}#${basename(file)}`]);

async function pushAndOpenPr(issue: Issue, notes: string, shots: string[]): Promise<string> {
  const pushed = await pushBranch(issue);
  if (!pushed.ok) throw new Error(`push ${issue.branch} 失败：${pushed.out.slice(0, 500)}`);
  const existing = sh("gh", [
    "pr", "list", "--head", issue.branch, "--state", "open", "--json", "number", "--jq", ".[0].number",
  ]);
  if (existing) {
    sh("gh", ["pr", "comment", existing, "--body", `Sandcastle 更新了这个分支。\n\n${notes}`, ...attachArgs(shots)]);
    return existing;
  }
  // 外部 PR 不在这里新开：它被关了就说明人不要了。
  if (isExternal(issue)) throw new Error(`分支 ${issue.branch} 上已经没有 open 的 PR，外部 PR 不由 Sandcastle 重开。`);
  const commits = sh("git", ["log", `${BASE_REF}..${issue.branch}`, "--format=- %B"]);
  const body = `Closes #${issue.id}\n\n${notes}\n\n## Commits\n\n${commits}`;
  const url = sh("gh", [
    "pr", "create", "--base", BASE_BRANCH, "--head", issue.branch,
    "--title", `${issue.title} (#${issue.id})`, "--body", body, ...attachArgs(shots),
  ]);
  return url.split("/").pop()!;
}

function leaveForHuman(issue: Issue, pr: string, reason: string) {
  sh("gh", ["issue", "edit", issue.id, "--add-label", LABEL.prOpen]);
  sh("gh", ["pr", "comment", pr, "--body", `没有自动合并：${reason}`]);
}

/** agent 代拍板过的票：打 sandcastle:decided，把那些评论贴到 PR 上，人事后确认。gh 出错只警告，不影响落地。 */
function reportDecisions(issueId: string, pr: string) {
  const r = trySh("gh", ["issue", "view", issueId, "--json", "comments", "--jq", ".comments[].body | select(startswith(\"" + DECIDED_MARK + "\")) | @json"]);
  if (!r.ok) return console.warn(`  ⚠ 读 #${issueId} 的代拍板评论失败：${r.out.slice(0, 200)}`);
  const decisions = r.out.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as string).slice(DECIDED_MARK.length).trim());
  if (!decisions.length) return;
  const label = trySh("gh", ["issue", "edit", issueId, "--add-label", LABEL.decided]);
  const comment = trySh("gh", ["pr", "comment", pr, "--body", `## 代拍板\n\nagent 按 \`.sandcastle/DECISIONS.md\` 自己定了 ${decisions.length} 个设计决定，请事后确认（不同意就在 issue 上回复，确认后去掉 #${issueId} 的 \`${LABEL.decided}\`）：\n\n${decisions.map((d, n) => `<details><summary>第 ${n + 1} 个</summary>\n\n${d}\n\n</details>`).join("\n\n")}`]);
  for (const x of [label, comment]) if (!x.ok) console.warn(`  ⚠ #${issueId} 代拍板标记失败：${x.out.slice(0, 200)}`);
  console.log(`  📝 #${issueId} 有 ${decisions.length} 个代拍板，打 ${LABEL.decided}`);
}

function markStuck(issueId: string, reason: string) {
  sh("gh", ["issue", "edit", issueId, "--add-label", LABEL.stuck]);
  sh("gh", ["issue", "comment", issueId, "--body", `Sandcastle 停下了：${reason}`]);
}

/** PR 上以这个开头的评论或 review 正文表示「打回 Sandcastle」（作者不能对自己的 PR 点 Request changes）。 */
const REVISE_COMMAND = "/sandcastle";

/**
 * 等人审的票：PR 上有晚于分支最新提交的打回信号（`/sandcastle` 开头的评论或 review，或别人点的
 * Request changes）→ 去掉 issue 的 pr-open，让它回到 plan。比较时间是为了不重复回流：
 * Sandcastle 改完推上新提交后，同一条意见不再算数。
 */
function reopenRequestedRevisions() {
  for (const { number: issueId } of listIssues([LABEL.prOpen], [LABEL.stuck])) {
    if (!allowed(issueId)) continue;
    const pr = prFor(issueId);
    if (!pr) continue;
    const lastCommit = pr.commits.map((c) => c.committedDate).sort().at(-1) ?? "";
    const signals = [
      ...pr.reviews
        .filter((r) => r.state === "CHANGES_REQUESTED" || r.body.trim().startsWith(REVISE_COMMAND))
        .map((r) => r.submittedAt),
      ...pr.comments.filter((c) => c.body.trim().startsWith(REVISE_COMMAND)).map((c) => c.createdAt),
    ];
    if (!signals.some((at) => at > lastCommit)) continue;
    sh("gh", ["issue", "edit", String(issueId), "--remove-label", LABEL.prOpen]);
    sh("gh", ["pr", "comment", String(pr.number), "--body", "收到打回，这张票重新进入 Sandcastle：implementer 会先处理这个 PR 上的意见。"]);
    console.log(`  ↺ #${issueId} 收到打回（PR #${pr.number}），重新排队`);
  }
}

/**
 * 门槛里重跑才通过的测试文件：按报错签名去重开票（带 Sandcastle，下次调度自动 prep + 修）。
 * 同签名（同根因落在不同文件）只开一张；已有同签名、或标题 `偶发失败：<文件>` 相同的老票，
 * 就在那张票上追加一次出现记录，不重复开票。返回票号，写进 PR 的 Gate 一节。
 */
function reportFlaky(issue: Issue, pr: string, gateOutput: string): string[] {
  const [before, after = ""] = gateOutput.split("GATE_FLAKY");
  const files = [...new Set(before!.match(/^test\/\S+\.test\.tsx?$/gm) ?? [])];
  if (files.length === 0) return [];
  trySh("gh", ["label", "create", LABEL.flaky, "--color", "fbca04", "--description", "偶发失败的测试（Sandcastle 门槛自动开票）"]);
  const open: { number: number; title: string; body: string }[] = JSON.parse(
    sh("gh", ["issue", "list", "--state", "open", "--label", LABEL.flaky, "--limit", "100", "--json", "number,title,body"]),
  );
  const seen = `#${issue.id} 的门槛（PR #${pr}）`;
  const summary = `\`\`\`\n${after.trim().slice(0, 3000)}\n\`\`\``;
  // 分组、签名标记、标题与已有票的匹配见 guide.ts 的 flakyTickets；这里只拼正文 / 评论并调 gh。
  return flakyTickets(files, after, open).map(({ files: groupFiles, marker, title, existing }) => {
    const list = groupFiles.map((f) => `\`${f}\``).join("、");
    if (existing !== undefined) {
      const again = marker
        ? `又出现一次：${seen}，这次失败的文件：${list}。`
        : `又出现一次：${seen}。`;
      sh("gh", ["issue", "comment", String(existing), "--body", `${again}第一次的失败：\n\n${summary}`]);
      return `#${existing}`;
    }
    const body = [
      `${list} 在 ${seen}的完整测试里失败，单独重跑通过。沙箱里完整测试用 4 个 worker 并行（\`CRM_TEST_WORKERS=4\`），约 40 分钟。`,
      "", "## 第一次的失败", "", summary, "",
      "## 怎么修", "",
      "按诊断难 bug 的做法：先有一条能让它稳定变红的命令，再改。",
      "",
      "- 先读失败摘要判断类型：超时（hook / 用例在负载下变慢）、随机数据撞上断言、用例之间共享状态或顺序依赖、外部服务连接。",
      "- 先查同样的报错是不是已经修过：`gh issue list --label flaky --state closed --search \"<报错关键句>\"`，再 `git log --oneline -S` / `--grep` 找对应提交。已经修过（失败的分支早于那个提交）就不用复现，提交信息写明是哪个提交修的、依据是什么。",
      "- 复现：要的是一条修复前变红、修复后变绿的命令。超时、随机数据类可以单跑这个文件，或和重夹具文件一起跑、在后台占满 CPU 再跑；跨进程 / 跨沙箱的竞争（共用的 PG 角色、库、对象等）单跑复现不了，照 #439 写一个并发用例让它稳定变红。重复单跑只作补充，总共不超过 20 分钟。复现不了就照摘要从代码推断原因，并在提交信息里写明推断依据。",
      "- 沙箱里全局超时已是 180 s / 120 s（`CRM_TEST_TIMEOUT_SCALE=2`），再超时先查是否真卡住，不要只是继续放宽。",
      "- 超时类：确认是负载下变慢才给单个 hook / 用例放宽超时（照 2bcb07a 的写法），不改全局配置。随机数据类：改断言或数据，让它不可能撞上。",
      "",
      "## Acceptance criteria", "",
      "- [ ] 失败原因写进提交信息（复现命令，或推断的依据）",
      `- [ ] 修复后复现命令变绿、${list} 单跑通过（重复单跑总共不超过 20 分钟）；根因已被别的提交修掉时只核实、不改代码`,
      "- [ ] 不放宽全局超时，不删除或改弱断言",
    ].join("\n");
    const url = sh("gh", [
      "issue", "create", "--title", title, "--body", marker ? `${body}\n${marker}` : body,
      "--label", LABEL.flaky, "--label", LABEL.picked, "--label", "ready-for-agent",
    ]);
    return `#${url.split("/").pop()}`;
  });
}

// ---------------------------------------------------------------------------
// Build one issue inside its own sandbox
// ---------------------------------------------------------------------------

async function build(issue: Issue) {
  if (isExternal(issue)) await syncExternalBranch(issue);
  const env = testEnv(issue.id);
  const sandbox = await sandcastle.createSandbox({
    branch: issue.branch,
    baseBranch: BASE_REF,
    sandbox: sandboxFor(env),
    hooks,
    copyToWorktree,
  });
  const usage: UsageRecord[] = [];
  const run = (phase: Phase, name: string, fn: (agent: sandcastle.AgentProvider) => Promise<sandcastle.SandboxRunResult>) =>
    runAgent(phase, issue.id, name, env, usage, fn);
  try {
    // 每次会话单独挑档案：撞了限额，下一次会话就换下一个档案接着做（交接靠 issue 上的进度评论）。
    // 档案名经环境变量 SANDCASTLE_PROFILE 给 implementer，不走 promptArgs：运行中的旧进程也会读到新提示词，多出的占位符会让它报错。
    const implement: Sessions = { iterations: [], stdout: "" };
    for (let session = 1; session <= IMPLEMENT_MAX_ITERATIONS && implement.completionSignal === undefined; session++) {
      const r = await run("implement", `implement-${issue.id}-${session}`, (agent) => sandbox.run({
        name: `implement-${issue.id}-${session}`,
        maxIterations: 1,
        completionSignal: [COMPLETE, NEEDS_DECISION],
        agent,
        promptFile: "./.sandcastle/implement-prompt.md",
        promptArgs: { TASK_ID: issue.id, ISSUE_TITLE: issue.title, BRANCH: issue.branch },
      }));
      implement.iterations.push(...r.iterations);
      implement.stdout += r.stdout;
      implement.completionSignal = r.completionSignal;
    }
    // 看分支上的提交，不看这次会话的：重新准备后父票只剩已完成的部分，收尾时可能不再提交。
    const ahead = Number((await sandbox.exec(`git rev-list --count ${BASE_REF}..HEAD`)).stdout.trim()) || 0;
    if (implement.completionSignal !== COMPLETE || ahead === 0) {
      return { done: false as const, implement, usage };
    }

    const runReview = (round: number) =>
      run("review", `review-${issue.id}-${round}`, (agent) => sandbox.run({
        name: `review-${issue.id}-${round}`,
        maxIterations: 1,
        agent,
        promptFile: "./.sandcastle/review-prompt.md",
        promptArgs: { TASK_ID: issue.id, BRANCH: issue.branch, ROUND: round, REVISE_MAX },
      }));
    // reviewer 给 revise：修改意见交给新的 implementer 会话，改完再审一次。
    const reviews = [await runReview(0)];
    const revisions: { items: string; run: sandcastle.SandboxRunResult }[] = [];
    while (revisions.length < REVISE_MAX && tagged(reviews.at(-1)!.stdout, "verdict") === "revise") {
      const items = tagged(reviews.at(-1)!.stdout, "revise") ?? "（reviewer 没有列出修改意见）";
      const name = `revise-${issue.id}-${revisions.length + 1}`;
      const revise = await run("revise", name, (agent) => sandbox.run({
        name,
        maxIterations: 1,
        agent,
        prompt: [
          `分支 ${issue.branch}（issue #${issue.id}：${issue.title}）的 review 打回了，修改意见如下。`,
          "", items, "",
          `先 \`gh issue view ${issue.id}\` 看验收标准，再逐条处理上面的意见。遵守 CLAUDE.md 的「Context budget」：从意见给的 file:line 出发，grep -n 定位，不要广泛探索。`,
          "改行为的意见先写或改测试（跑红再跑绿）。只跑改到的测试文件（`npx vitest run <file>`）和 `npm run typecheck`，不要跑完整测试。",
          `每条意见处理完提交一次，按仓库风格写中文提交信息、末尾 (#${issue.id})。`,
          "某条意见你判断不该改（与票冲突、要人拍板），不要改，在输出里写明哪条、为什么。",
          "最后输出 <promise>COMPLETE</promise>。",
        ].join("\n"),
      }));
      revisions.push({ items, run: revise });
      reviews.push(await runReview(revisions.length));
    }
    const review = reviews.at(-1)!;

    const gate = () => sandbox.exec(`${envPrefix(env)} sh -c ${shellQuote(GATE_SCRIPT)}`);
    let gateResult = await gate();
    let fix: sandcastle.SandboxRunResult | undefined;
    if (gateResult.exitCode !== 0) {
      // 给 implementer 一次修的机会（新会话），再跑一次门槛。
      fix = await run("fix", `fix-${issue.id}`, (agent) => sandbox.run({
        name: `fix-${issue.id}`,
        maxIterations: 1,
        agent,
        prompt: [
          `分支 ${issue.branch}（issue #${issue.id}）在合并门槛上失败，摘要如下；完整日志在 /tmp/gate-typecheck.log、/tmp/gate-test.log 与重跑的 /tmp/gate-rerun.log（用 grep 看，不要整读）。测试失败的文件不超过 ${GATE_RERUN_MAX} 个时已经单独重跑过一次，仍失败才到你这里。`,
          "```", gateResult.stdout.slice(-4000), "```",
          "只修这些失败：用 `npx vitest run <file>` 跑失败的文件确认变绿，按仓库风格写中文提交信息、末尾 (#" + issue.id + ")。",
          "如果失败与本票改动无关（偶发、环境问题）或不能确定怎么修，不要改代码，在输出里说明原因。",
          "最后输出 <promise>COMPLETE</promise>。",
        ].join("\n"),
      }));
      gateResult = await gate();
    }

    return {
      done: true as const,
      implement,
      runs: [...reviews, ...revisions.map((r) => r.run), fix],
      revisions: revisions.map((r) => r.items),
      verdict: tagged(review.stdout, "verdict"),
      summary: tagged(review.stdout, "review-summary") ?? "（reviewer 没有给出摘要）",
      gate: { ok: gateResult.exitCode === 0, output: gateResult.stdout.slice(-3000) },
      browser: collectBrowserCheck(sandbox.worktreePath, issue.id),
      usage,
    };
  } finally {
    await sandbox.close();
    await dropTestResources(issue.id);
  }
}

// ---------------------------------------------------------------------------
// Rebase + retry merge（合并失败时）
// ---------------------------------------------------------------------------

const REBASE_STATE = "test -d \"$(git rev-parse --git-path rebase-merge)\" || test -d \"$(git rev-parse --git-path rebase-apply)\"";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// drizzle 迁移按目录排序、靠 snapshot.json 的 prevIds 串成链。两张票各生成一个迁移时 rebase 没有文本冲突，
// 但链分叉了：本票加的第一个迁移的 prevIds 必须含 origin/main 最新迁移的 id，否则要重新生成。
const migrationChainOk = (head: string) => [
  `MIG=$(git diff --name-only --diff-filter=A ${BASE_REF}...${head} -- 'drizzle/*/snapshot.json' | sort | head -1)`,
  '[ -z "$MIG" ] && exit 0',
  `LATEST=$(git ls-tree --name-only ${BASE_REF} drizzle/ | sort | tail -1)`,
  `ID=$(git show ${BASE_REF}:$LATEST/snapshot.json | jq -r .id)`,
  `git show ${head}:$MIG | jq -e --arg id "$ID" '.prevIds | index($id)' > /dev/null`,
].join("; ");
const MIGRATION_CHAIN_OK = migrationChainOk("HEAD");

/**
 * 把分支 rebase 到最新的 origin/main：没冲突直接 rebase；有冲突开一次 agent 会话按
 * rebase-prompt.md 解决。然后重跑门槛，通过才 force-push；merge 为 true 时再合并一次，
 * 为 false 时只更新 PR（留给人审的 PR 不和 main 冲突）。
 * 任何一步不成都返回原因，由调用方留 PR。
 */
async function rebaseAndMerge(issue: Issue, pr: string, merge = true): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (isExternal(issue)) return { ok: false, reason: `外部 PR 的分支 ${issue.branch} 不由 Sandcastle rebase 或合并。` };
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const env = testEnv(issue.id);
  const sandbox = await sandcastle.createSandbox({ branch: issue.branch, baseBranch: BASE_REF, sandbox: sandboxFor(env), hooks, copyToWorktree });
  try {
    const behind = await sandbox.exec(`git merge-base --is-ancestor ${BASE_REF} HEAD`);
    if (behind.exitCode === 0) {
      return { ok: false, reason: `分支已经包含最新的 ${BASE_REF}，失败不是冲突造成的，需要人看。` };
    }

    const rebase = await sandbox.exec(`git rebase ${BASE_REF}`);
    const conflicted = rebase.exitCode !== 0;
    const chainBroken = !conflicted && (await sandbox.exec(MIGRATION_CHAIN_OK)).exitCode !== 0;
    if (conflicted || chainBroken) {
      // 用量只进 usage.jsonl：这时 PR 已经开了。
      await runAgent("rebase", issue.id, `rebase-${issue.id}`, env, [], (agent) => sandbox.run({
        name: `rebase-${issue.id}`,
        maxIterations: 1,
        agent,
        promptFile: "./.sandcastle/rebase-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          BRANCH: issue.branch,
          BASE: BASE_REF,
          SITUATION: conflicted
            ? `\`git rebase ${BASE_REF}\` 停在冲突上（rebase 进行中）。`
            : `rebase 没有冲突，但本票的 drizzle 迁移没有接在 ${BASE_REF} 最新的迁移后面，需要重新生成。`,
        },
      }));
      if ((await sandbox.exec(REBASE_STATE)).exitCode === 0) {
        await sandbox.exec("git rebase --abort");
        return { ok: false, reason: "agent 没能解决 rebase 冲突（原因见 issue 评论）。" };
      }
      if ((await sandbox.exec(`git merge-base --is-ancestor ${BASE_REF} HEAD`)).exitCode !== 0) {
        return { ok: false, reason: `处理后分支仍不在 ${BASE_REF} 之上。` };
      }
      if ((await sandbox.exec(MIGRATION_CHAIN_OK)).exitCode !== 0) {
        return { ok: false, reason: `drizzle 迁移仍没有接在 ${BASE_REF} 最新的迁移后面。` };
      }
    }

    const gate = await sandbox.exec(`${envPrefix(env)} sh -c ${shellQuote(GATE_SCRIPT)}`);
    if (gate.exitCode !== 0) {
      return { ok: false, reason: `rebase 后门槛失败：\n\n\`\`\`\n${gate.stdout.slice(-2000)}\n\`\`\`` };
    }

    await gitRemoteOrThrow(["push", "--force-with-lease", REMOTE, issue.branch]);
    if (!merge) {
      sh("gh", ["pr", "comment", pr, "--body", `Sandcastle 把分支 rebase 到最新的 ${BASE_REF}（原来和它冲突），门槛重跑通过。`]);
      return { ok: true };
    }
    // GitHub 重新计算可合并状态要一点时间。
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(10_000);
      const merged = trySh("gh", ["pr", "merge", pr, "--rebase"]);
      if (merged.ok) {
        sh("gh", ["pr", "comment", pr, "--body", `Sandcastle 把分支 rebase 到最新的 ${BASE_REF}，门槛重跑通过后合并。`]);
        return { ok: true };
      }
      last = merged.out;
    }
    return { ok: false, reason: `rebase 并通过门槛后仍合并失败：${last.slice(0, 300)}` };
  } finally {
    await sandbox.close();
    await dropTestResources(issue.id);
  }
}

// ---------------------------------------------------------------------------
// 用量限额：等到重置后接着跑，不当成票的失败
// ---------------------------------------------------------------------------

// 撞限额的识别、重置时间的解析和换档案在 models.ts；这里处理「这个阶段的档案都在等」：等到最早恢复的那个再从头跑。
const LIMIT_RESUME_SLACK_MS = 2 * 60_000; // 重置时间之后再多等一会儿
const LIMIT_FALLBACK_WAIT_MS = 30 * 60_000; // 认不出重置时间时每次等这么久再试

/** 分步睡：笔记本合盖时计时器会停，醒来按墙上时间判断。 */
async function sleepUntil(at: number) {
  while (Date.now() < at) await sleep(Math.min(60_000, at - Date.now()));
}

/**
 * 跑 fn，撞上用量限额就等到重置后重跑；其他错误照抛。
 * fn 要能从头重跑：prep 本来就幂等；build 重跑时在原分支上接着做（implementer 先看已有提交）。
 * onLimit 在等之前调用，比如把分支推到远端。
 */
async function untilAfterLimit<T>(what: string, fn: () => Promise<T>, onLimit?: () => void | Promise<void>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const limit = limitWait(e);
      if (!limit) throw e;
      await onLimit?.();
      console.log(`  ⏸ ${what} 撞上用量限额，${limit.why}等到 ${new Date(limit.until).toLocaleString()} 再接着跑`);
      await sleepUntil(limit.until);
    }
  }
}

/** 错误是用量限额时，该等到什么时候（含余量）；不是限额返回 null。 */
function limitWait(e: unknown): { until: number; why: string } | null {
  // AllProfilesLimited 的 until 已经含了余量。
  if (e instanceof AllProfilesLimited) return { until: e.until, why: "" };
  const message = String(e);
  if (!CLAUDE_LIMIT_PATTERN.test(message)) return null;
  const resetAt = limitResetAt(message);
  return resetAt === null
    ? { until: Date.now() + LIMIT_FALLBACK_WAIT_MS, why: `认不出重置时间（${message.slice(0, 200)}），` }
    : { until: resetAt + LIMIT_RESUME_SLACK_MS, why: "" };
}

/** 分支上已有提交时推到远端，免得只留在宿主机上。 */
async function pushIfAhead(issue: Issue) {
  const ahead = trySh("git", ["rev-list", "--count", `${BASE_REF}..${issue.branch}`]);
  if (ahead.ok && Number(ahead.out) > 0) await pushBranch(issue);
}

/** issue 已关闭（人在运行中途合并了 PR、或手动关了票）。查不到时当作没关。 */
function issueClosed(id: string) {
  const r = trySh("gh", ["issue", "view", id, "--json", "state", "--jq", ".state"]);
  return r.ok && r.out === "CLOSED";
}

/** Phase 3：一张票的落地。在宿主机上做，用宿主机的 git / gh 凭据，沙箱没有写仓库的权限。 */
/**
 * 要留给人审的分支如果和最新的 origin/main 有文本冲突（或 drizzle 迁移链分叉），走 rebaseAndMerge 但不合并。
 * 返回附在 leaveForHuman 说明后面的一句话；不需要 rebase 时为空串。
 */
async function rebaseIfConflicting(issue: Issue, pr: string): Promise<string> {
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const clean = trySh("git", ["merge-tree", "--write-tree", "--name-only", BASE_REF, issue.branch]).ok;
  const chainOk = trySh("sh", ["-c", migrationChainOk(issue.branch)]).ok;
  if (clean && chainOk) return "";
  console.log(`  ↻ #${issue.id} 和最新的 ${BASE_REF} 冲突，rebase 后再留给人审`);
  const r = await untilAfterLimit(`rebase #${issue.id}`, () => rebaseAndMerge(issue, pr, false));
  return r.ok
    ? `\n\n分支和最新的 ${BASE_REF} 冲突，已 rebase 并重跑门槛通过。`
    : `\n\n⚠️ 分支和最新的 ${BASE_REF} 冲突，自动 rebase 没成：${r.reason}`;
}

async function land(issue: Issue, outcome: PromiseSettledResult<Awaited<ReturnType<typeof build>>>) {
  // 运行期间人已经合并了这张票的 PR 或关了票：不再 push、开 PR、打标签，本地分支留着备查。
  if (issueClosed(issue.id)) {
    console.log(`  ⏭ #${issue.id} 已被关闭（运行期间有人合并了 PR 或关了票），跳过落地`);
    return;
  }
  if (outcome.status === "rejected") {
    console.error(`  ✗ #${issue.id} 失败：${outcome.reason}`);
    markStuck(issue.id, `沙箱出错：${String(outcome.reason).slice(0, 500)}`);
    return;
  }
  const result = outcome.value;
  const peak = result.done
    ? peakContext(result.implement, ...result.runs)
    : peakContext(result.implement);
  const budgetNote = `上下文峰值约 ${Math.round(peak / 1000)}k / ${CONTEXT_BUDGET / 1000}k，implement 用了 ${result.implement.iterations.length} 次会话。`;
  if (!result.done) {
    // implementer 判断必须由人拍板：推上已有的提交，直接交给人，不退回 prep。
    if (result.implement.completionSignal === NEEDS_DECISION) {
      const pushed = (await pushBranch(issue)).ok;
      trySh("gh", ["issue", "edit", issue.id, "--add-label", "ready-for-human"]);
      markStuck(issue.id, `implementer 遇到必须由人拍板的设计决定（见上面 implementer 的评论）。${budgetNote}${pushed ? `已有的提交推到了分支 \`${issue.branch}\`。` : "提交没能推上去，留在宿主机的本地分支上。"}拍板后在票上回复，去掉 ${LABEL.stuck} 即可接着跑。`);
      console.log(`  ✋ #${issue.id} 要人拍板，打 ${LABEL.stuck}`);
      return;
    }
    const comments = sh("gh", ["issue", "view", issue.id, "--json", "comments", "--jq", "[.comments[].body] | join(\"\\n\")"]);
    if (comments.includes(REPREP_MARK)) {
      markStuck(
        issue.id,
        `重新准备过一次，${IMPLEMENT_MAX_ITERATIONS} 次会话内仍没有完成（见上面 implementer 的评论）。${budgetNote} 请人看一下票怎么拆。`,
      );
      return;
    }
    // 外部 PR 不退回 prep（prep 会按 sandcastle/issue-n 拆票）：推上已有的提交，交给人。
    if (isExternal(issue)) {
      const pushed = (await pushBranch(issue)).ok;
      markStuck(issue.id, `在外部 PR 的分支 \`${issue.branch}\` 上 ${IMPLEMENT_MAX_ITERATIONS} 次会话内没有改完（见上面 implementer 的评论）。${budgetNote}${pushed ? "已有的提交推到了这个分支。" : "提交没能推上去，留在宿主机的本地分支上。"}`);
      return;
    }
    // 第一次没做完：分支推上去免得部分提交只留在宿主机，提交列表写进评论给 prep 看，退回 prep 重新准备。
    const pushed = (await pushBranch(issue)).ok;
    const log = trySh("git", ["log", "--format=- %h %s", `${BASE_REF}..${issue.branch}`]);
    const commits = log.ok && log.out ? `\n\n分支 \`${issue.branch}\` 上已有的提交：\n\n${log.out}` : "\n\n分支上还没有提交。";
    sh("gh", ["issue", "edit", issue.id, "--remove-label", LABEL.prepped]);
    sh("gh", [
      "issue", "comment", issue.id, "--body",
      `${REPREP_MARK}\n${IMPLEMENT_MAX_ITERATIONS} 次会话内没有完成。${budgetNote} 下次调度时 prep 会按上面 implementer 的进度评论重新准备：指引不对就重写，票太大就把没完成的验收标准拆成子票。再没做完就打 ${LABEL.stuck}。${commits}${pushed ? "" : "\n\n（分支没能推到远端，下一轮会在本地的同名分支上接着做。）"}`,
    ]);
    console.log(`  ↺ #${issue.id} 没做完，退回 prep 重新准备`);
    return;
  }

  const overBudget = peak > CONTEXT_BUDGET ? "\n\n⚠️ 超过上下文预算，考虑把同类票切得更小。" : "";
  const flaky = result.gate.output.includes("GATE_FLAKY");
  // 先 push 开 PR 才有 PR 号；开票放在后面，票号用评论补到 PR 上。
  const gateNote = !result.gate.ok
    ? `❌ 门槛失败：\n\n\`\`\`\n${result.gate.output}\n\`\`\``
    : flaky
      ? `typecheck 通过；⚠️ 完整测试有偶发失败，失败的文件单独重跑通过（沙箱内）。已自动开票修（见 PR 评论）。\n\n\`\`\`\n${result.gate.output}\n\`\`\``
      : `typecheck 与完整测试通过（沙箱内）。\n\n\`\`\`\n${result.gate.output.slice(-500)}\n\`\`\``;
  const browserNote = result.browser
    ? `\n\n## Browser check\n\n${result.browser.result ?? "（implementer 没有写 RESULT.md）"}\n\n截图 ${result.browser.shots.length} 张，附在下面。`
    : "";
  const revisionNote = result.revisions.length
    ? `\n\n**reviewer 打回过 ${result.revisions.length} 次**（implementer 已按意见修改）：\n\n${result.revisions
        .map((items, n) => `<details><summary>第 ${n + 1} 次的意见</summary>\n\n${items}\n\n</details>`)
        .join("\n\n")}`
    : "";
  const pr = await pushAndOpenPr(
    issue,
    `## Review\n\n${result.summary}${revisionNote}${browserNote}\n\n## Gate\n\n${gateNote}\n\n## Budget\n\n${budgetNote}${overBudget}\n\n## Usage\n\n${usageTable(result.usage)}`,
    result.browser?.shots ?? [],
  );
  reportDecisions(issue.id, pr);
  if (flaky && result.gate.ok) {
    const tickets = reportFlaky(issue, pr, result.gate.output);
    if (tickets.length) sh("gh", ["pr", "comment", pr, "--body", `门槛里的偶发失败已开票：${tickets.join("、")}`]);
  }

  // 外部 PR 一律留给人合并：不 rebase、不合并，只报告 review 与门槛结果。
  if (isExternal(issue)) {
    await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
    const clean = trySh("git", ["merge-tree", "--write-tree", "--name-only", BASE_REF, issue.branch]).ok;
    leaveForHuman(
      issue,
      pr,
      `这是外部 PR，Sandcastle 只负责修改，合并由人决定。reviewer 结论：${result.verdict}；门槛${result.gate.ok ? "通过" : "没通过"}（见上面的评论）。` +
        (clean ? "" : `\n\n⚠️ 分支和最新的 ${BASE_REF} 有冲突，需要先把 ${BASE_BRANCH} 合进来。`),
    );
    console.log(`  ◐ #${issue.id} 外部 PR #${pr}，留给人合并`);
    return;
  }
  if (result.verdict !== "merge") {
    // 开工后 main 上合进了改同一处的票：先 rebase 好再交给人，免得人审的是一个合不进去的 PR。
    const rebaseNote = result.gate.ok ? await rebaseIfConflicting(issue, pr) : "";
    leaveForHuman(
      issue,
      pr,
      (result.verdict === "revise"
        ? `reviewer 打回 ${REVISE_MAX} 次后仍有要改的问题（见最新的 Review）。`
        : "reviewer 认为需要人审（见 PR 正文的 Review）。") + rebaseNote,
    );
    console.log(`  ◐ #${issue.id} 留 PR #${pr} 等人审`);
    return;
  }
  if (!result.gate.ok) {
    leaveForHuman(issue, pr, "typecheck 或完整测试没通过（见 PR 正文的 Gate）。");
    console.log(`  ◐ #${issue.id} 门槛失败，留 PR #${pr}`);
    return;
  }
  // 先合并的票可能让这张冲突：rebase 到最新的 origin/main（冲突交给 agent）、重跑门槛，再合并一次。
  // 迁移链要先在宿主机上查：没有文本冲突时 GitHub 会照样合并，分叉的迁移就进了 main。
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
  const chainOk = trySh("sh", ["-c", migrationChainOk(issue.branch)]).ok;
  const merged = chainOk
    ? trySh("gh", ["pr", "merge", pr, "--rebase"])
    : { ok: false as const, out: `本票的 drizzle 迁移没有接在 ${BASE_REF} 最新的迁移后面。` };
  if (!merged.ok) {
    console.log(`  ↻ #${issue.id} 没能直接合并，rebase 到最新的 ${BASE_REF} 后重试`);
    const retry = await untilAfterLimit(`rebase #${issue.id}`, () => rebaseAndMerge(issue, pr));
    if (!retry.ok) {
      leaveForHuman(issue, pr, `合并失败：${merged.out.slice(0, 300)}\n\nrebase 后重试也没成：${retry.reason}`);
      console.log(`  ◐ #${issue.id} 合并失败，留 PR #${pr}`);
      return;
    }
  }
  await gitRemote(["push", REMOTE, "--delete", issue.branch]);
  trySh("git", ["branch", "-D", issue.branch]);
  console.log(`  ✓ #${issue.id} 已合并（PR #${pr}）`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * 宿主机上的 git 与 GitHub 标签操作串行做：调度（整理、prep、plan）和落地不交错，
 * 免得落地合并的同时清理删掉它的 worktree，或 prep 挂着的工作区被快进。build 在沙箱里跑，不占锁。
 */
let hostQueue: Promise<unknown> = Promise.resolve();
function withHost<T>(fn: () => Promise<T>): Promise<T> {
  const run = hostQueue.then(fn);
  hostQueue = run.catch(() => {});
  return run;
}

/** 有票做完、让出空位时叫醒主循环；主循环没在等时记下来，下次等的时候立刻返回。 */
let notify: (() => void) | null = null;
let slotFreed = false;
function signalSlotFreed() {
  if (notify) notify();
  else slotFreed = true;
}
async function waitForSlotOrPoll(ms: number) {
  if (slotFreed) {
    slotFreed = false;
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => {
      notify = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    notify = done;
  });
  slotFreed = false;
}

/** 正在 build 或落地的票。一张票从开工到落地完一直占着空位：落地里的 rebase 补救也要跑门槛。 */
const running = new Map<string, Issue>();

/** 一张票独立跑完 build → 落地，做完就让出空位，不等同批的其他票。 */
function start(issue: Issue) {
  running.set(issue.id, issue);
  void (async () => {
    // 撞上限额的票等重置后在原分支上重跑，不打 stuck。
    const [outcome] = await Promise.allSettled([
      untilAfterLimit(`#${issue.id}`, () => retryTransient(`#${issue.id}`, () => build(issue)), () => pushIfAhead(issue)),
    ]);
    // 落地在宿主机上做：用宿主机的 git / gh 凭据，沙箱没有写仓库的权限。
    // 每张票单独兜底：一张票落地出错（网络、人在运行中途合并或删了分支等）不让整个运行崩掉。
    await withHost(async () => {
      try {
        await retryTransient(`落地 #${issue.id}`, () => land(issue, outcome!));
      } catch (e) {
        const reason = String((e as { stderr?: unknown }).stderr || e).trim().slice(0, 500);
        console.error(`  ✗ #${issue.id} 落地出错：${reason}`);
        // 打 stuck 不让下次再做；本地分支保留，人看过后去掉 stuck 即可接着跑。
        if (!issueClosed(issue.id)) trySh("gh", ["issue", "edit", issue.id, "--add-label", LABEL.stuck]);
        if (!issueClosed(issue.id)) trySh("gh", ["issue", "comment", issue.id, "--body", `Sandcastle 停下了：落地（push / 开 PR / 合并）出错，本地分支 \`${issue.branch}\` 保留。\n\n\`\`\`\n${reason}\n\`\`\`\n\n处理后去掉 ${LABEL.stuck} 再运行。`]);
      }
    });
  })()
    .catch((e) => console.error(`  ✗ #${issue.id} 出错：${String(e).slice(0, 500)}`))
    .finally(() => {
      running.delete(issue.id);
      console.log(`  ⇢ #${issue.id} 让出空位（还有 ${running.size} 张在做）`);
      signalSlotFreed();
    });
}

/**
 * 本次运行里 prep 过、但没打上 prepped 也没拆的票，记下 prep 结束时 issue 的 updatedAt。
 * 轮询比原来按轮跑频繁得多，issue 没变就不再开 prep 会话；有人评论、改正文或改标签后再试。
 */
const prepTried = new Map<number, string>();

type ScheduleResult = { started: number; split: boolean; prepLimitedUntil?: number };

/** 一次调度：整理 → prep → plan，把空位补满。在 withHost 里跑。 */
async function schedule(): Promise<ScheduleResult> {
  reloadModels(); // 每次调度读一次 .sandcastle/models.json：改了配置不用重启，下次生效
  await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]); // 刚合并进远端 main 的代码
  openStates.clear();
  syncHostBase();
  reopenRequestedRevisions();
  closeFinishedParents();
  await cleanupClosedIssues();
  pruneSeaweedMetalog();

  // Prep —— 串行，因为拆票会改别的票的 Blocked by。
  // 每次重新查询，所以上次拆出来的子票（继承了 Sandcastle 标签）这里会被看到。
  // 有 open blocker 的票脚本直接跳过，不开会话（prep agent 遇到这种票也只会什么都不改就结束）；
  // 跳过的票仍留在 toPrep 里，下面判断「这次拆出了新子票」时不会把它当成新票。
  // 撞上用量限额不在这里等（会占着宿主机锁，做完的票落不了地）：停止这次 prep，交给主循环决定等多久。
  // 按编号从小到大：和 plan 的顺序一致，早建的票（通常是后面票的 blocker）先 prep、先开工。
  const toPrep = listIssues([LABEL.picked], [LABEL.prepped, LABEL.prOpen, LABEL.stuck])
    .filter((issue) => allowed(issue.number))
    .sort((a, b) => a.number - b.number);
  let prepLimitedUntil: number | undefined;
  for (const issue of toPrep) {
    const open = openBlockers(issue.body);
    if (open.length > 0) {
      console.log(`  跳过 prep #${issue.number}：blocker ${open.map((n) => `#${n}`).join("、")} 还没关`);
      continue;
    }
    if (prepTried.get(issue.number) === issue.updatedAt) continue;
    console.log(`Prep #${issue.number}: ${issue.title}`);
    try {
      await runAgent("prep", String(issue.number), `prep-${issue.number}`, {}, [], (agent) => sandcastle.run({
        sandbox: podman(),
        name: `prep-${issue.number}`,
        maxIterations: 1,
        agent,
        promptFile: "./.sandcastle/prep-prompt.md",
        promptArgs: {
          TASK_ID: issue.number, LABEL_PICKED: LABEL.picked, LABEL_PREPPED: LABEL.prepped, LABEL_STUCK: LABEL.stuck,
          REPREP_MARK,
        },
      }));
    } catch (e) {
      const limit = limitWait(e);
      if (limit) {
        console.log(`  ⏸ prep #${issue.number} 撞上用量限额，${limit.why}${new Date(limit.until).toLocaleString()} 前不再 prep`);
        prepLimitedUntil = limit.until;
        break;
      }
      console.error(`  ✗ prep #${issue.number} 出错：${String(e).slice(0, 500)}`);
    }
    const after = trySh("gh", ["issue", "view", String(issue.number), "--json", "updatedAt", "--jq", ".updatedAt"]);
    if (after.ok) prepTried.set(issue.number, after.out);
  }

  // Plan
  const issues = plan(new Set(running.keys()), MAX_PARALLEL - running.size);
  if (issues.length === 0) {
    // 这次 prep 拆出的子票还没 prep 过（下次才看到），这时不能当作没活可做。
    // 只认这次新出现的票：留在 toPrep 里的票（如等 blocker）下次仍不会有新票。
    const prepped = new Set(toPrep.map((issue) => issue.number));
    const split = listIssues([LABEL.picked], [LABEL.prepped, LABEL.prOpen, LABEL.stuck])
      .filter((issue) => allowed(issue.number) && !prepped.has(issue.number));
    if (split.length > 0) console.log(`拆出了子票 ${split.map((issue) => `#${issue.number}`).join("、")}，马上 prep。`);
    return { started: 0, split: split.length > 0 && prepLimitedUntil === undefined, prepLimitedUntil };
  }
  for (const issue of issues) {
    console.log(`  开工 #${issue.id}: ${issue.title} → ${issue.branch}`);
    start(issue);
  }
  return { started: issues.length, split: false, prepLimitedUntil };
}

// 有空位就调度一次；然后等「有票做完」或「过了 POLL_INTERVAL_MS」，先到哪个算哪个。
// 等人审的 PR 合入、blocker 关闭、人去掉 stuck 之后，下一次轮询就能开工，不用等正在做的票做完。
// 没有票在做、也开不出新票时算一次空转；连续 MAX_ITERATIONS 次空转就结束运行。
let idlePolls = 0;
for (let pass = 1; ; pass++) {
  if (running.size < MAX_PARALLEL) {
    console.log(`\n=== 调度 ${pass}（${new Date().toLocaleString()}，${running.size}/${MAX_PARALLEL} 个空位已占）===\n`);
    const r = await withHost(schedule);
    if (r.split) continue;
    if (running.size > 0 || r.started > 0) {
      idlePolls = 0;
    } else if (r.prepLimitedUntil !== undefined) {
      // 没票在做、prep 在等限额：等到重置再来，不算空转。
      console.log(`没有票在做，等 prep 的用量限额到 ${new Date(r.prepLimitedUntil).toLocaleString()} 重置`);
      await sleepUntil(r.prepLimitedUntil);
      continue;
    } else {
      idlePolls++;
      if (idlePolls >= MAX_ITERATIONS) {
        console.log(`没有可以开工的票（都在等 blocker、等人审 PR，或需要人处理），连续空转 ${idlePolls} 次，结束运行。`);
        break;
      }
      console.log(`没有可以开工的票（都在等 blocker、等人审 PR，或需要人处理），${POLL_INTERVAL_MS / 60_000} 分钟后再查（空转 ${idlePolls}/${MAX_ITERATIONS}）。`);
    }
  }
  await waitForSlotOrPoll(POLL_INTERVAL_MS);
}

// 最后合并的票在上次 fetch 之后才进远端，收尾再同步一次。
await gitRemoteOrThrow(["fetch", REMOTE, BASE_BRANCH]);
syncHostBase();
console.log(`\nAll done. 本地 main 已快进到 ${BASE_REF}（不在 main 上时除外，见上面的警告）；带 ${LABEL.prOpen} 的票在 GitHub 上等你审。`);
