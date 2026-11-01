# TASK

实现 issue #{{TASK_ID}}：{{ISSUE_TITLE}}。只做这一张票。分支 `{{BRANCH}}`。

1. `gh issue view {{TASK_ID}} --comments`。评论里可能有上一次会话留下的进度——从那里接着做，不要重做。
2. 如果这个分支已经有 PR（`gh pr view {{BRANCH}} --comments`），先处理里面的 review 意见。
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
- 票里有 **Browser check**：沙箱里没有浏览器，跳过，并在 issue 评论里写「浏览器验收待人工」以及要检查什么。

# COMMIT

按仓库现有风格写中文提交信息（看 `git log -n 3 --format=%B origin/main`）：一行说明做了什么，然后是关键决定、改动的文件、验证结果（typecheck、跑过的测试文件与用例数），末尾 `(#{{TASK_ID}})`。新增测试文件要在 `test/CATALOG.md` 加一行；加了 ADR 要更新 `docs/adr/README.md`。

不要 push，不要开 PR，不要合并，不要关 issue——这些由编排脚本来做。

# 结束

- 完成：输出 <promise>COMPLETE</promise>。
- 没完成（上下文快满、卡住、指引过时）：提交已经能通过测试的部分，在 issue 上评论「已完成什么 / 还差什么 / 下一步从哪开始」，不输出 COMPLETE。下一次会话会从你的评论接着做。
