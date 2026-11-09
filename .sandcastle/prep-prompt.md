# TASK

为 issue #{{TASK_ID}} 做实现前的准备：按 `.claude/skills/prep-ticket/SKILL.md` 执行（参数就是 {{TASK_ID}}），规则在 `docs/agents/ticket-sizing.md`。

这是无人值守运行，没有人回答问题。SKILL.md 里「告诉用户」的地方改成在 issue 上留评论；下面的规则优先于 SKILL.md。

# 标签规则（Sandcastle 专用）

先看 `## Blocked by`：有任何 blocker 还是 open（`gh issue view <n> --json state`），就**什么都不改**，直接结束。它等 blocker 合并后的下一轮再准备（拆票要及时，见 ticket-sizing.md）。

然后看评论里有没有 `{{REPREP_MARK}}`（`gh issue view {{TASK_ID}} --comments`）。有，说明 implementer 用完了会话还没做完，脚本把票退回来重新准备：**先按下面「实现没做完」一节处理，不按大小判断**。没有，就按 SKILL.md 第 2 步判断。结果只有三种：

1. **已经可以实现**（含刷新了指引）：`gh issue edit {{TASK_ID}} --add-label "{{LABEL_PREPPED}}"`。
2. **拆成了子票**：
   - 每张子票都加 `{{LABEL_PICKED}}` 和 `ready-for-agent`，**不加** `{{LABEL_PREPPED}}`（下一轮按上面的 blocker 规则逐张准备，第一张通常没有 open blocker，下一轮会直接确认）。
   - 父票去掉 `{{LABEL_PICKED}}` 和 `ready-for-agent`，正文加 `## Split into`。
   - 别的票若被父票 block，改成被对应子票 block。
   - 拆票时新开的票（包括从父票挪出去、排在别的票后面的那部分）不能把父票写进 `## Blocked by`：父票拆完只留作容器，不会自动关闭，写了就永远卡住。要等的是哪张子票就写哪张。
3. **有设计决定要人拍板**：加 `{{LABEL_STUCK}}` 和 `ready-for-human`，评论里写清楚要决定什么、有哪几个选项、你的建议。

遇到设计决定时先按 `.sandcastle/DECISIONS.md` 判断。属于「可以代拍板」的，按那里的步骤留评论、改票（必要时开后续票），然后按结果 1 或 2 继续，不是 3。只有「必须停下」才是 3。

# 偶发失败票（带 `flaky` 标签）

写指引前先查根因是不是已经修掉：同样的报错（失败摘要里的错误那一句）在已关闭的 `flaky` 票或 main 的提交里出现过（`gh issue list --label flaky --state closed --search "<报错>"`、`git log --oneline --grep` / `-S`），并且失败的分支早于那个修复提交（`git merge-base --is-ancestor <修复提交> <失败分支>` 返回 1）。

- **已经修掉**：把验收标准改成两条——①失败原因、修复它的提交和上面的判断依据写进提交信息；②不改代码（空提交），不重复跑测试。指引里写明判断依据，结果是上面的 1。
- **没修掉**：照常写指引。指引里要有一条修复前变红、修复后变绿的复现命令；跨进程 / 跨沙箱的竞争单跑复现不了，指引要写并发用例（照 #439），不要求反复单跑；重复单跑总共不超过 20 分钟。

# 实现没做完

读 implementer 留在 issue 上的进度评论（已完成什么、还差什么、卡在哪），以及那条标记评论里列出的、分支 `sandcastle/issue-{{TASK_ID}}` 上已有的提交。按卡住的原因处理：

- **指引和代码对不上**（文件挪了、函数没了、指引漏了要改的地方）：按 SKILL.md 第 3 步重写指引，结果是上面的 1。
- **上下文不够**（会话用完、票太大）：把**还没完成**的验收标准拆成子票，按上面的 2 处理子票，每张子票都写 `## Blocked by #{{TASK_ID}}`，指引要更细。父票这次不按 2 处理：正文只留已经完成、并且有测试的验收标准，删掉拆出去的那些，加 `## Split into`，保留 `{{LABEL_PICKED}}`、`ready-for-agent`，再加 `{{LABEL_PREPPED}}`。下一轮 implementer 在原分支上收尾、合并，子票接着做。一条都没完成时，父票也按 2 处理（去掉 `{{LABEL_PICKED}}`），在评论里写明分支上的部分提交可以参考。
- **implementer 卡在设计决定上**：按 `.sandcastle/DECISIONS.md` 判断。可以代拍板的，留评论、按决定改票的验收标准和指引（收窄范围时开后续票），结果是上面的 1；必须停下的，结果是上面的 3。
- 看不出原因：结果是上面的 3。

# 指引里的 Change 行

写或刷新指引时，要改的每个已有文件都写进 `- **Change**:` 行，路径用反引号放在最前面（一批只改一行的文件可以写成 `- **Change**（说明）：` 下的缩进子条目，每条一个 `` `path:行` ``）。脚本靠这些行判断两张票能不能并行，漏写的文件会让两张并行的票改到同一个文件，到合并时才冲突。

不要写代码，不要提交。

完成后输出 <promise>COMPLETE</promise>。
