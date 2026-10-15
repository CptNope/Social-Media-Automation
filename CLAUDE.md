# JAT Marketing OS — notes for Claude Code

- Read `docs/G-mvp-roadmap.md` and `docs/J-development-backlog.md` before starting work; pick the next unchecked backlog item in the current phase.
- Run `pnpm check` (typecheck + tests) before every commit. DB tests need Postgres 16 binaries (`PG_BIN`).
- Domain rules live in `packages/core`. Keep them pure (no I/O) and fully unit-tested.
- Every tenant-scoped query goes through `withTenant()` (`packages/db`). Never connect as a role with BYPASSRLS from application code.
- Never add code that publishes to an external platform without going through `evaluatePublishGate()`.
- Agent instructions live in `skills/*/SKILL.md` (also exposed to Claude Code via `.claude/skills`). Skill names: lowercase/hyphens, ≤ 64 chars, must not contain "claude" or "anthropic".
- Platform API facts change often. Re-verify against official docs and update `docs/research/` before building an adapter. Mark anything unverified as UNVERIFIED.
- Never commit secrets. `.env` is git-ignored; use `.env.example` for new variables.
