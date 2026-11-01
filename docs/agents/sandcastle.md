# Sandcastle：无人值守地实现 issue

`npm run run:sandcastle` 跑 `.sandcastle/main.ts`：每一轮 prep → plan → implement + review → 门槛 → 合并。能合并的直接 rebase 合并进 `main`；不能合并的留 PR 给人审。

## 标签状态机

人只需要做两件事：给要做的票打 `Sandcastle`，以及处理带 `sandcastle:pr-open` / `sandcastle:stuck` 的票。其余标签由脚本和 agent 维护。

| 状态 | 标签 | 谁设置 | 下一步 |
|---|---|---|---|
| 选中 | `Sandcastle` + `ready-for-agent` | 人 | 下一轮 prep |
| 已准备 | + `sandcastle:prepped` | prep agent（指引新鲜、≤3 条验收标准、blocker 都已关闭） | plan 选中后实现 |
| 已拆分 | 父票去掉 `Sandcastle`；子票带 `Sandcastle` + `ready-for-agent` | prep agent | 子票下一轮各自 prep |
| 已合并 | issue 关闭（PR 正文 `Closes #n`） | 脚本 | 依赖它的票下一轮开工 |
| 等人审 | + `sandcastle:pr-open` | 脚本（没能自动合并时） | 人审 PR；合并后 issue 自动关闭 |
| 需要人 | + `sandcastle:stuck`（评论里写原因） | 脚本或 agent | 人处理后去掉 `sandcastle:stuck` |

## 什么时候自动合并

全部满足才合并（`gh pr merge --rebase`），否则留 PR 并在 PR 上评论原因：

1. reviewer 给出 `<verdict>merge</verdict>`：验收标准都实现且有测试、没有要人判断的问题、没改页面（改了页面留 PR 附截图，见「浏览器验收」）、没动 ADR / 权限 / 敏感字段处理、没改弱已有测试（规则在 `.sandcastle/review-prompt.md`）。
2. 门槛通过：脚本在沙箱里自己跑 `npm run typecheck` 与完整测试。失败时让 implementer 用新会话修一次，再跑一次。
3. GitHub 能 rebase 合并，且本票的 drizzle 迁移接在 `origin/main` 最新的迁移后面（两张票各加一个迁移时没有文本冲突，但迁移链会分叉，所以合并前脚本先查）。

   不满足时脚本自动补救一次：在原分支上开沙箱 `git rebase origin/main`；有冲突或迁移链分叉就开一次 agent 会话按 `.sandcastle/rebase-prompt.md` 处理（追加型文件两边都留，迁移删掉重新 `db:generate`，要做判断的放弃并在 issue 上评论）；然后**重跑完整门槛**，通过才 force-push 再合并。补救不成就留 PR 并写原因。代价是这张票多跑一遍完整测试。

GitHub CI 不作为门槛。

## 其他规则

- 有 open blocker 的票不会被 prep，也不会被 plan 选中。blocker 留成 PR 时，依赖它的票要等你合并之后的下一次运行。
- 拆出来的子票会在**下一轮**被看到（每轮开头重新查询 issue）。
- 每轮开头 `git fetch origin main`，新分支从 `origin/main` 建，不动宿主机本地 `main` 的工作区；跑完后本地 `main` 要自己 `git pull`。
- 要修改留下的 PR：在 PR 上留 review 意见，去掉 issue 的 `sandcastle:pr-open`，再运行。implementer 会接着同一个分支 `sandcastle/issue-<n>` 做，并先读 PR 评论。
- 已经有指引、但写于 blocker 合并之前的票，prep 会按 `docs/agents/ticket-sizing.md` 重写指引。

## 上下文预算

- implementer 的每次迭代都是全新的 Claude 会话；`IMPLEMENT_MAX_ITERATIONS = 3`，超过就打 `sandcastle:stuck`，通常说明票太大。
- 每个会话设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000`。真正保证预算的是 prep 把票切小（`docs/agents/ticket-sizing.md`）。
- implementer 不跑完整测试（省掉 14 分钟的输出与等待），完整测试由门槛跑。
- PR 正文的 **Budget** 一节记录上下文峰值，超过 150k 时会标出来。

## 运行前提

- `.sandcastle/`、`.claude/skills/prep-ticket/`、`CLAUDE.md`、`docs/` 要**先提交并 push**：沙箱从 `origin/main` 建 worktree，看不到未提交的改动。
- 测试依赖的服务在宿主机的 apple container 里（PG、MySQL、MongoDB、SeaweedFS），端口发布在宿主机上，podman 容器经 `host.containers.internal` 访问。脚本读宿主机的 `.env`（`S3_*`）与 `.env.test`（`TEST_*`），把 `localhost` / `127.0.0.1` 换成 `host.containers.internal` 后传进沙箱。
- 每张票的库名与前缀加 `_i<n>`（`crm_platform_test_i<n>`、`crm_source_test_i<n>`、MySQL / MongoDB 库、`TEST_S3_LAKE_URI`），并行的沙箱互不清表；`CRM_TEST_WORKERS=4`，`MAX_PARALLEL × 4` 个 worker 的连接数要在 PG `max_connections` 以内。
- `GH_TOKEN` 需要 Issues 读写与 Pull requests 只读；push、开 PR、合并在宿主机上用你自己的 git / gh 凭据完成。宿主机的 `gh` 要 2.99+（`--attach` 上传截图）。
- 改了 `.sandcastle/Containerfile` 要重建镜像。podman 读 `~/.config/containers/registries.conf`（Podman Desktop 还会把它同步进虚拟机），这个文件不合法时构建会失败。

## 浏览器验收

改了页面的票，implementer 在沙箱里用 `playwright-cli`（无头 Chromium，镜像里装好，带中文字体）照票里的 **Browser check** 做验收，步骤在 `.sandcastle/implement-prompt.md`。和宿主机上的 ego-browser 流程（`test/README.md`「浏览器验收」）的区别：

- 不连开发库 `crm_platform`。每张票一个验收库 `crm_platform_browser_i<n>`，`scripts/browser-lab.ts` 在里面建空的 `crmlab-smoke` 租户和 `admin@` / `eng@` / `an@crmlab-smoke.test`。需要数据时 agent 在页面上自己建。
- dev server 在沙箱里起（5180），`MAILER=console`，Magic Link 从它的日志里取。
- `/ops` 要 TOTP，沙箱里验不了。

截图和 `RESULT.md`（每一步的结论）写在 worktree 的 `.browser-check/`，不提交。关沙箱前脚本把它拷到宿主机 `$TMPDIR/sandcastle-browser-check/issue-<n>/`，开 PR 时把 `RESULT.md` 写进正文的 **Browser check** 一节，截图用 `gh --attach` 附上。

改了页面的票**一律留 PR**（reviewer 给 `pr`）。你看截图和结论，没问题就合并。等确认这套验收靠得住，再考虑放宽成验收通过就自动合并。
