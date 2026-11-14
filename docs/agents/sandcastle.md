# Sandcastle：无人值守地实现 issue

`npm run run:sandcastle` 跑 `.sandcastle/main.ts`：每张票 prep → plan → implement + review → 门槛 → 合并。能合并的直接 rebase 合并进 `main`；不能合并的留 PR 给人审。

脚本不分轮，按空位调度：最多 `MAX_PARALLEL`（2）张票同时在做，一张票从开工到落地完一直占着一个空位。有空位时做一次调度（整理 → prep → plan），把空位补满；每张票独立跑完 build 和落地，做完马上让出空位，再调度一次，不等同批的另一张。有空位但开不了工时，每 `POLL_INTERVAL_MS`（10 分钟）重新调度一次，所以人合并了 PR、blocker 关了、去掉了 stuck，最晚 10 分钟后就能开工，不用等正在做的票做完。没有票在做、也开不出新票算一次空转，连续 `MAX_ITERATIONS`（12）次空转（约 2 小时）就结束运行。调度和落地都在宿主机上动 git 与标签，两者串行；build 在沙箱里并行。

## 标签状态机

人只需要做两件事：给要做的票打 `Sandcastle`，以及处理带 `sandcastle:pr-open` / `sandcastle:stuck` 的票。带 `sandcastle:decided` 的票不阻塞运行，有空时事后确认即可。其余标签由脚本和 agent 维护。

| 状态 | 标签 | 谁设置 | 下一步 |
|---|---|---|---|
| 选中 | `Sandcastle` + `ready-for-agent` | 人 | 下次调度 prep |
| 已准备 | + `sandcastle:prepped` | prep agent（指引新鲜、≤3 条验收标准、blocker 都已关闭） | plan 选中后实现 |
| 已拆分 | 父票去掉 `Sandcastle`；子票带 `Sandcastle` + `ready-for-agent` | prep agent | 子票马上各自 prep；子票全关后，脚本在下次调度开头勾上 `## Split into` 清单并关掉父票（子票只认列表项开头的票号） |
| 已合并 | issue 关闭（PR 正文 `Closes #n`） | 脚本 | 依赖它的票下次调度开工 |
| 等人审 | + `sandcastle:pr-open` | 脚本（没能自动合并时） | 人审 PR：没问题就合并（issue 自动关闭）；要改就在 PR 上发 `/sandcastle` 开头的评论或 review |
| 打回 | 去掉 `sandcastle:pr-open` | 脚本（每次调度开头看到打回信号时） | 这次调度重新 plan，implementer 在原分支上先处理 PR 意见 |
| 退回重新准备 | 去掉 `sandcastle:prepped`，issue 上留 `<!-- sandcastle:reprep -->` 评论 | 脚本（implementer 第一次用完会话没做完时） | 下次调度 prep 按进度：指引不对就重写；票太大就把没完成的验收标准拆成子票（被本票 block），本票只留已完成的部分，在原分支上收尾合并 |
| 需要人 | + `sandcastle:stuck`（评论里写原因） | 脚本（重新准备后仍没做完、沙箱出错、implementer 输出 `NEEDS_DECISION`）或 agent | 人处理后去掉 `sandcastle:stuck` |
| 代拍板 | + `sandcastle:decided`（票仍照常合并或留 PR） | 脚本（落地时 issue 上有 `<!-- sandcastle:decided -->` 开头的评论） | 人看 PR 上的「代拍板」评论：同意就去掉标签；不同意在 issue 上回复，另开票改 |

## 设计决定：代拍板还是停下

prep、implementer、reviewer 遇到票和指引都没写到的设计决定时，按 `.sandcastle/DECISIONS.md` 分两类处理：

- **必须停下**：要改 ADR 的方向、改公共接口语义或数据库 schema、涉及权限和敏感字段、删改用户数据、选项都难以撤回或给不出推荐。prep 打 `sandcastle:stuck` + `ready-for-human`；implementer 提交已完成的部分、评论选项后输出 `<promise>NEEDS_DECISION</promise>`，脚本推上分支、直接打 stuck，不再开新会话，也不退回 prep。
- **可以代拍板**：收窄范围（没做到的部分记进 `KNOWN_GAPS`、另开后续票）或可以撤回的局部取舍。agent 按推荐做，在 issue 上留 `<!-- sandcastle:decided -->` 开头的评论，写清选项和理由，照常做完。落地时脚本给票打 `sandcastle:decided`，把这些评论贴到 PR 上。reviewer 会核对代拍板属于这一类，不属于的写进「需要人判断」，留 PR。

找所有待确认的代拍板：`gh issue list --state all --label sandcastle:decided`。

## reviewer 打回（revise）

reviewer 的结论有三种：`merge`、`revise`、`pr`（规则在 `.sandcastle/review-prompt.md`）。

- `revise`：有要改行为、但正确做法明确的问题，比如漏了验收标准或测试、测试缺断言、重复已有 helper、术语不对。reviewer 在 `<revise>` 里逐条写位置、改法和验证方式。脚本把这些意见交给一个新的 implementer 会话，改完后再审一次。最多打回 `REVISE_MAX = 2` 次。
- 两次之后仍是 `revise`，就留 PR 给人审。PR 正文的 Review 一节会附上每次的意见。
- 要人判断的问题会决定怎么改时，reviewer 直接给 `pr`，不打回。
- review 只验本票：验收标准涉及别的 issue 时（开新票、给别的票加评论或标签），只核对本票确实做过这件事，不拿那张票当前的标签和状态去比对指引——对不上视为人后来改过。review / revise / fix / implement 会话不改本票和本次会话里自己新开的 issue 以外任何 issue 的标签或正文（评论除外）；本次会话之前开出的票也不能改。

## 什么时候自动合并

全部满足才合并（`gh pr merge --rebase`），否则留 PR 并在 PR 上评论原因：

1. reviewer 给出 `<verdict>merge</verdict>`：验收标准都实现且有测试、没有要人判断的问题、没改页面（改了页面留 PR 附截图，见「浏览器验收」）、没动 ADR / 权限 / 敏感字段处理、没改弱已有测试（规则在 `.sandcastle/review-prompt.md`）。
2. 门槛通过：脚本在沙箱里自己跑 `npm run typecheck` 与完整测试（沙箱里 4 个 worker，约 40 分钟）。
   - 完整测试失败、且失败的文件不超过 3 个时，先把这几个文件单独重跑一次：重跑通过算通过，PR 的 **Gate** 一节标出「偶发失败」和第一次的失败摘要。脚本还会给每个偶发失败的文件开一张票，标题是 `偶发失败：<文件>`，带 `flaky`、`Sandcastle`、`ready-for-agent` 标签，正文附失败摘要、复现方法和验收标准；下次调度会自动 prep 并修：prep 先查同样的报错是否已被别的提交修掉，修掉了就只核实、不改代码；没修掉要给出修复前变红、修复后变绿的复现（跨沙箱竞争写并发用例），重复单跑总共不超过 20 分钟。已经有同名的 open 票时，就在那张票上追加一次出现记录。票号会评论到 PR 上。重跑仍失败、或失败文件更多，才算门槛失败。
   - 门槛失败时让 implementer 用新会话修一次，再跑一次门槛。
   - 失败摘要只取 vitest 的 Failed Tests / Failed Suites 一节。
3. GitHub 能 rebase 合并，且本票的 drizzle 迁移接在 `origin/main` 最新的迁移后面（两张票各加一个迁移时没有文本冲突，但迁移链会分叉，所以合并前脚本先查）。

   不满足时脚本自动补救一次：在原分支上开沙箱 `git rebase origin/main`；有冲突或迁移链分叉就开一次 agent 会话按 `.sandcastle/rebase-prompt.md` 处理（追加型文件两边都留，迁移删掉重新 `db:generate`，要做判断的放弃并在 issue 上评论）；然后**重跑完整门槛**，通过才 force-push 再合并。补救不成就留 PR 并写原因。代价是这张票多跑一遍完整测试。

   reviewer 不给 `merge`、但门槛通过、要留 PR 给人审的票，也先查一次：和最新的 `origin/main` 有文本冲突或迁移链分叉（开工后 main 上合进了改同一处的票）时，同样 rebase、处理冲突、重跑门槛、force-push，只是不合并，PR 上评论一句。这样人审到的 PR 能直接合并。补救不成就在「没有自动合并」的评论里写上原因。

4. 验收说明齐全：implementer 写了 `.pr-notes/验收说明.md` 且格式对（三个小标题、「怎么验证」有编号步骤，检查在 `.sandcastle/pr-body.ts` 的 `checkAcceptanceNotes`）。缺失或格式不对时正文写警告、留 PR（见「验收说明」）。

GitHub CI 不作为门槛。

## 其他规则

- 只跑指定的票：`SANDCASTLE_ONLY=328,329 npm run run:sandcastle`（prep 与 plan 都只看名单里的票；拆出来的子票不在名单里，要另外加）。
- plan 由脚本自己算，不用 agent：在已准备的票里排除 `## Blocked by` 里还有 open 票的（括号里的票号是说明，不算），剩下的按编号从小到大选，和已选的票改同一个文件（指引里 `- **Change**: \`path\`` 行的路径，以及 `**Change**` 下缩进子条目开头的路径；一条 Change 都没有时兜底取指引里 New / Reuse / ADRs / Tests 之外的 `path:行号` 引用，并在日志里警告；解析在 `.sandcastle/guide.ts`）就跳过，所以冲突时总是编号小的先做，最多 `MAX_PARALLEL`（2）张。被 blocker 挡住的票不占文件。等人审（`sandcastle:pr-open`）的票也占着它的文件：PR 合入或关闭之前，改同一个文件的票不会开工，免得两个 PR 在同一个文件上冲突；代价是 PR 一直不审，这些票就一直排不上。跳过原因会打在日志里。
- prep 和 plan 都按票号从小到大处理：prep 一张接一张串行跑完，plan 才开始选票。
- 有 open blocker 的票不会被 prep（脚本直接跳过，不开 prep 会话，日志打「跳过 prep #n」），也不会被 plan 选中。blocker 留成 PR 时，依赖它的票在你合并之后的下一次轮询开工（运行已结束时要重新运行）。
- 每次调度开头重新查询 issue，拆出来的子票在下次调度被看到。plan 选不出票、但这次拆出了还没 prep 的子票时，马上再调度一次，不算空转。
- 轮询比原来按轮跑频繁，所以本次运行里 prep 过、却既没打上 prepped 也没拆的票（比如 prep 会话出错），只有 issue 有了变化（评论、正文、标签）才再开 prep 会话。
- 撞上 Claude 用量限额（`You've hit your … limit · resets 6:20am (UTC)`）不算票失败，不打 `sandcastle:stuck`：脚本从报错里解析重置时间，等到那之后再多等 2 分钟，然后重跑撞上的那一步。prep 不在调度里等（会占着宿主机，做完的票落不了地）：停下这次的 prep，下次调度再试；没有票在做时，主循环等到重置再调度，不算空转。实现中的票先把已有提交推到远端，再在原分支上从 implement 重跑，implementer 看到已有提交会直接收尾，review 与门槛从头跑；rebase 补救同样重跑。认不出重置时间就每 30 分钟试一次。进程被中断（Ctrl-C、关机）时，已有提交在本地同名分支上，重跑 `npm run run:sandcastle` 会接着做。
- 每次调度开头 `git fetch origin main`，新分支从 `origin/main` 建。prep 与 plan 不建分支，沙箱挂的是宿主机工作区（本地 HEAD），所以 fetch 后宿主机在 `main` 上时把本地 `main` 快进到 `origin/main`（`git merge --ff-only`），prep 的 Explore 才看得到已合并的代码；不在 `main` 上、本地领先或分叉、或快进会覆盖未提交的改动时只打警告、不动工作区，这时 prep 读到的是旧代码。运行时宿主机留在 `main` 上，不要在本地 `main` 上做未推送的提交。
- 运行中途可以手动合并或关掉正在做的票：落地前脚本会查 issue，已关闭就跳过（不 push、不开 PR、不打标签），本地分支先留着。每次调度开头清一次已关闭票的残留：去掉 `sandcastle:prepped` / `pr-open` / `stuck`（`decided`、`flaky` 不动）；票已关闭、且分支有已合并的 PR 时，删掉 `sandcastle/issue-<n>` 的远端分支、本地 worktree（有未提交改动就留着并警告）和本地分支。没合并就关掉的票，分支留着。连远端的 git（每次调度开头和落地时的 fetch、push）撞上 SSH、DNS 或网络错误（`Permission denied (publickey)`、`Could not resolve host` 等）时，等 30 秒到 15 分钟逐步加长，共重试 6 次（约半小时）；被拒（non-fast-forward、lease 过期）不重试。宿主机上的命令都有超时：连远端的 git 5 分钟，其余 10 分钟，超时算网络错误，照样重试。建沙箱或落地时撞上临时错误（复制 `node_modules` 到工作区超时、GitHub API 读超时、连接被重置等）也不直接打 stuck：分别等 1、5、15 分钟后整步重跑，3 次都不行才算失败。build 在原分支上重跑，落地重跑时已合并的票会跳过。某张票落地时出错（重试用完仍连不上、分支被删等）只影响这张：打 `sandcastle:stuck` 并在票上评论报错，本地分支保留，其余的票照常落地，运行继续。
- 要修改留下的 PR：在 PR 上留意见（普通评论、review 正文、行内意见都行），再发一条**以 `/sandcastle` 开头**的评论或 review（意见可以直接写在它后面），然后运行（Sandcastle 正在跑就不用重启）。每次调度开头，脚本看到晚于分支最新提交的 `/sandcastle`，或别人点的 Request changes，就去掉 `sandcastle:pr-open`，把票放回 plan。PR 是用你的 gh 凭据开的，GitHub 不让作者对自己的 PR 点 Request changes，所以要用 `/sandcastle`。implementer 接着同一个分支 `sandcastle/issue-<n>` 做，并先读 PR 评论和行内意见。reviewer 会逐条确认这些意见都处理了，才给 `merge`。手动去掉 `sandcastle:pr-open` 的老办法也还能用。
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
- 每个会话设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000`，用别家模型时也一样（见「模型配置」）。真正保证预算的是 prep 把票切小（`docs/agents/ticket-sizing.md`）。
- implementer 不跑完整测试（沙箱里约 40 分钟），完整测试由门槛跑。
- PR 正文的 **Budget** 一节记录上下文峰值，超过 150k 时会标出来。

## 模型配置

每个 agent 阶段（`prep`、`implement`、`review`、`revise`、`fix`、`rebase`）用哪个模型写在 `.sandcastle/models.json`，代码在 `.sandcastle/models.ts`。plan 和门槛是脚本自己做的，不用模型。

- `profiles` 是档案：`harness`（目前只支持 `claude-code`；`codex` 预留，写了会报错）、`model`（传给 `claude --model`）、可选的 `effort`、`env`、`limitPattern`、`resetTimeZone`。
- `env` 照抄厂商给 Claude Code 的配置（比如智谱 coding plan 的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_DEFAULT_*_MODEL`）。只对这次会话的 claude 进程生效，加在命令前面（`env K=V claude …`），因为 `createSandbox` 里的 `sandbox.run` 不用 agent provider 的 env。
- 密钥不写进 `models.json`：值写成 `"${GLM_API_KEY}"`，在容器里从同名环境变量取。变量要列在 `.sandcastle/.env` 里，sandcastle 只把那里列出的变量带进容器。
- 档案设了 `ANTHROPIC_BASE_URL` 就算别家：命令前 `env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY`，Claude 的凭据不会发到别家的接口。别家档案没设 `ANTHROPIC_DEFAULT_HAIKU_MODEL`（后台小任务和子 agent 用）或 `limitPattern` 时启动会警告。
- 上下文预算统一 150k：档案里的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 警告后忽略。
- `phases` 给每个阶段一个有序的档案列表，6 个阶段都要写。每次调度开头读一次：改了配置下次调度生效，不用重启。第一次就读不成（JSON 坏了、档案名不存在、阶段用到的档案引用的变量不在 `.sandcastle/.env` 里）直接退出；运行中途改坏了就警告并沿用上一份。
- 换档案以一次会话为单位：implement 的每次会话单独挑档案，档案名经环境变量 `SANDCASTLE_PROFILE` 给 implementer，进度评论第一行写明。不用 promptArgs：运行中的旧进程也会读到新提示词，多出的占位符会让它报错。撞上限额（Claude 档案认 `hit your … limit`，别家认 `limitPattern`）就记下这个档案的重置时间，重置前所有票都跳过它，用列表里的下一个；认不出重置时间就跳过 1 小时。重置时间认「resets 6:20am (UTC)」和「2026-11-07 15:30:00」两种，后一种按 `resetTimeZone` 解析。列表里的都在等时，分支推到远端，等最早恢复的那个，不打 stuck。其他报错照常走临时错误重试。
- 智谱 coding plan 撞限额的错误码是 1308（5 小时额度）和 1310（周 / 月额度），报错是「已达到…的使用上限。您的限额将在 … 重置」；1302 是并发过高，1113 多半是 Key 或 Base URL 配错，都不算限额。

用量：每次 run 结束把档案、模型、会话数和输入 / 缓存写 / 缓存读 / 输出的 token 数追加到 `.sandcastle/logs/usage.jsonl`（每条会话 JSONL 里 assistant 消息的 usage 按消息 id 去重后相加），PR 正文的 **Usage** 一节是这张票每次 run 一行的表。只记 token，不记费用：别家档案的费用是 Claude Code 按 Claude 单价算的，没有意义。

## 运行前提

- `.sandcastle/`、`.claude/skills/prep-ticket/`、`CLAUDE.md`、`docs/` 要**先提交并 push**：沙箱从 `origin/main` 建 worktree，看不到未提交的改动。
- 测试依赖的服务在宿主机的 apple container 里（PG、MySQL、MongoDB、SeaweedFS），端口发布在宿主机上，podman 容器经 `host.containers.internal` 访问。脚本读宿主机的 `.env`（`S3_*`）与 `.env.test`（`TEST_*`），把 `localhost` / `127.0.0.1` 换成 `host.containers.internal` 后传进沙箱。
- 测试库连接、上下文预算等环境变量在建沙箱时经 `podman({env})` 注入（`sandboxFor`）。`createSandbox` 里的 `sandbox.run` 不使用 `agent(env)` 的 env，放在那里进不了 agent 的 shell。
- 沙箱建好后用 `package.json` 的 `packageManager`（pnpm）按锁文件重装依赖：拷进来的 `node_modules` 是宿主机 darwin 的，缺 linux 原生包。
- 每张票的库名与前缀加 `_i<n>`（`crm_platform_test_i<n>`、`crm_source_test_i<n>`、MySQL / MongoDB 库、`TEST_S3_LAKE_URI`），源端测试账号也按票加运行后缀（`CRM_TEST_RUN_SUFFIX`，`crm_src_reader_i<n>_w<i>`，见 `scripts/test-resource-names.ts`），并行的沙箱互不清表、不共用集群级账号；`CRM_TEST_WORKERS=4`，`MAX_PARALLEL × 4` 个 worker 的连接数要在 PG `max_connections` 以内（`MAX_PARALLEL=2` 要 300，见 `db_script/docker-compose.yml`）。2026-11-07 试过 3：三个门槛同时跑完整测试，每个都有 8～10 个文件 60 / 90 秒超时，和改动无关，单跑能过；所以降回 2。沙箱里还设 `CRM_TEST_TIMEOUT_SCALE=2`，`vitest.config.ts` 把 testTimeout / hookTimeout 乘成 180 s / 120 s（沙箱负载比本地约慢一倍，#439；这类负载超时出过 #357 / #440 / #459 三张偶发失败票后统一放宽，#461），本地与 CI 仍是 90 s / 60 s。
- 这些资源在每次关沙箱后（`build`、`rebaseAndMerge` 的收尾）由 `scripts/drop-test-resources.ts _i<n>` 在宿主机上回收：PG 的测试库、验收库及其中租户的 catalog 角色 `lake_<id>`（集群级，删库带不走，没有别的库再依赖时才删），PG / MySQL 的源端测试账号 `crm_src_reader|writer_i<n>_w<i>`（集群级，同样没有依赖才删），MySQL / MongoDB 库（Mongo 连库里的用户与角色），`TEST_S3_LAKE_URI_i<n>*` 下的对象和策略只授权这些前缀的对象存储账号。不等票合并：再跑这张票时 global-setup 与夹具会重新建库。回收失败只打日志、不影响票；留下的用 `pnpm sandcastle:cleanup _i<n>` 补收（pnpm 会把 `--` 原样传给脚本，不要加），没有 Sandcastle 在跑时可用 `--all` 收全部 `_i<数字>`。
- 门槛里大量用例在 `s3-accounts.ts` 的 IAM 调用上 `TimeoutError`、资源回收也超时时，先看对象存储：`curl -s localhost:9333/dir/status` 的 `Free` 为 0、`container logs seaweedfs` 里有 `No writable volumes and no free volumes left`，就是卷数到了上限。filer 的元数据日志（`/topics/.system/log`，每天一个目录）会一直占新卷，测试越跑越多。本机的 seaweedfs 以 `-volume.max=1000 -master.volumeSizeLimitMB=1024` 启动（2026-11-03 从自动算出的 505 调上来），数据在命名卷 `seaweedfs-data`，重建容器不丢数据。元数据日志由 `scripts/prune-seaweed-metalog.sh [保留天数，默认 2]`（`pnpm sandcastle:prune-metalog`）清理：删早于保留天数的日期目录，再删默认 collection 里已写满且文件全部已删的整卷（立即收回卷位和磁盘）；Sandcastle 每次调度开头会自动跑一次。同一轮还会先清一遍 `/etc/iam/policies.json`：删掉账号已不在 `/etc/iam/identities/` 里的内联策略（`scripts/prune-seaweed-iam-policies.ts`，#621：每次 IAM 改动都整份重写这个文件，删掉的账号留下的孤儿条目会把它和元数据日志一起撑大——曾涨到 6 MB、元数据日志一天 65G）。`fs.configure` 给这个路径设 TTL 不生效（filer 写自己的日志不走路径规则）。
- `GH_TOKEN` 需要 Issues 读写与 Pull requests 只读；push、开 PR、合并在宿主机上用你自己的 git / gh 凭据完成。宿主机的 `gh` 要 2.99+（`--attach` 上传截图）。
- 改了 `.sandcastle/Containerfile` 要重建镜像。podman 读 `~/.config/containers/registries.conf`（Podman Desktop 还会把它同步进虚拟机），这个文件不合法时构建会失败。

## 浏览器验收

改了页面的票，implementer 在沙箱里用 `playwright-cli`（无头 Chromium，镜像里装好，带中文字体）照票里的 **Browser check** 做验收，步骤在 `.sandcastle/implement-prompt.md`。和宿主机上的 ego-browser 流程（`test/README.md`「浏览器验收」）的区别：

- 不连开发库 `crm_platform`。每张票一个验收库 `crm_platform_browser_i<n>`，`scripts/browser-lab.ts` 在里面建空的 `crmlab-smoke` 租户和 `admin@` / `eng@` / `an@crmlab-smoke.test`。需要数据时 agent 在页面上自己建。
- dev server 在沙箱里起（5180），`MAILER=console`，Magic Link 从它的日志里取。
- `/ops` 要 TOTP，沙箱里验不了。

截图和 `RESULT.md`（每一步的结论）写在 worktree 的 `.browser-check/`，不提交。关沙箱前脚本把它拷到宿主机 `$TMPDIR/sandcastle-browser-check/issue-<n>/`，开 PR 时把 `RESULT.md` 写进正文的 **Browser check** 一节，截图用 `gh --attach` 附上。

改了页面的票**一律留 PR**（reviewer 给 `pr`）。你看截图和结论，没问题就合并。等确认这套验收靠得住，再考虑放宽成验收通过就自动合并。

## 验收说明

每个 Sandcastle PR 的正文都以 `## 验收说明` 一节开头，写给验收 PR 的人：这个 PR 做了什么、在宿主机上怎么一步步验证、最终效果。来源是 implementer 写在 worktree `.pr-notes/验收说明.md`（不提交）的中文说明，格式要求在 `.sandcastle/implement-prompt.md`：`### 做了什么`、`### 怎么验证`（编号步骤，每条验收标准至少一步）、`### 最终效果` 三个小标题，不能出现 `## ` 二级标题（替换这一节时会切错）。

和 Browser check 的区别：Browser check 是 implementer **在沙箱里**做过的验证记录（临时验收库、playwright 截图），沙箱关掉就没法照着重做；验收说明是写给**人在宿主机上照做**的步骤（开发库 `crm_platform`、`npm run dev`）。脚本把固定的准备段落拼在文件内容前面——`git checkout <分支>`；改了页面的票（worktree 里有 `.browser-check/`）再加起 dev server、`scripts/browser-lab.ts` 建验收租户、Magic Link 登录——拼装与格式检查是 `.sandcastle/pr-body.ts` 的纯函数。

- 缺失或格式不对：正文该节写「⚠️ implementer 没有写验收说明」或「⚠️ 验收说明格式不对：<问题>」，**不自动合并**（「什么时候自动合并」的第 4 条），打 `sandcastle:pr-open` 并在 PR 上评论原因。reviewer 也会独立核对验收说明（对照 diff 和验收标准，不执行步骤），不合格给 `revise`——两道检查互不替代。
- 重做（人在 PR 上打回）时：implementer 每次会话完整重写这个文件（新 worktree 里旧文件已经没了），脚本用 `gh pr edit` **只替换**正文里的 `## 验收说明` 一节，其余逐字保留，更新评论里注明「验收说明已更新」。
- 外部 PR：不改正文（那是 PR 作者写的），验收说明贴在「Sandcastle 更新了这个分支」的评论里。
