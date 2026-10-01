## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

ADRs: read the index `docs/adr/README.md` first and open only the ADRs relevant to your change. When you add an ADR, add its row to the index.

## Context budget

Keep the main context window under ~150k tokens for a whole ticket, building included.

- Delegate pre-implementation exploration to an Explore subagent. Ask it for conclusions only (interface signatures, table shapes, `file:line` references), never file contents.
- In the main thread, read in full only the files you are about to modify. To understand a module you won't change, read its header comment and `grep -n '^export'`.
- Locate with `grep -n` first, then read the range you need with `sed -n 'a,bp'`. Don't `cat` several files in one command.
- When a tool result is saved to a `tool-results/` file because it was too large, grep that file for what you need. Don't Read it whole.
- Write long command output (full test suite, builds) to a file and grep it.
- Before writing tests, read `test/README.md` (fixtures, helpers, templates) instead of the harness and fixture sources. When you add a fixture helper or a test file, update it.
