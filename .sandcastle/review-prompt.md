# TASK

审查分支 `{{BRANCH}}` 相对 `origin/main` 的改动（issue #{{TASK_ID}}），修掉能确定的问题，并判断能否不经人审直接合并。

# CONTEXT

## Commits

!`git log origin/main..{{BRANCH}} --oneline`

## Diff 概况

!`git diff --stat origin/main...{{BRANCH}}`

需要看具体改动时，按文件看 `git diff origin/main...{{BRANCH}} -- <file>`，不要一次看全部 diff。

# 两个维度

**Spec**：`gh issue view {{TASK_ID}}`。逐条对照验收标准：每条有没有实现、有没有测试覆盖。遗漏的、做了票没要求的，都列出来。

**Standards**：按 @.sandcastle/CODING_STANDARDS.md 检查。另外看：

- 不安全的类型断言、`any`、没校验的假设
- 注入、凭据泄露、敏感字段进了日志 / 审计 / 检索文本
- 多余的抽象、嵌套三元、只复述代码的注释

# 执行

- 能确定、改动小、不改行为的问题：直接改，跑相关测试与 `npm run typecheck`，提交（中文提交信息，末尾 `(#{{TASK_ID}})`）。
- 改行为、或需要判断的问题：**不要改**，写进摘要交给人。
- 不要跑完整测试（之后编排脚本会跑一遍作为合并门槛）；只跑你改到的测试文件。

# OUTPUT

先给结论，决定这张票能不能**不经人审**直接合并进 `main`：

<verdict>merge</verdict>

只有下面几条**全部**满足才写 `merge`，否则写 `<verdict>pr</verdict>`（留 PR 给人审）：

- 每条验收标准都实现了、都有测试覆盖。
- 「需要人判断」一栏是「无」。
- 没有改页面（改了页面就留 PR：implementer 的浏览器验收截图会附在 PR 上，由人看过再合并）。
- 没有新增或修改 ADR、没有改权限模型或敏感字段的处理方式。
- 没有删除或改写已有测试的断言来让测试通过。

typecheck 和完整测试由脚本另外把关，不用你判断。

然后输出给 PR 用的摘要（中文、简短）：

<review-summary>
**Spec**：每条验收标准 ✅/❌ 一行
**已修**：…
**需要人判断**：…（没有就写「无」）
**浏览器验收**：不需要 / 已做（看 `.browser-check/RESULT.md`，结论里有 ❌ 或没验证到的写出来）/ 需要但没做（写检查什么）
</review-summary>

然后输出 <promise>COMPLETE</promise>。
