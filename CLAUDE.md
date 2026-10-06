## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Ticket sizing

A `ready-for-agent` ticket has at most 3 acceptance criteria and an `## Implementation guide` section. Before `/implement`, run `/prep-ticket <n>` (or without a number for the next ready ticket) to split it and write the guide. See `docs/agents/ticket-sizing.md`.

### UI conventions

Before building or changing a page, read `docs/agents/ui.md` (shell, page header, stat tiles, card grid, tabs, status colors).

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

ADRs: read the index `docs/adr/README.md` first and open only the ADRs relevant to your change. When you add an ADR, add its row to the index.

## Context budget

Keep the main context window under ~150k tokens for a whole ticket, building included.

- The ticket's `## Implementation guide` is your exploration: start from its `file:line` references, confirm line numbers with `grep -n`, then change the code.
- In the main thread, read in full only the files you are about to modify, and only if they are under ~300 lines. In a longer file, read just the functions you will change: `grep -n` to find them, then `sed -n` that range. To understand a module you won't change, read its header comment and `grep -n '^export'`.
- Locate with `grep -n` first, then read the range you need with `sed -n 'a,bp'`. Don't `cat` several files in one command.
- When a tool result is saved to a `tool-results/` file because it was too large, grep that file for what you need. Don't Read it whole.
- Write long command output (full test suite, builds) to a file and grep it. The full suite takes 15–25 minutes: run it with `run_in_background` and wait for its completion notice before running any other vitest.
- Before writing tests, read `test/README.md` (fixtures, helpers, templates) instead of the harness and fixture sources. To find a similar existing test, `grep -n` `test/CATALOG.md`; don't read it whole. When you add a fixture helper, update `test/README.md`; when you add a test file, add its row to `test/CATALOG.md`.
