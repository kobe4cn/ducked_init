# TASK

为 issue #{{TASK_ID}} 做实现前的准备：按 `.claude/skills/prep-ticket/SKILL.md` 执行（参数就是 {{TASK_ID}}），规则在 `docs/agents/ticket-sizing.md`。

这是无人值守运行，没有人回答问题。SKILL.md 里「告诉用户」的地方改成在 issue 上留评论；下面的规则优先于 SKILL.md。

# 标签规则（Sandcastle 专用）

先看 `## Blocked by`：有任何 blocker 还是 open（`gh issue view <n> --json state`），就**什么都不改**，直接结束。它等 blocker 合并后的下一轮再准备（拆票要及时，见 ticket-sizing.md）。

然后按 SKILL.md 第 2 步的判断，结果只有三种：

1. **已经可以实现**（含刷新了指引）：`gh issue edit {{TASK_ID}} --add-label "{{LABEL_PREPPED}}"`。
2. **拆成了子票**：
   - 每张子票都加 `{{LABEL_PICKED}}` 和 `ready-for-agent`，**不加** `{{LABEL_PREPPED}}`（下一轮按上面的 blocker 规则逐张准备，第一张通常没有 open blocker，下一轮会直接确认）。
   - 父票去掉 `{{LABEL_PICKED}}` 和 `ready-for-agent`，正文加 `## Split into`。
   - 别的票若被父票 block，改成被对应子票 block。
3. **有设计决定要人拍板**：加 `{{LABEL_STUCK}}` 和 `ready-for-human`，评论里写清楚要决定什么、有哪几个选项、你的建议。

不要写代码，不要提交。

完成后输出 <promise>COMPLETE</promise>。
