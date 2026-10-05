# Ticket sizing and implementation guides

One `/implement` session should fit inside the ~150k context budget. Writing the code costs about 100k by itself, so the ticket has to be small and has to tell the implementer where to work.

## Size limit

- At most **3 acceptance criteria**. A ticket should add about **800 lines or fewer**, tests included.
- At most **4 existing files changed** (the `Change` lines of the guide; new files, tests, migrations, ADRs and docs don't count). Three acceptance criteria can still fan out across six modules, and every existing file costs context to read before it can be edited.
- When a ticket breaks this limit, split it into thinner end-to-end slices. For example, "write a source view and preview it" first, then "two-person publish" on top.
- Split vertically. Each child ticket is a thin end-to-end slice that can be demoed or tested on its own. Never split by layer (one for "backend" and one for "UI").
- The parent keeps the original body. It gains a `## Split into` list and loses its `ready-for-agent` label. Each child gets `## Parent`, `## Blocked by` and `ready-for-agent`.
- Point other tickets that are blocked by the parent at the right child.

## Split just in time

Split a ticket and write its guide only when its blockers are done, i.e. when it is next in line. A guide written earlier points at code that later tickets will move. If a ticket already has a guide written before its blockers landed, rewrite it with `/prep-ticket` before `/implement`.

The guide must not leave design decisions open ("if #95 decides X, then …"). Settle them while preparing the ticket and record them in the guide or an ADR; if one needs a human, label the ticket `ready-for-human` instead.

## The `## Implementation guide` section

Every `ready-for-agent` ticket ends with this section. It holds conclusions only: no pasted code.

```markdown
## Implementation guide

- **Change**: `path/file.ts:123-180` `functionName`: what to change. One line per file. Give the line range of each function to change, so the implementer reads only that range of a long file.
- **New**: `path/new-module.ts`: what it exports.
- **Reuse**: `fnName(arg: Type): Ret` in `path:line`; the table `x` with columns `a, b`.
- **ADRs**: 0006, 0015 (only the relevant ones).
- **Tests**: which file, which seam, which fixtures from `test/README.md`, and one similar existing test to copy (from `test/CATALOG.md`, as `file` + `it` name).
- **Watch out**: non-obvious constraints (privacy rules, permissions, migrations).
```

## How to write the guide

Don't explore in the main thread. Delegate to an `Explore` subagent with breadth "medium" and give it:

1. The ticket body, or the draft of the children when splitting.
2. A list of questions. Ask for the items in the guide template: `file:line` ranges of the functions to change, one-line signatures to reuse, table and type field names, relevant ADRs from `docs/adr/README.md`, test file and fixtures from `test/README.md`, a similar existing test from `test/CATALOG.md`, the number of existing files each slice changes, and a rough line count per slice.
3. An output rule: conclusions only, `file:line` references, no file contents, at most about 1500 words.

Then use the report to draw the slice boundaries, write each child's guide, and publish with `gh issue create`. Spot-check two or three of the `file:line` references with `grep -n` before publishing.
