# TASK

分支 `{{BRANCH}}`（issue #{{TASK_ID}}）要 rebase 到 `{{BASE}}` 上才能合并。同一轮先合并的票改了相近的地方。

现在的状态：{{SITUATION}}

你的任务只是让本票的改动**原样**落在 `{{BASE}}` 之上，不加功能、不顺手重构。之后编排脚本会自己跑 typecheck 与完整测试，通过才合并，所以你不用跑完整测试。

# 先看清两边

- `git status`、`git diff --name-only --diff-filter=U` 看冲突文件。
- 本票要做什么：`gh issue view {{TASK_ID}}`（只看验收标准）。
- 对方改了什么：`git log --oneline origin/{{BRANCH}}..{{BASE}}`，按冲突文件看 `git diff origin/{{BRANCH}}...{{BASE}} -- <file>`。不要一次看全部 diff。

# 怎么解决

- **两边都在追加的文件**（`test/CATALOG.md`、`test/README.md`、`CONTEXT.md`、`docs/adr/README.md`、审计动作登记、导出列表等）：两边都保留，按文件原有顺序排好。
- **`app/.server/db/schema.ts`**：两边的表、列都保留。
- **drizzle 迁移**（`drizzle/<时间戳>_<名字>/`）：不要手工合并 `migration.sql` 或 `snapshot.json`。rebase 中先只解决 `schema.ts`（迁移目录原样保留）；**rebase 全部结束后**再删掉**本票**加的迁移目录，重新 `npm run db:generate -- --name <原来的名字>`。新目录要排在 `{{BASE}}` 最新迁移之后，`snapshot.json` 的 `prevIds` 要指向它。看一眼新的 `migration.sql`：只能有本票的改动。
- **代码冲突**：读懂两边的意图再合。对方的行为不能被本票改掉；本票的行为也不能丢。
- rebase 进行中时，每解决完一个提交：`git add` 后 `GIT_EDITOR=true git rebase --continue`，直到结束。迁移是在 rebase 结束后重新生成的，就单独提交，中文提交信息「重新生成迁移，接在 … 之后」，末尾 `(#{{TASK_ID}})`。
- 结束前跑 `npm run typecheck`，以及冲突文件对应的测试文件（`npx vitest run <file>`）。

# 解决不了时

需要做产品或设计判断（两边对同一行为的要求矛盾），或者你没把握合对：执行 `git rebase --abort`，然后在 issue 上评论哪些文件冲突、两边各要什么、为什么不能自动合。不要硬合。

# 结束

rebase 已经结束（`git status` 不再显示 rebase 进行中）、typecheck 通过时，输出 <promise>COMPLETE</promise>。

不要 push、不要合并、不要关 issue。
