# TASK

实现 issue #{{TASK_ID}}：{{ISSUE_TITLE}}。只做这一张票。分支 `{{BRANCH}}`。

1. `gh issue view {{TASK_ID}} --comments`。评论里可能有上一次会话留下的进度——从那里接着做，不要重做。
2. 如果这个分支已经有 PR（`gh pr view {{BRANCH}} --comments`），先逐条处理里面的 review 意见，包括行内意见：`gh api "repos/{owner}/{repo}/pulls/$(gh pr view {{BRANCH}} --json number -q .number)/comments" --jq '.[] | "\(.path):\(.line) \(.body)"'`。
3. `git log --oneline {{BRANCH}} -n 10` 看这个分支已经提交了什么。

# CONTEXT BUDGET

这次会话要在 ~150k token 内完成。遵守 `CLAUDE.md` 的「Context budget」：

- 票的 `## Implementation guide` 就是你的探索结果。从它的 `file:line` 出发，`grep -n` 确认行号再改。不要做广泛探索。
- 只整读要改的、300 行以内的文件；长文件用 `grep -n` + `sed -n` 读要改的函数。
- 写测试前读 `test/README.md`，相似测试从 `test/CATALOG.md` 用 `grep -n` 找。
- 指引和代码对不上（文件挪了、函数没了）或要做指引没提到的设计决定时，**停下**：在 issue 上评论说明，不输出 COMPLETE。

# EXECUTION

红-绿循环，一次一个验收标准：写一个测试 → 跑红 → 实现 → 跑绿。全部完成后再整理。

# FEEDBACK LOOPS

- 开发中只跑相关测试文件：`npx vitest run <file>`。测试连的 PG、MySQL、MongoDB、对象存储都已经通过环境变量配好（宿主机上的容器），不要改连接配置。
- 提交前跑 `npm run typecheck` 和你改到的、相关的测试文件。**不用跑完整测试**：review 之后编排脚本会自己跑一遍完整测试作为合并门槛，失败时会再叫你修。
- 票里有 **Browser check**：HTTP 测试通过、提交之后，按下面的「浏览器验收」做。

# 浏览器验收（只在票里有 Browser check 时）

沙箱里没有 ego-browser，用 `playwright-cli`（无头 Chromium，`playwright-cli --help` 看命令）。`test/README.md` 的「浏览器验收」一节是给宿主机写的（ego-browser、开发库 `crm_platform`）；在沙箱里按这里做。

1. 准备：`rm -rf .browser-check && mkdir .browser-check`，`node --import tsx scripts/browser-lab.ts`（在这张票自己的验收库里建租户 `crmlab-smoke` 与 `admin@` / `eng@` / `an@crmlab-smoke.test`，环境变量已配好）。
2. 起 dev server（后台，输出写文件）：`npx react-router dev --port 5180 --strictPort > /tmp/dev.log 2>&1 &`，等 `curl -s -o /dev/null http://localhost:5180/login` 成功。
3. 登录：`playwright-cli open http://localhost:5180/login` → `snapshot` 找邮箱框和「发送登录链接」的 ref → `fill` / `click` → `grep -o 'http://localhost:5180/auth/verify?token=[A-Za-z0-9_-]*' /tmp/dev.log | tail -1` → `goto` 这个链接 → **点「登录」按钮** → 地址离开 `/auth` 才算登录。换角色先点「退出登录」。
4. 照 Browser check 操作。验收租户是空的：需要的数据（数据源、定义等）在页面上自己建，建不出来就写进结论。每个要看的状态截一张：`playwright-cli screenshot --filename=.browser-check/<两位序号>-<说明>.png`，然后**用 Read 看截图**，对照 Browser check 和 `docs/agents/ui.md` 判断。
5. 查错：`playwright-cli console error`，`grep -n -i error /tmp/dev.log`。首次加载时 vite 的 `Failed to fetch dynamically imported module` / 依赖预构建重载是噪声，刷新后不再出现就忽略。
6. 发现问题就修（能用 HTTP 测试锁住的补测试），提交后重新截图。
7. 写 `.browser-check/RESULT.md`（中文，会原样进 PR 正文）：Browser check 每一步 ✅/❌/⚠️ 一行，引用对应截图文件名；页面或服务端报错；没能验证的及原因。
8. 收尾：`playwright-cli close`，停掉 dev server（`kill %1` 或按端口找进程）。`.browser-check/` 不提交（已在 `.gitignore`），编排脚本会把它拷出来附到 PR 上。

浏览器验收通过与否都不影响你输出 COMPLETE；改了页面的票一律留 PR 由人看截图后合并。

# COMMIT

提交前按 `.sandcastle/CODING_STANDARDS.md` 和根目录的 `CODING_STANDARDS.md` 自查一遍改动（两份都很短），review 会按它们打回。

按仓库现有风格写中文提交信息（看 `git log -n 3 --format=%B origin/main`）：一行说明做了什么，然后是关键决定、改动的文件、验证结果（typecheck、跑过的测试文件与用例数），末尾 `(#{{TASK_ID}})`。新增测试文件要在 `test/CATALOG.md` 加一行；加了 ADR 要更新 `docs/adr/README.md`。

不要 push，不要开 PR，不要合并，不要关 issue——这些由编排脚本来做。

# 结束

- 完成：输出 <promise>COMPLETE</promise>。
- 没完成（上下文快满、卡住、指引过时）：提交已经能通过测试的部分，在 issue 上评论「已完成什么 / 还差什么 / 下一步从哪开始」，不输出 COMPLETE。下一次会话会从你的评论接着做。
