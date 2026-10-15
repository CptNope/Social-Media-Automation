# JAT Marketing OS

An AI-powered, brand-aware marketing automation platform by **Jeremy Anderson Tech**. It learns a business's brand and verified facts once (Brand DNA + Claim Registry), then plans, drafts, quality-checks, schedules, publishes and reports on marketing across websites and social channels — with human approval wherever there's risk.

> **Status:** Phase 1 (Foundation) done; Phase 2 (AI layer & Brand DNA) in progress — the AI and crawler code is tested with mocks only; it has not yet called the live Claude API or crawled a real site. Nothing publishes to any platform yet. No integration is claimed to work until its adapter passes staging tests.

## Planning documents

| | Document |
|---|---|
| 00 | [Critical review of the vision, improvements, smallest commercial MVP](docs/00-vision-review.md) |
| A | [Product requirements](docs/A-product-requirements.md) |
| B | [Technical architecture](docs/B-technical-architecture.md) |
| C | [Claude Skills & agent architecture](docs/C-claude-skills-architecture.md) |
| D | [Integration feasibility matrix](docs/D-integration-feasibility.md) |
| E | [Database design](docs/E-database-design.md) |
| F | [Dashboard UX plan](docs/F-dashboard-ux.md) |
| G | [MVP roadmap](docs/G-mvp-roadmap.md) |
| H | [Financial feasibility](docs/H-financial-feasibility.md) |
| I | [Testing & security strategy](docs/I-testing-security.md) |
| J | [Development backlog](docs/J-development-backlog.md) |
| — | [API research notes, verified 2026-10-15](docs/research/2026-10-api-research.md) |

## Repository layout

```
packages/
  core/    Domain rules: Brand DNA schema + activation guard, claim registry,
           PostDraft schema, platform limits, deterministic content linter,
           approval policy + publish gate, content state machine, hashing, UTM
  vault/   Envelope encryption for platform credentials (AES-256-GCM, KMS-wrapped keys)
  db/      SQL migrations with Postgres Row-Level Security; tenant-scoped transaction helper; AI cost ledger SQL
  ai/      Claude Messages API client, structured outputs, budget guard, skill loader, Brand DNA agent
  ingest/  Website crawler (robots.txt, SSRF-safe fetching) producing evidence for the agents
skills/    Agent Skills (SKILL.md) used by Claude Code and loaded as agent instructions
docs/      Planning deliverables A–J and research
```

## Development

Requirements: Node 22+, pnpm 10, PostgreSQL 16 server binaries (for DB tests).

```bash
pnpm install
pnpm check          # typecheck + all tests
```

Database tests start a throwaway Postgres cluster automatically. If the binaries aren't on a standard path, set `PG_BIN` (e.g. `PG_BIN=/usr/lib/postgresql/16/bin`). Without them, the DB suite is skipped, not failed.

Copy `.env.example` to `.env` for local settings. `PUBLISH_MODE` defaults to `dry_run`; live publishing additionally requires a platform admin to enable publishing for each client.

## Safety principles (enforced in code, not prompts)

- Tenant isolation is enforced by Postgres RLS; tests prove cross-tenant reads and writes fail.
- Agents produce drafts only. They never hold credentials and cannot approve or publish.
- Approvals are bound to a content hash; any edit invalidates them.
- Global, client and channel pause switches block every publish.
- Generated content may only state facts from the verified claim registry.
