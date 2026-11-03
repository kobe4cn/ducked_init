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
| 等人审 | + `sandcastle:pr-open` | 脚本（没能自动合并时） | 人审 PR：没问题就合并（issue 自动关闭）；要改就在 PR 上发 `/sandcastle` 开头的评论或 review |
| 打回 | 去掉 `sandcastle:pr-open` | 脚本（每轮开头看到打回信号时） | 本轮重新 plan，implementer 在原分支上先处理 PR 意见 |
| 退回重新准备 | 去掉 `sandcastle:prepped`，issue 上留 `<!-- sandcastle:reprep -->` 评论 | 脚本（implementer 第一次用完会话没做完时） | 下一轮 prep 按进度：指引不对就重写；票太大就把没完成的验收标准拆成子票（被本票 block），本票只留已完成的部分，在原分支上收尾合并 |
| 需要人 | + `sandcastle:stuck`（评论里写原因） | 脚本（重新准备后仍没做完、沙箱出错）或 agent | 人处理后去掉 `sandcastle:stuck` |

## reviewer 打回（revise）

reviewer 的结论有三种：`merge`、`revise`、`pr`（规则在 `.sandcastle/review-prompt.md`）。

- `revise`：有要改行为、但正确做法明确的问题，比如漏了验收标准或测试、测试缺断言、重复已有 helper、术语不对。reviewer 在 `<revise>` 里逐条写位置、改法和验证方式。脚本把这些意见交给一个新的 implementer 会话，改完后再审一次。最多打回 `REVISE_MAX = 2` 次。
- 两次之后仍是 `revise`，就留 PR 给人审。PR 正文的 Review 一节会附上每次的意见。
- 要人判断的问题会决定怎么改时，reviewer 直接给 `pr`，不打回。

## 什么时候自动合并

全部满足才合并（`gh pr merge --rebase`），否则留 PR 并在 PR 上评论原因：

1. reviewer 给出 `<verdict>merge</verdict>`：验收标准都实现且有测试、没有要人判断的问题、没改页面（改了页面留 PR 附截图，见「浏览器验收」）、没动 ADR / 权限 / 敏感字段处理、没改弱已有测试（规则在 `.sandcastle/review-prompt.md`）。
2. 门槛通过：脚本在沙箱里自己跑 `npm run typecheck` 与完整测试（沙箱里 4 个 worker，约 40 分钟）。
   - 完整测试失败、且失败的文件不超过 3 个时，先把这几个文件单独重跑一次：重跑通过算通过，PR 的 **Gate** 一节标出「偶发失败」和第一次的失败摘要。脚本还会给每个偶发失败的文件开一张票，标题是 `偶发失败：<文件>`，带 `flaky`、`Sandcastle`、`ready-for-agent` 标签，正文附失败摘要、复现方法和验收标准；下一轮会自动 prep 并修。已经有同名的 open 票时，就在那张票上追加一次出现记录。票号会评论到 PR 上。重跑仍失败、或失败文件更多，才算门槛失败。
   - 门槛失败时让 implementer 用新会话修一次，再跑一次门槛。
   - 失败摘要只取 vitest 的 Failed Tests / Failed Suites 一节。
3. GitHub 能 rebase 合并，且本票的 drizzle 迁移接在 `origin/main` 最新的迁移后面（两张票各加一个迁移时没有文本冲突，但迁移链会分叉，所以合并前脚本先查）。

   不满足时脚本自动补救一次：在原分支上开沙箱 `git rebase origin/main`；有冲突或迁移链分叉就开一次 agent 会话按 `.sandcastle/rebase-prompt.md` 处理（追加型文件两边都留，迁移删掉重新 `db:generate`，要做判断的放弃并在 issue 上评论）；然后**重跑完整门槛**，通过才 force-push 再合并。补救不成就留 PR 并写原因。代价是这张票多跑一遍完整测试。

   reviewer 不给 `merge`、但门槛通过、要留 PR 给人审的票，也先查一次：和最新的 `origin/main` 有文本冲突或迁移链分叉（开工后 main 上合进了改同一处的票）时，同样 rebase、处理冲突、重跑门槛、force-push，只是不合并，PR 上评论一句。这样人审到的 PR 能直接合并。补救不成就在「没有自动合并」的评论里写上原因。

GitHub CI 不作为门槛。

## 其他规则

- 只跑指定的票：`SANDCASTLE_ONLY=328,329 npm run run:sandcastle`（prep 与 plan 都只看名单里的票；拆出来的子票不在名单里，要另外加）。
- plan 由脚本自己算，不用 agent：在已准备的票里排除 `## Blocked by` 里还有 open 票的，剩下的按编号从小到大选，和已选的票改同一个文件（指引里 `- **Change**: \`path\`` 行的路径）就跳过，所以冲突时总是编号小的先做，最多 `MAX_PARALLEL`（3）张。被 blocker 挡住的票不占文件。等人审（`sandcastle:pr-open`）的票也占着它的文件：PR 合入或关闭之前，改同一个文件的票不会开工，免得两个 PR 在同一个文件上冲突；代价是 PR 一直不审，这些票就一直排不上。跳过原因会打在日志里。
- 有 open blocker 的票不会被 prep，也不会被 plan 选中。blocker 留成 PR 时，依赖它的票要等你合并之后的下一次运行。
- 拆出来的子票会在**下一轮**被看到（每轮开头重新查询 issue）。某一轮 plan 选不出票时，如果这一轮拆出了还没 prep 的子票，就进入下一轮；没有才结束运行。
- 撞上 Claude 用量限额（`You've hit your … limit · resets 6:20am (UTC)`）不算票失败，不打 `sandcastle:stuck`：脚本从报错里解析重置时间，等到那之后再多等 2 分钟，然后重跑撞上的那一步。prep 原样重跑；实现中的票先把已有提交推到远端，再在原分支上从 implement 重跑，implementer 看到已有提交会直接收尾，review 与门槛从头跑；rebase 补救同样重跑。认不出重置时间就每 30 分钟试一次。进程被中断（Ctrl-C、关机）时，已有提交在本地同名分支上，重跑 `npm run run:sandcastle` 会接着做。
- 每轮开头 `git fetch origin main`，新分支从 `origin/main` 建。prep 与 plan 不建分支，沙箱挂的是宿主机工作区（本地 HEAD），所以 fetch 后宿主机在 `main` 上时把本地 `main` 快进到 `origin/main`（`git merge --ff-only`），prep 的 Explore 才看得到已合并的代码；不在 `main` 上、本地领先或分叉、或快进会覆盖未提交的改动时只打警告、不动工作区，这时 prep 读到的是旧代码。运行时宿主机留在 `main` 上，不要在本地 `main` 上做未推送的提交。
- 运行中途可以手动合并或关掉正在做的票：落地前脚本会查 issue，已关闭就跳过（不 push、不开 PR、不打标签），本地分支留着。某张票落地时出错（网络、分支被删等）只影响这张：打 `sandcastle:stuck` 并在票上评论报错，本地分支保留，其余的票照常落地，运行继续。
- 要修改留下的 PR：在 PR 上留意见（普通评论、review 正文、行内意见都行），再发一条**以 `/sandcastle` 开头**的评论或 review（意见可以直接写在它后面），然后运行。每轮开头，脚本看到晚于分支最新提交的 `/sandcastle`，或别人点的 Request changes，就去掉 `sandcastle:pr-open`，把票放回 plan。PR 是用你的 gh 凭据开的，GitHub 不让作者对自己的 PR 点 Request changes，所以要用 `/sandcastle`。implementer 接着同一个分支 `sandcastle/issue-<n>` 做，并先读 PR 评论和行内意见。reviewer 会逐条确认这些意见都处理了，才给 `merge`。手动去掉 `sandcastle:pr-open` 的老办法也还能用。
- 已经有指引、但写于 blocker 合并之前的票，prep 会按 `docs/agents/ticket-sizing.md` 重写指引。

## 外部 PR：让 Sandcastle 接手别人开的 PR

其他 agent 或人开的 PR，满足下面几条，就能像 Sandcastle 自己的 PR 一样用 `/sandcastle` 打回：

- PR 正文写 `Closes #<n>`，关联一张 issue。分支在本仓库，不能来自 fork，因为 Sandcastle 要往这个分支推提交。
- 这张 issue 带 `Sandcastle`、`ready-for-agent`、`sandcastle:prepped`、`sandcastle:pr-open`，表示 PR 已开、等人审，不再 prep。正文按 `ticket-sizing.md` 写：验收标准最多 3 条，而且 agent 能自己验证；有 `## Implementation guide`，要改的文件各写一行 `- **Change**:`。
- 打回的写法和上面一样：发一条以 `/sandcastle` 开头的评论或 review，时间要晚于分支的最新提交。

脚本按 issue 关联的 open PR 找分支，同一张票同时有 `sandcastle/issue-<n>` 时优先用它；关联了多个外部 PR 时跳过这张票。对外部 PR，脚本会：

- 把远端分支同步到本地，在对方的提交上接着改。
- review 和完整测试照常跑。
- 只做普通 push，不 force、不 rebase、不删分支。
- 不自动合并：在 PR 上评论 review 结论和测试结果，重新打上 `sandcastle:pr-open`，由人合并。

Sandcastle 处理期间，PR 作者不要往这个分支推提交。本地和远端分叉时，这张票会失败并打 `sandcastle:stuck`。如果 3 次会话内没改完，脚本会推上已有的提交并打 `sandcastle:stuck`，不退回 prep。

## 上下文预算

- implementer 的每次迭代都是全新的 Claude 会话；`IMPLEMENT_MAX_ITERATIONS = 3`。第一次超过时退回 prep 重新准备（见标签状态机），分支先推到远端，已有提交列在评论里；重新准备后再超过才打 `sandcastle:stuck`。
- 判断「做没做」看分支上领先 `origin/main` 的提交，不看这次会话有没有新提交：重新准备后父票只剩已完成的部分，收尾时可能不再提交。
- 编码规范：reviewer 按 `.sandcastle/CODING_STANDARDS.md` 和根目录的 `CODING_STANDARDS.md` 审，implementer 提交前按这两份自查。review 里反复出现的问题补进 `.sandcastle/CODING_STANDARDS.md`。
- 每个会话设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000`。真正保证预算的是 prep 把票切小（`docs/agents/ticket-sizing.md`）。
- implementer 不跑完整测试（沙箱里约 40 分钟），完整测试由门槛跑。
- PR 正文的 **Budget** 一节记录上下文峰值，超过 150k 时会标出来。

## 运行前提

- `.sandcastle/`、`.claude/skills/prep-ticket/`、`CLAUDE.md`、`docs/` 要**先提交并 push**：沙箱从 `origin/main` 建 worktree，看不到未提交的改动。
- 测试依赖的服务在宿主机的 apple container 里（PG、MySQL、MongoDB、SeaweedFS），端口发布在宿主机上，podman 容器经 `host.containers.internal` 访问。脚本读宿主机的 `.env`（`S3_*`）与 `.env.test`（`TEST_*`），把 `localhost` / `127.0.0.1` 换成 `host.containers.internal` 后传进沙箱。
- 测试库连接、上下文预算等环境变量在建沙箱时经 `podman({env})` 注入（`sandboxFor`）。`createSandbox` 里的 `sandbox.run` 不使用 `agent(env)` 的 env，放在那里进不了 agent 的 shell。
- 沙箱建好后用 `package.json` 的 `packageManager`（pnpm）按锁文件重装依赖：拷进来的 `node_modules` 是宿主机 darwin 的，缺 linux 原生包。
- 每张票的库名与前缀加 `_i<n>`（`crm_platform_test_i<n>`、`crm_source_test_i<n>`、MySQL / MongoDB 库、`TEST_S3_LAKE_URI`），并行的沙箱互不清表；`CRM_TEST_WORKERS=4`，`MAX_PARALLEL × 4` 个 worker 的连接数要在 PG `max_connections` 以内（`MAX_PARALLEL=3` 要 450，见 `db_script/docker-compose.yml`）。
- 这些资源在每次关沙箱后（`build`、`rebaseAndMerge` 的收尾）由 `scripts/drop-test-resources.ts _i<n>` 在宿主机上回收：PG 的测试库、验收库及其中租户的 catalog 角色 `lake_<id>`（集群级，删库带不走，没有别的库再依赖时才删），MySQL / MongoDB 库（Mongo 连库里的用户与角色），`TEST_S3_LAKE_URI_i<n>*` 下的对象和策略只授权这些前缀的对象存储账号。不等票合并：再跑这张票时 global-setup 与夹具会重新建库。回收失败只打日志、不影响票；留下的用 `pnpm sandcastle:cleanup _i<n>` 补收（pnpm 会把 `--` 原样传给脚本，不要加），没有 Sandcastle 在跑时可用 `--all` 收全部 `_i<数字>`。
- 门槛里大量用例在 `s3-accounts.ts` 的 IAM 调用上 `TimeoutError`、资源回收也超时时，先看对象存储：`curl -s localhost:9333/dir/status` 的 `Free` 为 0、`container logs seaweedfs` 里有 `No writable volumes and no free volumes left`，就是卷数到了上限。filer 的元数据日志（`/topics/.system/log`，每天一个目录）会一直占新卷，测试越跑越多。本机的 seaweedfs 以 `-volume.max=1000 -master.volumeSizeLimitMB=1024` 启动（2026-11-03 从自动算出的 505 调上来），数据在命名卷 `seaweedfs-data`，重建容器不丢数据。元数据日志由 `scripts/prune-seaweed-metalog.sh [保留天数，默认 2]`（`pnpm sandcastle:prune-metalog`）清理：删早于保留天数的日期目录，再删默认 collection 里已写满且文件全部已删的整卷（立即收回卷位和磁盘）；Sandcastle 每轮开头会自动跑一次。`fs.configure` 给这个路径设 TTL 不生效（filer 写自己的日志不走路径规则）。
- `GH_TOKEN` 需要 Issues 读写与 Pull requests 只读；push、开 PR、合并在宿主机上用你自己的 git / gh 凭据完成。宿主机的 `gh` 要 2.99+（`--attach` 上传截图）。
- 改了 `.sandcastle/Containerfile` 要重建镜像。podman 读 `~/.config/containers/registries.conf`（Podman Desktop 还会把它同步进虚拟机），这个文件不合法时构建会失败。

## 浏览器验收

改了页面的票，implementer 在沙箱里用 `playwright-cli`（无头 Chromium，镜像里装好，带中文字体）照票里的 **Browser check** 做验收，步骤在 `.sandcastle/implement-prompt.md`。和宿主机上的 ego-browser 流程（`test/README.md`「浏览器验收」）的区别：

- 不连开发库 `crm_platform`。每张票一个验收库 `crm_platform_browser_i<n>`，`scripts/browser-lab.ts` 在里面建空的 `crmlab-smoke` 租户和 `admin@` / `eng@` / `an@crmlab-smoke.test`。需要数据时 agent 在页面上自己建。
- dev server 在沙箱里起（5180），`MAILER=console`，Magic Link 从它的日志里取。
- `/ops` 要 TOTP，沙箱里验不了。

截图和 `RESULT.md`（每一步的结论）写在 worktree 的 `.browser-check/`，不提交。关沙箱前脚本把它拷到宿主机 `$TMPDIR/sandcastle-browser-check/issue-<n>/`，开 PR 时把 `RESULT.md` 写进正文的 **Browser check** 一节，截图用 `gh --attach` 附上。

改了页面的票**一律留 PR**（reviewer 给 `pr`）。你看截图和结论，没问题就合并。等确认这套验收靠得住，再考虑放宽成验收通过就自动合并。
