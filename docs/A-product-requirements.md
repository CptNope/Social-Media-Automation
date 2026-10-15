# A — Product Requirements Document: JAT Marketing OS

Status: Draft v0.1 · Owner: Jeremy Anderson Tech · Last updated: 2026-10-15

## 1. Problem

Small and local businesses know they should market consistently across their website, search and social channels, but they lack time, brand discipline and expertise. Agencies that serve them burn most of their hours on repetitive drafting, resizing, scheduling and reporting. Generic AI tools produce off-brand, fact-free content that owners don't trust.

## 2. Product statement

JAT Marketing OS is a multi-tenant platform that learns a business's brand and facts once (Brand DNA + Claim Registry), then plans, drafts, quality-checks, schedules, publishes and reports on marketing across website and social channels — with a human approval workflow at every step that carries risk.

## 3. Users and roles

| Role | Who | Primary jobs |
|---|---|---|
| Platform Admin | JAT engineering | Manage tenants, feature flags, platform-wide kill switch, incident response |
| Agency Operator | JAT marketing staff (later: partner agencies) | Onboard clients, run research, generate & edit plans, publish, report |
| Client Owner | Business owner | Approve Brand DNA, approve content, connect accounts, see reports |
| Client Editor | Client marketing staff | Edit drafts, propose changes |
| Reviewer | Client or agency compliance reviewer | Approve/reject; cannot edit or publish |

Permissions are additive per workspace (tenant). One human can hold different roles in different tenants.

## 4. Core workflows (MVP)

### W1 — Onboard a client
1. Operator creates tenant → sets service area, industry, channels.
2. Operator adds sources: website URL, brand book PDF, logos, social profile URLs, competitor URLs, notes.
3. Brand Intelligence job extracts a **proposed** Brand DNA, with every field tagged `source` (`document:p4`, `website:/about`, `operator`, `inferred`) and `confidence`.
4. Fields tagged `inferred` are highlighted; client owner approves or edits → Brand DNA v1 becomes `active`.
5. Operator records claims (facts the business may state) with evidence and optional expiry.

**Acceptance:** No field reaches `active` Brand DNA without either a source citation or explicit human confirmation. Brand DNA versions are immutable; edits create a new version.

### W2 — Plan a month
1. Strategy job reads Brand DNA, claims, goals, seasonal calendar, prior performance → proposes campaigns and a 30-day calendar (slot = channel × date × pillar × objective).
2. Operator edits/reorders/removes slots; approves the plan.

**Acceptance:** Every slot references a pillar and objective from Brand DNA; calendar respects per-channel frequency caps from the channel capability registry.

### W3 — Produce content
1. For each approved slot, Content job drafts the post with all required fields (platform, persona, objective, pillar, hook, body, CTA, hashtags, creative brief, publish window, URL+UTM, expected KPI, source references, verification status).
2. Deterministic linter checks: length limits per platform, forbidden phrases, unregistered claims, required disclosures, link/UTM validity, duplicate similarity.
3. AI QA pass (Compliance agent) re-checks tone, claims, accessibility (alt text present), and outputs findings.
4. Creative job renders template graphics from brand tokens.

**Acceptance:** A post with any `blocker` finding cannot be submitted for approval.

### W4 — Approve
1. Items enter approval queue by risk class (see `I-testing-security.md` §Approval Policy).
2. Client reviewers get a review link; approve/reject/comment per item or in batch.
3. Approval is bound to a **content hash**; any edit after approval invalidates it.

### W5 — Publish
1. Scheduler enqueues publish jobs at the slot time (or uses native scheduling where the API supports it).
2. Adapter checks: connection healthy, capability present, approval valid for current hash, tenant/global pause off, idempotency key unused.
3. On success: store external post ID and permalink. On failure: retry with backoff for transient errors; mark `needs_attention` for permanent errors.
4. Channels without API capability produce an export package instead.

### W6 — Report
Monthly report: what was published, results per channel (only metrics actually available from APIs), SEO snapshot changes, recommendations, pending approvals. Every number shows its source and date range; unavailable metrics are shown as "not available", never estimated silently.

## 5. Functional requirements (prioritized)

`P0` = MVP, `P1` = first expansion, `P2` = later.

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Multi-tenant workspaces with enforced data isolation | P0 |
| FR-02 | Role-based access (5 roles) | P0 |
| FR-03 | Immutable audit log of every state change and external call | P0 |
| FR-04 | Encrypted credential vault (envelope encryption: per-secret data keys wrapped by a KMS key) | P0 |
| FR-05 | Brand DNA schema, versioning, extraction from URL + PDF, approval | P0 |
| FR-06 | Claim & evidence registry | P0 |
| FR-07 | 30-day planner with calendar views (month/week/day) | P0 |
| FR-08 | Post generator with full field set and per-platform variants | P0 |
| FR-09 | Deterministic compliance linter + AI QA | P0 |
| FR-10 | Approval workflow with content-hash binding and client review links | P0 |
| FR-11 | Automation modes: Manual, Assisted | P0 |
| FR-12 | Emergency pause: global, tenant, channel | P0 |
| FR-13 | WordPress connector plugin: drafts, scheduling, SEO meta (Yoast/Rank Math/AIOSEO), snapshots, rollback | P0 |
| FR-14 | Facebook Pages + Bluesky publishing adapters | P0 |
| FR-15 | Export package for non-API channels | P0 |
| FR-16 | Template-based graphic rendering from brand tokens | P0 |
| FR-17 | Website SEO snapshot (crawl ≤200 pages, CrUX/PSI, GSC) | P0 |
| FR-18 | Monthly client report | P0 |
| FR-19 | Per-tenant AI cost ledger and budget caps | P0 |
| FR-20 | Instagram, LinkedIn (org), GBP adapters (pending approvals) | P1 |
| FR-21 | Blog → multichannel repurposing with derivative tracking | P1 |
| FR-22 | Competitor monitoring with change detection | P1 |
| FR-23 | 60/90-day rolling plans | P1 |
| FR-24 | Analytics ingestion & baseline comparisons | P1 |
| FR-25 | Autonomous mode (gated) | P2 |
| FR-26 | TikTok, YouTube, Pinterest, X, Threads adapters | P2 |
| FR-27 | Billing, plans, white-label | P2 |
| FR-28 | AI-answer visibility sampling (GEO) | P2 |

## 6. Non-functional requirements

- **Security:** OWASP ASVS L2 targets; tenant isolation enforced in the database (Postgres RLS), not only in application code.
- **Reliability:** Publish job success ≥ 99% for healthy connections; no duplicate publishes (idempotency).
- **Latency:** Generating a single post ≤ 30 s p95; a 30-day plan ≤ 5 min p95 (background).
- **Cost:** AI cost per MVP client ≤ $15/month at typical volume (see H).
- **Accessibility:** Dashboard meets WCAG 2.2 AA; every generated image includes alt text.
- **Data:** Tenant export (JSON) and deletion within 30 days of request.

## 7. Success metrics

See `00-vision-review.md` §4 (MVP success criteria). Product-level north-star: **approved-and-published assets per operator hour**, with guardrail **zero unregistered claims published**.

## 8. Out of scope (for now)
Paid advertising management, email sending (we draft email copy only), CRM, review-response automation, comment moderation.

## 9. Open questions
1. Will pilot clients accept magic-link-only review access? (Assume yes; validate in pilot.)
2. Which LLM data-retention posture do clients need? (Default: API with no training on inputs; Managed Agents avoided for tenant data because it isn't ZDR-eligible.)
3. Will JAT register as a legal entity eligible for LinkedIn Community Management API? (Required before FR-20.)
