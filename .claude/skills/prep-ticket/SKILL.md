---
name: prep-ticket
description: Before implementing a GitHub issue, split it into tickets that fit one implement session and add an Implementation guide to each, written from an Explore subagent's report. Use before /implement, or when the user asks to split or prepare a ticket.
argument-hint: "[issue number; omit to pick the next ready ticket]"
---

# Prep a ticket for /implement

The rules (size limit, vertical slices, guide template) are in `docs/agents/ticket-sizing.md`. Read it first. Write ticket bodies in Chinese, like the existing issues.

Keep this session light: never read source files in full here. All exploration goes through the Explore subagent.

## 1. Pick the ticket

- With an argument, use that issue: `gh issue view <n> --json number,title,body,labels,comments`.
- Without an argument, list open `ready-for-agent` issues. Take the lowest-numbered one whose `## Blocked by` issues are all closed, skipping the spec issue (#1).
- If a blocker is still open, check with `git log --oneline --grep "#<blocker>"` whether it was already implemented. If it was, tell the user it can be closed. Don't close it yourself.

## 2. Decide whether it needs work

- **≤3 acceptance criteria and has `## Implementation guide`**: it's ready. Spot-check two `file:line` references in the guide with `grep -n`. If they're stale, refresh the guide (step 3) without splitting. Otherwise stop and say it's ready.
- **≤3 acceptance criteria, no guide**: add a guide (steps 3 and 5) without splitting.
- **More than 3 acceptance criteria**: split it and give each child a guide (steps 3–6).

## 3. Explore

Launch an `Explore` subagent with breadth "medium". Wait for its report, and don't explore the same code yourself meanwhile. Fill in this prompt:

```
仓库 <repo path>。我要给 GitHub issue #<n>（正文附后）<拆成几张小票，并且给每张票 / 补上>
一段「实现指引」，让之后实现它的 agent 不用自己探索代码。只读代码、不改文件，搜索广度 medium。

## 票的内容
<ticket body, or your draft of the slices>

## 请回答（只给结论，不贴文件内容或大段代码）
对每一块分别给出：
- 要改 / 新建的文件，精确到 `file:line`（函数或区块的起始行）
- 可复用的已有接口：一行函数签名；表结构 / 类型的字段名
- 数据现在从哪来、存在哪（表、JSON 字段、类型定义）
- 相关的校验、权限、路由入口（loader / action 的位置）
- 相关 ADR 编号（查 docs/adr/README.md）
- 测试放哪个文件、可复用的 helper（查 test/README.md）
- 种子数据或测试数据里会影响验收的事实
- 非显而易见的坑（会被校验拦下、缺失的属性、隐私或权限约束）
- 各块之间的依赖，以及每块预计新增行数（含测试）

输出控制在 1500 字以内，用条目列出。
```

Add questions specific to the ticket, e.g. the seed tables named in its acceptance criteria.

## 4. Draw the slices

From the report, split the ticket into vertical slices. Each slice has ≤3 acceptance criteria and about ≤800 lines including tests. Every original acceptance criterion must land in exactly one child. Order the slices by their dependencies.

## 5. Write each guide

Use the template in `docs/agents/ticket-sizing.md`. Before publishing, `grep -n` two or three of the references to confirm the line numbers. Put open decisions the implementer must make under **Decide**.

## 6. Publish

Write bodies to temp files and pass them with `--body-file`.

- Create children blockers-first with `gh issue create --label ready-for-agent`. Each child body has `## Parent` #<n>, `## What to build`, `## Acceptance criteria`, `## Blocked by` (the parent's blockers and/or sibling numbers), and `## Implementation guide`.
- Parent: append `## Split into` with a checklist of children, and remove `ready-for-agent`.
- Dependents: find open issues whose `## Blocked by` lists the parent (`gh issue list --state open --search "#<n>" --json number,body`). Repoint them to the right child, or comment if it's only a mention.
- Guide only (no split): append the section with `gh issue edit <n> --body-file`.

## 7. Report

Report in Chinese:
- A table of child tickets: number, title, AC count, blockers.
- The pitfalls the report surfaced.
- Which ticket to `/implement` first.
- Anything the user must decide, such as closing an implemented blocker.

Suggest `/clear` before `/implement` so the build session starts from the ticket alone.
