# 00 — Critical Review of the JAT Marketing OS Vision

This review answers steps 1–3 of §21 of the master prompt: evaluate the vision, recommend improvements, and define the smallest commercially useful MVP. It is grounded in the API research in `docs/research/2026-10-api-research.md`.

## 1. What the vision gets right

- **Brand DNA as the shared source of truth.** A versioned, structured profile that every generator reads is the single most important design decision. It is what separates this from "ChatGPT with a scheduler."
- **Human approval as a first-class concept.** Automation modes (Manual / Assisted / Autonomous) with hard carve-outs for paid ads, sensitive claims and irreversible changes map well onto how agencies actually de-risk work with clients.
- **Official APIs over scraping, manual export as fallback.** Correct, and the research shows this fallback is not an edge case — it is the *primary* path for several channels during the first months (see §3).
- **Verified vs. estimated vs. hypothesis labelling.** This is a genuine product differentiator in a market full of fabricated "AI SEO scores."

## 2. Where the vision is risky or under-specified

| # | Issue | Why it matters | Recommendation |
|---|---|---|---|
| 1 | **Scope is ~17 modules and 12 agents.** | A solo/small team building all of it before revenue will not ship. | Ship a narrow, agency-operated MVP (§4). Treat the 12 agents as a *role taxonomy*, not 12 services. |
| 2 | **Platform approvals are the critical path, not code.** | LinkedIn Community Management API, Meta Advanced Access, TikTok audit and Google Business Profile access each take weeks and can be refused. | Start applications in week 1. Design every channel adapter to degrade to "export package" when a capability is missing. |
| 3 | **"Autonomous Mode" is a liability before there's evidence.** | One off-brand or false post on a client account costs the client relationship. | Disable Autonomous Mode until a tenant has ≥60 days of Assisted history with a low rejection rate, rollback tested, and a signed policy. Ship Manual + Assisted first. |
| 4 | **GEO is partly unmeasurable.** | Google says there are *no* special requirements or files for AI Overviews and that Search ignores llms.txt; FAQ rich results disappeared 2026-05-07. Selling "GEO optimization" as guaranteed inclusion is misleading. | Position GEO as entity consistency + content quality + *measured sampling* of AI answers where terms permit. Label all GEO outputs as hypotheses. |
| 5 | **X API economics changed.** | Pay-per-use: $0.20 per post containing a URL. A UTM-link-heavy strategy costs real money per post. | Pass through X costs as metered usage; default X strategy to fewer, higher-value posts. |
| 6 | **Learning loop needs volume.** | A small business posts ~15–40 times/month; most "experiments" will be underpowered. | Pool learnings across tenants only on anonymized, opt-in, aggregate features; within a tenant, report descriptive comparisons and confidence, not causal claims. |
| 7 | **Creative rendering.** | LLM-generated text inside AI images is unreliable. | Render text with deterministic templates (HTML/SVG → PNG) using Brand DNA tokens; use image generation only for backgrounds/photography, never for copy. |
| 8 | **WordPress SEO writes.** | Yoast and Rank Math do not support REST writes; AIOSEO does. Core has no revision-restore endpoint. | The JAT Connector plugin is mandatory, and it owns before/after snapshots and rollback. |
| 9 | **n8n in the core.** | Adds a second runtime, a second auth model and a second audit trail, and its Sustainable Use License limits commercial redistribution/hosting for others (have counsel review before embedding it in a client-facing product). | Keep the orchestration in our own job queue. Offer n8n later as an optional *outbound* integration (webhooks), not as the engine. |
| 10 | **Billing, white-label, 17-module dashboard** listed at the same priority as content generation. | Spreads effort away from the value proposition. | Defer to Phase 5+. Use Stripe for billing when it arrives. |

## 3. Missing capabilities worth adding

1. **Claim & evidence registry.** Every factual claim a client is allowed to make (e.g., "family-owned since 1998", "licensed in MA") is stored with its evidence and expiry. Generated content may only assert registered claims; anything else is flagged by the Compliance agent. This is the mechanism that makes "never invent brand facts" enforceable rather than aspirational.
2. **Client review portal.** Clients approve via a link (magic-link auth), not by logging into the full agency dashboard. Most SMB owners won't learn a new tool.
3. **Channel capability registry.** A data-driven table of what each adapter can do *right now* for *this* connection (publish types, native scheduling, analytics). The UI and planner read it, so we never promise an unavailable action.
4. **Cost ledger per tenant.** Token usage, web searches, and X post fees are recorded per job so pricing tiers are based on real data.
5. **Content fingerprinting.** Near-duplicate detection (shingling/embeddings) across a tenant's history to stop repetition and cannibalization, as §10 requires.
6. **Incident playbook.** Pause-all kill switch, "unpublish / delete post" capability per adapter where the API allows, and a templated client notification.

## 4. The smallest commercially useful MVP

**Who buys it first:** Jeremy Anderson Tech itself, operating it as a *done-for-you service* for 3–5 local SMB clients. The operator is JAT staff; clients only review and approve. This avoids self-serve onboarding, billing and app-review blockers on day one, and it gets revenue earlier.

**Value delivered:** "Every month, a brand-consistent, fact-checked 30-day content plan with ready-to-post copy and graphics for each channel, blog drafts placed in your WordPress, and a one-click approval link — and a monthly report of what happened."

**In scope (MVP):**
1. Tenants, users, roles, audit log, encrypted credential vault.
2. Brand DNA: guided intake + extraction from website URL and uploaded PDF brand book → proposed profile → human approval → versioned.
3. Claim & evidence registry.
4. Content Studio: generate posts for Facebook, Instagram, LinkedIn, Google Business Profile, Bluesky (+ blog drafts), each with all fields in §5 of the brief, validated by a deterministic compliance linter and an AI QA pass.
5. 30-day calendar with approval workflow (Manual + Assisted modes only) and client review links.
6. Publishing: **WordPress drafts/scheduled posts via the JAT Connector** and **Facebook Pages + Bluesky via API**; every other channel via **export package** (copy + images + UTM links + schedule CSV).
7. Website SEO snapshot: crawl of up to ~200 pages (titles, meta, canonicals, status codes, headings, image alt) + CrUX/PSI + Search Console query data where connected.
8. Monthly report (what was done, what's recommended, what needs approval).

**Explicitly out of MVP:** Autonomous mode, paid ads, billing/Stripe, white-label, TikTok/YouTube/Pinterest/X API publishing, competitor change-tracking, cross-tenant learning, AI video generation.

**MVP success criteria (measurable):**
- 3 paying pilot clients onboarded within 12 weeks of Phase 1 start.
- Brand DNA approved with ≤ 2 revision rounds for ≥ 80% of clients.
- ≥ 85% of generated posts approved with no or light edits (≤ 20% of characters changed).
- 0 published posts containing unregistered factual claims (measured by post-hoc audit of 100% of published items in pilot).
- Operator time per client per month ≤ 3 hours (vs. ~10–15 manual).
- 100% of publish actions traceable to an approval record and an audit log entry.
- AI + infrastructure cost per pilot client ≤ $25/month (see `H-financial-feasibility.md`).
