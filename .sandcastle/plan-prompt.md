# ISSUES

下面是人工选中、且已经准备好（有新鲜的 `## Implementation guide`）的 open issue：

<issues-json>

!`gh issue list --state open --limit 100 --search '{{QUERY}}' --json number,title,body,labels --jq '[.[] | {number, title, body, labels: [.labels[].name]}]'`

</issues-json>

已开 PR 等人审的票、需要人介入的票不在这里。

# TASK

找出现在就能在 `main` 上开工、并且可以并行的票。

一张票 B **被 block**，如果：

- 它的 `## Blocked by` 里有任何 issue 仍是 open。不在上面列表里的 blocker 也要查：`gh issue view <n> --json state`。**blocker 已开 PR 但还没合并，仍然算 open**——它的代码还不在 `main` 上。
- 它和列表里另一张票的 `## Implementation guide` 的 `Change` 行改同一个文件（并行会冲突）。这种情况只保留编号小的那张。

只输出没有被 block 的票。**全部被 block 时输出空列表**，不要挑一张勉强开工。

分支名严格用 `sandcastle/issue-{id}`（不加后缀），这样重跑同一张票会接着原来的分支做。

# OUTPUT

按编号从小到大：

<plan>
{"issues": [{"id": "42", "title": "Fix auth bug", "branch": "sandcastle/issue-42"}]}
</plan>

没有可做的票时输出 `<plan>{"issues": []}</plan>`。
