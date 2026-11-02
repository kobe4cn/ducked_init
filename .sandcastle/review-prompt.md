# TASK

审查分支 `{{BRANCH}}` 相对 `origin/main` 的改动（issue #{{TASK_ID}}），修掉能确定的问题，并给出结论：直接合并、打回 implementer 修改，还是留给人审。

这是第 {{ROUND}} 次打回后的审查（0 表示第一次审查；最多打回 {{REVISE_MAX}} 次）。不是第一次时，先看 `git log origin/main..{{BRANCH}} --oneline` 最近的提交，确认上次的意见改了没有，再看有没有新问题。

# CONTEXT

## Commits

!`git log origin/main..{{BRANCH}} --oneline`

## Diff 概况

!`git diff --stat origin/main...{{BRANCH}}`

需要看具体改动时，按文件看 `git diff origin/main...{{BRANCH}} -- <file>`，不要一次看全部 diff。

# 两个维度

**Spec**：`gh issue view {{TASK_ID}}`。逐条对照验收标准：每条有没有实现、有没有测试覆盖。遗漏的、做了票没要求的，都列出来。

**人的 review 意见**：这个分支已经有 PR 时（`gh pr view {{BRANCH}} --comments`，行内意见用 `gh api "repos/{owner}/{repo}/pulls/$(gh pr view {{BRANCH}} --json number -q .number)/comments" --jq '.[] | "\(.path):\(.line) \(.body)"'`），逐条确认 implementer 处理了。没有 PR 就跳过。没处理的算 revise 的意见。

**Standards**：按 @.sandcastle/CODING_STANDARDS.md、@CODING_STANDARDS.md 和 `CONTEXT.md` 的术语检查。另外看：

- 和仓库已有函数重复的逻辑（grep 一下有没有现成的 helper）
- 不安全的类型断言、`any`、没校验的假设
- 注入、凭据泄露、敏感字段进了日志 / 审计 / 检索文本
- 多余的抽象、嵌套三元、只复述代码的注释

# 执行

- 能确定、改动小、不改行为的问题：直接改，跑相关测试与 `npm run typecheck`，提交（中文提交信息，末尾 `(#{{TASK_ID}})`）。
- 改行为、但正确做法明确的问题（漏了验收标准或测试、测试缺断言、重复已有 helper、术语不对、做法明显错且该怎么改是清楚的）：**不要自己改**，写进 `<revise>`，交给 implementer。
- 需要人判断的问题（票本身有歧义、要做票没说的设计决定、有几种都说得通的做法）：**不要改**，写进摘要交给人。
- 不要跑完整测试（之后编排脚本会跑一遍作为合并门槛）；只跑你改到的测试文件。

# OUTPUT

先给结论，三选一：

- `<verdict>revise</verdict>`：有能交给 implementer 改的问题（上面「执行」的第二类）。即使还有要人判断的问题、或改了页面，也先打回；只有当要人判断的问题会决定这些修改怎么做时，才直接写 `pr`。
- `<verdict>merge</verdict>`：没有要打回的问题，且下面几条**全部**满足。
- `<verdict>pr</verdict>`：其余情况，留 PR 给人审。

写 `merge` 的条件：

- 每条验收标准都实现了、都有测试覆盖。
- 「需要人判断」一栏是「无」，PR 上人的 review 意见都处理了。
- 没有改页面（改了页面就留 PR：implementer 的浏览器验收截图会附在 PR 上，由人看过再合并）。
- 没有新增或修改 ADR、没有改权限模型或敏感字段的处理方式。
- 没有删除或改写已有测试的断言来让测试通过。

typecheck 和完整测试由脚本另外把关，不用你判断。

写 `revise` 时，接着列出修改意见，implementer 只看得到这一段（不会看你的摘要）。每条写清楚位置、问题、怎么改、怎么验证：

<revise>
1. `app/.server/x.ts:42`：问题……。改法：……。验证：补一个用例断言……
</revise>

然后输出给 PR 用的摘要（中文、简短）：

<review-summary>
**Spec**：每条验收标准 ✅/❌ 一行
**已修**：…
**需要人判断**：…（没有就写「无」）
**浏览器验收**：不需要 / 已做（看 `.browser-check/RESULT.md`，结论里有 ❌ 或没验证到的写出来）/ 需要但没做（写检查什么）
</review-summary>

然后输出 <promise>COMPLETE</promise>。
