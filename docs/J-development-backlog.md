# J — Executable Development Backlog

Each item is written to be pasted into a GitHub Issue or given to Claude Code. `✅` = done in the Phase 1 PR that introduced this file.

## Phase 0 — Setup
- [ ] **SETUP-1** Register Meta app, complete business verification, request Pages + Instagram permissions. *AC:* app ID & submission ID recorded in `docs/ops/approvals.md`.
- [ ] **SETUP-2** LinkedIn developer app + Community Management API (Development tier) application.
- [ ] **SETUP-3** Google Cloud project; enable Search Console, Analytics Data, CrUX, PageSpeed, Business Profile APIs; OAuth consent screen to production + verification.
- [ ] **SETUP-4** GBP API access application.
- [ ] **SETUP-5** Publish privacy policy, terms, data-deletion page on JAT domain.
- [ ] **SETUP-6** CI: GitHub Actions running typecheck + unit + DB tests on PR. *Workflow file added in the Phase 1 PR but not yet observed passing; commit a `pnpm-lock.yaml` and switch to `--frozen-lockfile` after the first successful install.*

## Phase 1 — Foundation
- [x] ✅ **CORE-1** pnpm monorepo, strict TypeScript, zero-dependency test runner (`node:test` via tsx).
- [x] ✅ **CORE-2** Brand DNA zod schema with field provenance; activation guard (no un-confirmed `inferred` fields).
- [x] ✅ **CORE-3** Claim registry types + `usableClaims()` (verified & unexpired).
- [x] ✅ **CORE-4** PostDraft schema (all §5 fields) + platform limits table.
- [x] ✅ **CORE-5** Deterministic linter: length, forbidden phrases, unregistered claim ids, missing alt text, disclosure, hashtag caps, UTM validity, engagement bait patterns.
- [x] ✅ **CORE-6** UTM builder.
- [x] ✅ **CORE-7** Approval policy engine (modes × risk × action) + publish gate.
- [x] ✅ **CORE-8** Content state machine with audit events.
- [x] ✅ **CORE-9** Canonical content hashing.
- [x] ✅ **VAULT-1** Envelope encryption (AES-256-GCM, AAD, KEK provider interface, local provider).
- [x] ✅ **DB-1** SQL schema for all MVP tables (composite tenant foreign keys, state/immutability constraints).
- [ ] **DB-1b** Drizzle typed schema mirroring the SQL migration (Phase 2, with the web app).
- [x] ✅ **DB-2** SQL migration with RLS (`FORCE`), app role, append-only audit log.
- [x] ✅ **DB-3** RLS isolation tests against a real throwaway Postgres 16 cluster (16 tests; mutation-checked by disabling RLS).
- [~] **DB-4** `withTenant()` helper written and unit-tested with a mock client; *remaining:* node-postgres pool wiring + integration test through a real `pg` client.
- [ ] **CORE-10** Near-duplicate detection (character shingles + Jaccard) for hooks/bodies over 60-day window.

## Phase 2 — AI & Brand DNA
- [x] ✅ **AI-1** `packages/ai`: Messages API client over fetch (no SDK dependency), native structured outputs with a wire-schema converter that enforces the documented limits, zod re-validation, one repair turn, prompt caching (instructions, tenant context, user content), refusal/max_tokens handling, retry policy (no retry on timeouts).
- [x] ✅ **AI-2** Cost ledger + per-tenant budget guard, serialized per tenant so parallel jobs can't overspend; append-only `agent_runs` with month-to-date SQL tested on Postgres.
- [ ] **AI-2b** Postgres `SpendLedger` adapter (advisory lock + `insertAgentRun`) wired to a real `pg` pool.
- [x] ✅ **AI-3** Skill loader with frontmatter validation; every repo skill is tested.
- [~] **AI-4** Brand agent using `brand-dna-extraction`: flat wire schema (29 fields, no unions) rebuilt into Brand DNA, grounding checks (unknown sources, values/quotes not found in sources), injection-safe evidence rendering. *Remaining:* live eval on 5 real businesses (needs an API key; nothing has been sent to the real API yet).
- [x] ✅ **INGEST-1** Crawler: RFC 9309 robots.txt per origin, SSRF guard (incl. IPv4-in-IPv6 forms) with DNS-pinned sockets, per-hop redirect checks, request/queue caps, linear-time HTML extraction, colors + fonts, evidence chunks. *Not yet run against live websites.*
- [ ] **INGEST-2** PDF brand-book extraction (text + embedded color values) into `sources`.
- [x] ✅ **WEB-1** App shell (server-rendered, no framework — see B §1), magic-link sign-in, signed sessions with sign-out-everywhere, CSRF + Origin checks, security headers, workspace switcher, role checks. 159 tests incl. end-to-end flows on real Postgres; screenshots reviewed in Chromium (light, dark, mobile).
- [ ] **AUTH-2** Production email delivery for sign-in links (Postmark/SES/Resend) — `main.ts` refuses to send in production until configured.
- [ ] **AUTH-3** Google/Microsoft OIDC sign-in; MFA for operators.
- [ ] **WEB-1b** Verify `pg-database.ts` (node-postgres adapter) in CI against Postgres — not runnable in the build sandbox.
- [ ] **JOB-0** Durable jobs: in-process queue loses runs on restart; mark interrupted runs failed on boot and move to pg-boss (JOB-1).
- [x] ✅ **WEB-2** Brand DNA onboarding (crawl → AI proposal) and field-by-field review: provenance per field, confirm/edit, activation only by the owner, blocked until inferred fields are confirmed, approval bound to a content fingerprint, row-locked activation. *Remaining:* side-by-side diff against the previous version.
- [x] ✅ **WEB-3** Claims registry UI: add with evidence, owner-only verification, rejection, expiry dates; onboarding suggests claims whose quotes were found verbatim.

## Phase 3 — Plan, studio, approvals
- [x] ✅ **AI-5** Planning agent (`campaign-planning`): 30/60/90-day plans; every slot validated in code (dates, enabled channels, formats, pillars, personas, weekly caps, registered offers), soft warnings for pillar/promo balance.
- [x] ✅ **WEB-4** Channel settings, month calendar, campaign page with move/remove before drafting. *Remaining:* week/day views and drag-and-drop.
- [x] ✅ **AI-6** Drafting agent (`social-post-drafting`, slot-fixed fields + UTM links built in code) and AI reviewer (`compliance-review`); deterministic lint on every version; AI blockers carry over human edits until "Re-check with AI".
- [x] ✅ **APPR-1** Approvals bound to content hashes; batch approve skips high risk and changed posts; posts using testimonial/statistic/award claims are owner-only; request changes with comments; CSV export (formula-safe) and "mark as posted".
- [x] ✅ **WEB-5** Client review: owners and reviewers sign in with magic links and use the Approvals page (no separate portal needed).
- [x] ✅ **E2E-1** End-to-end test on real Postgres: plan → approve → draft → batch approve → edit invalidates approval → re-check → export.
- [ ] **TZ-1** Per-client time zone (currently US Eastern for everyone); spring-forward non-existent times map to the hour before.
- [ ] **JOB-0b** Durable queue: jobs survive restarts only as "interrupted" (15-minute heartbeat); move to pg-boss.

## Phase 4 — Publishing
- [ ] **JOB-1** Worker with pg-boss: cron for due slots, retries, singleton keys.
- [ ] **PUB-1** Publisher implementing the safety checks in `I-testing-security.md` §3.
- [ ] **PUB-2** Pause controls (global/tenant/channel) + UI.
- [ ] **WP-1** JAT Connector plugin: HMAC auth, `/jat/v1/health`, `/posts` draft/schedule.
- [ ] **WP-2** SEO meta adapters for Yoast, Rank Math, AIOSEO + snapshots + rollback.
- [ ] **WP-3** Docker test matrix (WordPress + each SEO plugin) in CI.
- [ ] **ADP-1** Facebook Pages adapter (OAuth, page selection, publish, schedule, delete, insights).
- [ ] **ADP-2** Bluesky adapter (app password, posts with images and link facets).
- [ ] **ADP-3** Export package (ZIP + CSV) + "mark as posted".
- [ ] **INT-1** Connections page with live capability display and token health job.

## Phase 5 — Creative, SEO, reporting
- [ ] **CRE-1** HTML template renderer (Playwright) with brand tokens; 1:1, 4:5, 9:16, 1.91:1 crops.
- [ ] **SEO-1** Site crawler (≤200 pages) + CrUX + PSI + GSC connectors; `seo-page-audit` interpretation.
- [ ] **RPT-1** Monthly report generator (web + PDF export), "not available" metric handling.

## Phase 6 — Pilot hardening
- [ ] **SEC-1** Security checklist review; MFA for operators; dependency audit.
- [ ] **OPS-1** Backup restore drill; runbooks (incident, token revocation, rollback).
- [ ] **OPS-2** k6 load test of scheduling fan-out.
