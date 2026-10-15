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

## How it works

Every piece of content passes through the same pipeline. AI drafts, people decide, and the publisher checks everything again before anything leaves the system.

```mermaid
flowchart LR
    A["Website + notes"] -->|crawl| B["Brand DNA proposal"]
    B -->|owner approves| C["Active Brand DNA"]
    K["Claims registry<br/>(owner verifies facts)"] --> E
    C --> D["30/60/90-day plan"]
    D -->|operator approves| E["AI drafts posts"]
    E --> F["Automatic checks<br/>+ AI compliance review"]
    F --> G{"Approval<br/>(owner or reviewer)"}
    G -->|changes requested| E
    G -->|approved| H["Schedule"]
    G -->|approved| X["CSV export<br/>(post by hand)"]
    H --> I["Publisher re-checks<br/>at send time"]
    I -->|live| J["Bluesky / Facebook"]
    I -->|dry run or blocked| G2["Back to approved,<br/>reason shown"]
```

## Architecture

```mermaid
flowchart TB
    subgraph Browser
        U["Dashboard<br/>(server-rendered, no JavaScript)"]
    end
    subgraph web["Web process (JAT_PROCESS=web)"]
        W["apps/web<br/>routes, sign-in, CSRF"]
    end
    subgraph worker["Worker process (JAT_PROCESS=worker)"]
        P["Publisher / dispatcher<br/>every 30 s"]
    end
    subgraph pg["PostgreSQL 16 (Row-Level Security)"]
        DB[("tenant data")]
        CR[("credentials<br/>encrypted")]
    end
    U <-->|HTTPS| W
    W -->|"app_user<br/>(can store credentials, never read them)"| DB
    W -.->|insert only| CR
    P -->|"publisher_user<br/>(reads credentials)"| DB
    P --> CR
    W -->|plan, draft, review| AI["Claude API"]
    W -->|crawl| SITE["Client website"]
    P -->|publish| PLAT["Bluesky · Facebook Pages · WordPress plugin"]
```

| Package | What it does |
|---|---|
| `packages/core` | Domain rules with no I/O: Brand DNA, claims, linter, approval policy, publish gate, state machine |
| `packages/db` | SQL migrations, RLS policies, `withTenant()` and query helpers |
| `packages/vault` | Envelope encryption for platform credentials |
| `packages/ai` | Claude client, structured outputs, budget guard, agents |
| `packages/ingest` | Website crawler and the SSRF-safe fetch client |
| `packages/integrations` | Bluesky, Facebook Pages and WordPress clients |
| `apps/web` | Dashboard, background jobs and the publisher |
| `wordpress-plugin/jat-connector` | WordPress plugin for drafts and SEO changes |

## Getting started

### 1. Install the prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 22 or newer | Runs everything |
| pnpm | 10 | Workspace package manager (`corepack enable` installs it) |
| PostgreSQL server binaries | 16 | Database tests and the demo start a throwaway cluster |
| PHP (optional) | 8.0+ | Runs the WordPress plugin's tests; skipped if missing |

On Ubuntu: `sudo apt-get install -y postgresql-16`. On macOS: `brew install postgresql@16`.

### 2. Install and run the checks

```bash
git clone https://github.com/CptNope/Social-Media-Automation.git
cd Social-Media-Automation
pnpm install
pnpm check            # typecheck + all tests
```

If Postgres isn't on a standard path, point the tests at it: `PG_BIN=/usr/lib/postgresql/16/bin pnpm check`. Without the binaries the database tests are skipped, not failed.

### 3. Start the demo

```bash
PG_BIN=/usr/lib/postgresql/16/bin pnpm --filter @jat/web demo
```

Open http://localhost:3000. The demo creates a throwaway database with two clients and three people. Sign-in links are shown on screen instead of emailed.

| Sign in as | Role | Can do |
|---|---|---|
| `ops@jat.example` | Agency operator | Everything except the owner-only approvals |
| `owner@acme.example` | Client owner | Approves Brand DNA, verifies claims, approves posts |
| `editor@acme.example` | Client editor | Edits drafts and sends them for approval |

Demo options (environment variables):

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Use the real Claude API and crawl the real website. Without it, an offline sample model returns canned, valid output |
| `DEMO_FAKE_CRAWL=1` | Skip the real website crawl |
| `DEMO_FAKE_PUBLISH=1` | Accept any Bluesky app password, so the Connections and scheduling screens work offline |
| `PORT` | Port to listen on (default 3000) |

Publishing in the demo is always dry-run: nothing is ever sent to a platform.

### 4. Walk through the app

| Step | Who | Where | What to do |
|---|---|---|---|
| 1 | Operator | Overview | Create the brand, enter the website, click **Draft Brand DNA** |
| 2 | Operator | Brand → Review | Confirm or edit each field the AI inferred |
| 3 | Owner | Brand → Review | **Approve and activate** |
| 4 | Owner | Claims | Verify the facts the business may state publicly |
| 5 | Operator | Plan | Turn on channels and posts per week, then **Draft a plan** |
| 6 | Operator | Campaign | Move or remove slots, **Approve plan**, then **Draft posts** |
| 7 | Editor | Content | Fix anything marked "Must fix", then **Send for approval** |
| 8 | Owner or reviewer | Approvals | Approve one by one, or **Approve selected** (skips high-risk posts) |
| 9 | Operator | Connections | Connect Bluesky, Facebook or WordPress |
| 10 | Operator | Post page | **Schedule** or **Publish now**, or download the CSV and post by hand |

## Content lifecycle

```mermaid
stateDiagram-v2
    [*] --> draft: AI drafts
    draft --> in_review: send for approval (no blockers)
    in_review --> approved: approve (exact version)
    in_review --> draft: request changes
    approved --> draft: edit (approval dropped)
    approved --> scheduled: schedule
    scheduled --> approved: unschedule / dry run / blocked
    scheduled --> draft: request changes (send cancelled)
    scheduled --> publishing: publisher sends
    publishing --> published: success
    publishing --> scheduled: retryable error (backoff)
    publishing --> failed: auth, permission, rejected or uncertain
    failed --> scheduled: retry
    failed --> exported: confirmed it posted
    approved --> exported: posted by hand (CSV)
    published --> [*]
    exported --> [*]
```

## Publishing

The publisher wakes every 30 seconds, finds due posts across all clients (it can see only ids and times), and handles each one inside that client's isolated scope.

```mermaid
sequenceDiagram
    autonumber
    participant D as Dispatcher
    participant DB as Postgres
    participant G as Publish gate
    participant A as Bluesky / Facebook
    D->>DB: find due posts (ids + times only)
    D->>DB: lock the post (skip if another worker has it)
    D->>G: pauses? mode? approved hash = current text?<br/>lint clean? account connected?
    alt blocked or paused
        G-->>D: reasons
        D->>DB: keep waiting (paused) or return to approved with the reason
    else dry run
        D->>DB: record "dry run", nothing sent
    else live
        D->>DB: mark "publishing" and commit
        D->>A: send exactly the approved text
        A-->>D: post id + link, or an error
        D->>DB: record result, audit log
    end
```

What happens when a send fails:

| Error | Example | What the publisher does |
|---|---|---|
| Retryable | Rate limit, DNS failure, connection refused | Retries after 1, 2, 4, 8 minutes (or the platform's wait time), up to 5 attempts |
| Uncertain | Timeout or dropped connection after sending, server error on create | Never retries. Asks a person to check the account, then **Retry now** or **It did post** |
| Sign-in | Token expired or revoked | Marks the account **Reconnect needed**; retries are refused until it's reconnected |
| Permission | The account can't post to the Page | Stops; a person fixes the role and retries |
| Rejected | Platform refuses the content | Stops; the post must be changed and approved again |
| Stranded | Worker died mid-send (15 min) | Stops; a person checks the account. Never resent |

Pause switches, from widest to narrowest:

| Switch | Who | Where |
|---|---|---|
| Platform-wide | Platform admin | `UPDATE platform_settings SET global_paused = true` |
| One client | Owner or operator | Connections → **Pause all publishing** |
| One channel | Owner or operator | Connections → **Pause this channel** |

A post that misses its time by more than a day while paused isn't sent late; it returns to the approved list with the reason.

### Turning on live publishing

All three must be true, otherwise every send is a dry run:

1. `PUBLISH_MODE=live` on the worker.
2. A platform admin enables the client: `UPDATE tenants SET publishing_enabled = true WHERE slug = '...'`.
3. The account is connected and its **Test connection** succeeds.

## Running in production

1. **Database.** Apply `packages/db/migrations/*.sql` in order as the schema owner. Create two login roles:

   ```sql
   CREATE ROLE jat_web LOGIN PASSWORD '...' IN ROLE app_user;
   CREATE ROLE jat_publisher LOGIN PASSWORD '...' IN ROLE publisher_user;
   ```

   | Role | Used by | Can |
   |---|---|---|
   | `app_user` | Web process | Read and write the current client's data; store credentials but never read them |
   | `publisher_user` | Worker | Everything `app_user` can, plus read credentials |
   | `jat_scheduler` | Worker (switches to it briefly) | See only ids, client ids and times of due work across clients |

   None of them bypasses Row-Level Security.

2. **Web process.**

   ```bash
   NODE_ENV=production JAT_PROCESS=web \
   DATABASE_URL=postgres://jat_web:...@host/db \
   SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
   BASE_URL=https://app.example.com \
   ANTHROPIC_API_KEY=... \
   pnpm --filter @jat/web start
   ```

3. **Worker process.**

   ```bash
   NODE_ENV=production JAT_PROCESS=worker \
   DATABASE_URL=postgres://jat_web:...@host/db \
   PUBLISHER_DATABASE_URL=postgres://jat_publisher:...@host/db \
   PUBLISH_MODE=dry_run \
   pnpm --filter @jat/web start
   ```

   Until a KMS key provider exists (VAULT-2), the worker refuses to start with `NODE_ENV=production`. You can try it on a staging box with `NODE_ENV=development` and `LOCAL_KEK_BASE64` set.

Environment variables (see `.env.example`):

| Variable | Process | Required | Purpose |
|---|---|---|---|
| `DATABASE_URL` | both | yes | Connection as a member of `app_user` |
| `SESSION_SECRET` | web | yes | 32+ random bytes, base64 |
| `BASE_URL` | web (and worker, for Facebook) | yes | Public address, e.g. `https://app.example.com` |
| `JAT_PROCESS` | both | yes in production | `web`, `worker`, or `all` (development only) |
| `ANTHROPIC_API_KEY` | web | for AI | Without it, onboarding saves evidence but can't draft |
| `PUBLISHER_DATABASE_URL` | worker | for publishing | Connection as a member of `publisher_user` |
| `PUBLISH_MODE` | worker | no | `live` to send; anything else is dry-run (default) |
| `PUBLISHER_INTERVAL_SECONDS` | worker | no | Dispatcher interval (default 30) |
| `LOCAL_KEK_BASE64` | both | development | Credential encryption key. Production needs a KMS provider (not built yet, VAULT-2) |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_GRAPH_VERSION` | both | for Facebook | Register `{BASE_URL}/oauth/facebook/callback` as the redirect URI |
| `TRUSTED_PROXIES` | web | no | Number of reverse proxies, for client IPs |

Not ready yet for production: sign-in email delivery (AUTH-2), the KMS key provider (VAULT-2), and live tests against each platform. See the [backlog](docs/J-development-backlog.md).

### Connecting accounts

| Channel | What you need | Where |
|---|---|---|
| Bluesky | Handle + an app password (Bluesky → Settings → Privacy and security → App passwords) | Connections → Bluesky |
| Facebook Pages | A Meta app with `pages_manage_posts` approved, and a role on the Page that can create content | Connections → **Connect with Facebook**, then pick the Page |
| WordPress | The JAT Connector plugin, a dedicated user and its Application Password | Connections → WordPress; paste the signing secret it shows into Settings → JAT Connector, then **Test connection** |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Database tests are skipped | Postgres binaries not found | Set `PG_BIN` to the folder containing `initdb` |
| `initdb` refuses to run as root | Postgres safety check | The test harness uses `runuser -u postgres` automatically when run as root |
| Post page says "Dry run (not sent)" | `PUBLISH_MODE` isn't `live`, or the client isn't enabled | See "Turning on live publishing" |
| Can't schedule a post | Image posts aren't supported yet, the channel has no adapter, or the account isn't connected | Use the CSV export, or fix the connection |
| "Reconnect needed" | The platform rejected the stored sign-in | Reconnect the account on Connections, then **Retry now** |
| App refuses to start in production | `JAT_PROCESS` not set, or `LOCAL_KEK_BASE64` used | Run separate `web` and `worker` processes; a KMS provider is required |

## Safety principles (enforced in code, not prompts)

- Tenant isolation is enforced by Postgres RLS; tests prove cross-tenant reads and writes fail.
- Agents produce drafts only. They never hold credentials and cannot approve or publish.
- Approvals are bound to a content hash; any edit invalidates them.
- Global, client and channel pause switches block every publish. A post that misses its time by more than a day while paused is not sent late; a person decides.
- The publisher re-checks everything at send time (approval of the exact content hash, final lint, connection, pauses, mode) and never automatically retries a send that may have reached the platform.
- Generated content may only state facts from the verified claim registry.
