# H — Financial Feasibility

**All figures are estimates** (USD, Oct 2026). Model prices are from Anthropic's published pricing on 2026-10-15; infrastructure prices are typical list prices for small managed services and must be confirmed when selecting vendors.

## 1. AI cost per client per month (typical MVP client)

Assumptions: 40 social posts, 4 blog drafts, 1 monthly plan, QA on everything, 1 SEO audit refresh, 1 report, ~50 web searches; Brand DNA (~5k tokens) served from prompt cache; every generation retried/regenerated once on average (×2).

| Job | Model | Tokens per run (in / out) | Runs | Est. cost |
|---|---|---|---|---|
| Post draft | Sonnet 5.5 ($2/$10 per MTok; cache read 0.05×) | 1k fresh + 5k cached / 0.8k | 80 | ~$0.90 |
| Post QA | Haiku 5.5 ($0.10/$0.50) | 6k / 0.4k | 80 | ~$0.07 |
| Blog draft | Sonnet 5.5 | 10k / 4k | 8 | ~$0.48 |
| Monthly plan | Opus 5.5 ($4/$20) | 30k / 15k | 2 | ~$0.84 |
| SEO interpretation | Sonnet 5.5 | 100k / 10k | 2 | ~$0.60 |
| Report narrative | Sonnet 5.5 | 20k / 3k | 2 | ~$0.14 |
| Web search tool | $10 per 1,000 | — | 50 | $0.50 |
| **Total** | | | | **≈ $3.50 / client / month** |

Onboarding (one-time Brand DNA extraction, ~200k in / 10k out on Opus): ≈ $1. Using the Batches API for plans/audits halves those lines. **Budget cap default: $15/client/month** (~4× headroom). The ×2 covers retries/regeneration only; the token estimates above already assume current-generation tokenizers, which produce ~30% more tokens than older models for the same text — the budget cap absorbs any further variance.

## 2. Infrastructure (fixed, pilot to ~50 clients)

| Item | Est. monthly |
|---|---|
| Managed Postgres (with PITR backups) | $25–70 |
| Web + worker containers (2 small, 1 renderer with Chromium) | $30–80 |
| Object storage + egress (R2) | $5–15 |
| Error tracking / logs | $0–30 |
| Transactional email (magic links) | $0–20 |
| KMS | ~$1–5 |
| **Total** | **≈ $60–220** |

At 20 clients → ~$3–11 infra per client. Variable platform fees: X API only if enabled ($0.015/post, $0.20 with link) — passed through.

## 3. Development effort (estimate)
MVP ≈ 12 weeks × 1.5 FTE ≈ 18 dev-weeks. At an internal cost of $1,500–2,500/dev-week ≈ **$27k–45k** opportunity cost. Ongoing maintenance (API version churn: LinkedIn monthly versions, Meta Graph versions, Google quota changes) ≈ 15–25% of one developer.

## 4. Pricing options (hypotheses to test in pilot)

| Segment | Model | Price (est.) | Includes |
|---|---|---|---|
| Solo business | Done-for-you | $399–499/mo | 3 channels, ~12 posts, 1 blog, monthly report |
| Small business | Done-for-you | $899–1,199/mo | 5 channels, ~30 posts, 4 blogs, SEO snapshot, review portal |
| Multi-location | Done-for-you | base $1,500 + $250–350/location | per-location GBP posts & local pages |
| Agency (self-serve SaaS, later) | Per workspace | $149–299/workspace/mo + AI overage | Agency runs the platform |
| White-label partner (later) | Platform fee + per workspace | $1,500/mo + $99/workspace | Custom domain, branding |

## 5. Unit economics (done-for-you, small business tier, estimate)

| Line | Per client/month |
|---|---|
| Revenue | $999 |
| AI + infra + tools | ~$15–25 |
| Operator time (3 h × $45 loaded) | $135 |
| Support & account management (1 h) | $45 |
| **Contribution margin** | **≈ $790–805 (≈ 80%)** |

The dominant cost is human time, not AI. The product's job is to keep operator time ≤ 3 h/client/month while holding quality; that is the metric to track in pilot. SaaS margins (agency self-serve) would be higher (~85–90%) but require self-serve onboarding, billing and support — deferred to P2.

## 6. Break-even (estimate)
Fixed: infra ~$150 + share of maintenance dev (~$2,000/mo) ≈ $2,150/mo → **~3 small-business clients** cover running costs; ~35–55 client-months recover the MVP build effort.
