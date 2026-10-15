# JAT Marketing OS

An AI-powered, brand-aware marketing automation platform by **Jeremy Anderson Tech**. It learns a business's brand and verified facts once (Brand DNA + Claim Registry), then plans, drafts, quality-checks, schedules, publishes and reports on marketing across websites and social channels — with human approval wherever there's risk.

> **Status:** Phases 1–4 built: foundation, AI layer, Brand DNA onboarding, planning calendar, AI drafting with checks, approvals, CSV export, and publishing (scheduling, the publisher with its safety checks, pause switches, a Connections page with Bluesky, Facebook Pages and the WordPress connector plugin). Everything is tested against real Postgres with mocked platforms: **nothing has been sent to a live Bluesky, Facebook or WordPress account yet**, and the AI and crawler have not called the live Claude API or crawled a real site. Publishing stays in dry-run until both `PUBLISH_MODE=live` and a per-client admin switch are set. No integration is claimed to work until its adapter passes staging tests.

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
  integrations/  Channel adapters: Bluesky, Facebook Pages (OAuth + publish), WordPress connector client
apps/
  web/     Dashboard: sign-in, client workspaces, Brand DNA, claims, plan + calendar, content, approvals,
           export, connections + scheduling; the publisher (dispatcher) runs in-process or as a worker
wordpress-plugin/
  jat-connector/  WordPress plugin: HMAC-signed REST API for drafts and SEO meta with rollback
skills/    Agent Skills (SKILL.md) used by Claude Code and loaded as agent instructions
docs/      Planning deliverables A–J and research
```

## Development

Requirements: Node 22+, pnpm 10, PostgreSQL 16 server binaries (for DB tests and the demo).

```bash
pnpm install
pnpm check                       # typecheck + all tests
pnpm --filter @jat/web demo      # local demo on http://localhost:3000
```

The demo starts a throwaway Postgres, seeds two clients and three people, and shows sign-in links on screen. Sign in as `ops@jat.example` (agency operator) to draft Brand DNA, then as `owner@acme.example` to approve it. Then, as the operator, turn on channels on the Plan page, draft a plan, approve it and draft the posts; approve them as the owner and download the CSV. Without `ANTHROPIC_API_KEY` it uses a canned sample AI response; with a key it crawls the real website and calls Claude.

### Running the app

```bash
NODE_ENV=production \
DATABASE_URL=postgres://app_user:...@host/db \
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
BASE_URL=https://app.example.com \
ANTHROPIC_API_KEY=... \
pnpm --filter @jat/web start
```

Apply `packages/db/migrations/*.sql` in order as the schema owner first. The app must connect as `app_user` (no `BYPASSRLS`). Production sign-in email delivery is not wired up yet (backlog AUTH-2).

Database tests start a throwaway Postgres cluster automatically. If the binaries aren't on a standard path, set `PG_BIN` (e.g. `PG_BIN=/usr/lib/postgresql/16/bin`). Without them, the DB suite is skipped, not failed.

Copy `.env.example` to `.env` for local settings. `PUBLISH_MODE` defaults to `dry_run`; live publishing additionally requires a platform admin to enable publishing for each client.

### Publishing

- Run two processes in production: `JAT_PROCESS=web` (HTTP; can store credentials but never read them) and `JAT_PROCESS=worker` (the publisher; connects as a login role that is a member of `publisher_user` via `PUBLISHER_DATABASE_URL`). `JAT_PROCESS=all` is for development and is refused in production.
- Credentials are envelope-encrypted. Only the development KEK (`LOCAL_KEK_BASE64`) exists today; a KMS-backed provider is required before production (backlog VAULT-2).
- Facebook needs `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` and the redirect URI `{BASE_URL}/oauth/facebook/callback` registered in the Meta app (App Review for `pages_manage_posts` is SETUP-1).
- In the demo, publishing is always dry-run. `DEMO_FAKE_PUBLISH=1` accepts any Bluesky app password so the screens can be explored offline.

## Safety principles (enforced in code, not prompts)

- Tenant isolation is enforced by Postgres RLS; tests prove cross-tenant reads and writes fail.
- Agents produce drafts only. They never hold credentials and cannot approve or publish.
- Approvals are bound to a content hash; any edit invalidates them.
- Global, client and channel pause switches block every publish. A post that misses its time by more than a day while paused is not sent late; a person decides.
- The publisher re-checks everything at send time (approval of the exact content hash, final lint, connection, pauses, mode) and never automatically retries a send that may have reached the platform.
- Generated content may only state facts from the verified claim registry.
