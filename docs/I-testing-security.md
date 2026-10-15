# I — Testing & Security Strategy

## 1. Approval policy (enforced in `packages/core/src/policy/approval-policy.ts`)

| Action | Manual | Assisted | Autonomous (gated, P2) |
|---|---|---|---|
| Draft / research / plan generation | auto | auto | auto |
| Publish **low**-risk organic post | approval | approval, unless it uses a client-pre-approved template + pillar pattern → auto-scheduled with a **24 h veto window** (reviewers notified) | pre-approved pattern → auto, no veto window (eligible tenants only; ineligible tenants are treated as Assisted) |
| Publish **medium**-risk post | approval | approval | approval |
| Publish **high**-risk post | approval | approval | approval |
| WordPress: create draft | auto | auto | auto |
| WordPress: publish / update live page / change SEO meta on live page | approval | approval | approval |
| Brand DNA activation, claim verification | approval | approval | approval |
| **Always separately authorized** (any mode): paid ads, financial commitments, irreversible deletes, major brand changes, sensitive/regulated claims | owner approval | owner approval | owner approval |

Additional hard rules: approvals bind to the content hash; global/tenant/channel pause blocks every publish regardless of approval; `publishing_enabled` must be true for the tenant; `PUBLISH_MODE=live` must be set in the environment.

## 2. Test pyramid

| Layer | Tooling | What it covers | Gate |
|---|---|---|---|
| Unit | `node:test` (via tsx) | Schemas, policy engine, state machine, linter, UTM, vault, platform limits | Every PR; `core` ≥ 90% lines |
| Database | `node:test` + throwaway real Postgres cluster (`packages/db/test/pg-harness.ts`) | Migrations apply; **RLS isolation**; audit log append-only; unique idempotency keys | Every PR |
| Contract | Recorded fixtures (nock/msw) per adapter | Request shapes, error mapping (transient vs permanent), token refresh | Every PR |
| AI eval | Golden fixtures + scorers | Schema validity, claim grounding, linter blockers, voice rubric | Nightly + on `skills/**` change |
| E2E | Playwright | Onboard → plan → draft → approve → publish (dry-run) → report | Nightly + pre-release |
| Staging integration | Real APIs, JAT-owned accounts | Each adapter publish/delete/metrics; WP plugin on 3 SEO-plugin test sites | Before enabling a channel in production |
| Load | k6 | 500 tenants × 40 slots/month scheduling fan-out; queue latency | Pre-pilot |

## 3. Publishing safety checks (in order, every publish)
1. Global pause → tenant pause → channel pause.
2. `PUBLISH_MODE` and tenant `publishing_enabled`.
3. Approval exists, not revoked, and `approval.content_hash == revision.content_hash`.
4. Linter re-run on the final payload: zero blockers.
5. Integration `status = connected`, capability present, token valid (refresh if < 10 min).
6. Idempotency key (`publication_id`) unused at the platform where supported, and `publications` row locked `FOR UPDATE SKIP LOCKED`.
7. Rate/quota headroom available; otherwise reschedule.
8. Call → persist result → audit.

## 4. Error recovery
- Transient — only when nothing can have reached the platform (429/rate-limit codes, DNS failure, connection refused, TLS errors): exponential backoff (1, 2, 4, 8 min, or the platform's Retry-After if longer), max 5 attempts, then `needs_attention`.
- Permanent (4xx validation, policy blocks, blocked host): no retry; `needs_attention`.
- **Ambiguous** (timeout or dropped connection after the request was sent, 5xx on a create, unknown errors): never retried automatically. The post page tells the person to check the account, then either "Retry now" or "It did post — mark as posted". *Automatic reconciliation (list recent posts and match) is not built yet.*
- Stranded (worker died mid-send; `publishing` for 15 min): `needs_attention`, never resent; a late success is still recorded as published.
- Token revoked (`auth`): integration set to `needs_reauth`; retries are refused until the account is reconnected.

**As built (Phase 4):** steps 1–6 and 8 of §3 run in `apps/web/src/publisher.ts` through `evaluatePublishGate()`; the row is locked `FOR UPDATE SKIP LOCKED` and set to `publishing` (committed) before the call. Step 7 (quota headroom) is not implemented; rate limits are handled reactively as transient errors. Platform-side idempotency keys are not available on Bluesky or Facebook (see `docs/research/2026-10-publishing-apis.md`).

## 5. Security controls

| Control | Implementation |
|---|---|
| Tenant isolation | Postgres RLS with `FORCE`; app role without `BYPASSRLS`; tenant-scoped transaction helper; automated cross-tenant tests |
| Least privilege | Minimal OAuth scopes per capability; WP connector uses a dedicated Editor-level user; admin routes separated |
| Credentials | AES-256-GCM with a fresh data key per secret, wrapped by a KMS KEK; only the `publisher_user` DB role can read the table; AAD binds ciphertext to tenant+integration; never logged; decrypted only inside publisher |
| Secret rotation | KEK rotation re-wraps DEKs (no data re-encryption); WP HMAC secrets rotatable with overlap window |
| Webhooks | Verify HMAC signatures (Meta `X-Hub-Signature-256`, etc.) with constant-time compare; reject stale timestamps |
| Audit | Append-only `audit_log` (UPDATE/DELETE revoked from app role) |
| AI safety | Prompt-injection posture: web/PDF evidence is data, wrapped and labelled; agents have no tools that write; outputs schema-validated |
| Privacy | Data minimization (no order PII stored from WooCommerce); DSAR export/delete; DPA with sub-processors (Anthropic, hosting, storage) |
| Backups / DR | Managed PITR (RPO ≤ 24 h, target 5 min), quarterly restore drill, RTO ≤ 4 h |
| Supply chain | Lockfile, Dependabot, `pnpm audit` in CI, pinned GitHub Actions |
| AuthN | Magic links (15-min single use) + OIDC; MFA required for operators/admins |

## 6. Compliance checklist
- FTC endorsement disclosures and 2024 Consumer Reviews & Testimonials Rule → linter + compliance-review skill.
- Copyright: assets require `license` metadata; competitor content never copied (similarity check vs. competitor corpus in P1).
- Privacy: CCPA/CPRA, Massachusetts 201 CMR 17.00 (WISP for personal information of MA residents), GDPR if EU clients.
- Email consent (CAN-SPAM; we only draft email copy in MVP).
- Platform terms: official APIs only; no browser automation of platforms.
- Accessibility: alt text required; WCAG 2.2 AA dashboard.
