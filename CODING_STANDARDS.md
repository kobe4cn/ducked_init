# Coding standards

Judgement rules for review. Mechanical rules live in checks instead (`pnpm typecheck`, `test/migrations.test.ts`, the `.claude/hooks/` hooks). Pages also follow `docs/agents/ui.md`; domain terms follow `CONTEXT.md`.

## Untrusted input reaching DuckDB

User-written SQL, YAML expressions and identifiers are hostile until proven otherwise.

- Validate SQL on DuckDB's parse tree, never on text or names. Resolve every reference in its own scope: a CTE name shadows a table only inside the SELECT that defines it.
- Allow by whitelist (tables, functions), not by blacklist. Note in a test which DuckDB version the parse-tree shape was checked against.
- PII never leaves the lake as plain text, including samples, previews, error messages and audit details. Exempt columns by an explicit list, never by a naming pattern such as a `_` prefix.

## Concurrency

- Check-then-act (delete only if unreferenced, publish only if the draft is unchanged) runs in one transaction and locks the row that the competing writer also locks. If the other side doesn't take that lock yet, say so in the ticket or ADR.

## Consistency with siblings

Two-person publish exists for mappings, templates, source views and custom entities. A new feature of that shape matches its siblings:

- Same status codes for the same failure (missing entity 404, missing draft 404 after a lock wait, invalid input 400, permission 403).
- Same display conventions (for example the mapping name `table → entity`).
- Reuse the shared pieces (`publish-rules.ts`, existing field and column types) before writing a fourth copy. If the skeleton must be copied, flag it in the review as a deepening candidate.

## Comments and names

- Every file starts with `// <path> —— <what it is>`, as in `test/README.md`'s templates.
- A JSDoc comment sits directly above the thing it describes; inserting a field between them is a bug.
- In one scope, avoid names that differ only by suffix (`registered` / `registration` / `registeredField`) and avoid reusing `e` for both a value and a caught error.
