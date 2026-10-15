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
- [ ] **AI-1** `packages/ai`: Anthropic client wrapper with structured outputs, zod re-validation, one repair retry, prompt caching of brand block. *AC:* unit tests with mocked SDK.
- [ ] **AI-2** Cost ledger + per-tenant budget guard (reject before call when projected spend > remaining budget).
- [ ] **AI-3** Skill loader: reads `skills/<name>/SKILL.md` + references into system prompt; snapshot test.
- [ ] **AI-4** Brand agent using `brand-dna-extraction`; fixture eval on 5 businesses.
- [ ] **INGEST-1** robots.txt-aware crawler (≤50 pages, same-origin, 1 req/s), extract text, CSS colors and font families.
- [ ] **INGEST-2** PDF brand-book extraction (text + embedded color values) into `sources`.
- [ ] **WEB-1** Next.js app shell, Auth.js (magic link + Google), workspace switcher, roles middleware.
- [ ] **WEB-2** Brand DNA diff & field-by-field approval UI.
- [ ] **WEB-3** Claims & evidence UI.

## Phase 3 — Plan, studio, approvals
- [ ] **AI-5** Planning agent (`campaign-planning`), 30-day plan.
- [ ] **WEB-4** Calendar month/week/day with drag-and-drop rescheduling.
- [ ] **AI-6** Post drafting agent (`social-post-drafting`) + QA agent (`compliance-review`).
- [ ] **APPR-1** Approval service (hash binding, batch approve excluding high risk).
- [ ] **WEB-5** Client review portal via magic link.
- [ ] **E2E-1** Playwright: plan → draft → approve → edit invalidates approval.

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
