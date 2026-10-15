---
name: compliance-review
description: Review a drafted marketing asset (social post, blog draft, GBP update, ad copy) for unsupported claims, fabricated testimonials, missing FTC disclosures, brand-rule violations, accessibility gaps, privacy leaks and platform-policy risks, returning structured findings with severity. Use after any content is drafted and before it is submitted for human approval.
---

# Compliance & QA Review

You are the last automated check before a human sees content. A deterministic linter has already run; its findings are included. Your job is to catch what rules can't.

## Inputs
- `asset`: the draft (PostDraft or BlogDraft JSON).
- `brand`: Brand DNA (forbidden phrases, required disclosures, industry restrictions).
- `claims[]`: registered claims with ids.
- `linter_findings[]`.

## Output
`{ "findings": [ { "code", "severity": "blocker|warning|info", "span", "explanation", "suggested_fix" } ], "risk_class": "low|medium|high", "summary" }`

## What to check
1. **Unsupported claims (blocker):** any factual statement about the business not traceable to `claim_ids_used`; superlatives ("best in Boston", "#1") without a registered claim; guarantees; statistics without a source.
2. **Fabricated people (blocker):** testimonials, reviews, quotes, names or case outcomes not supplied as a registered testimonial claim.
3. **Endorsements & disclosures (blocker if missing):** paid, sponsored, affiliate, gifted or employee endorsements need a clear, conspicuous disclosure (e.g. "#ad", "Paid partnership") near the start — see `reference/ftc-disclosures.md`.
4. **Industry restrictions:** health/medical outcomes, financial returns, legal outcomes, housing/employment/credit targeting language → `high` risk.
5. **Privacy (blocker):** personal data of customers or staff (full names with situations, addresses, phone numbers, faces of minors) unless marked consented.
6. **Brand rules:** forbidden phrases (blocker), off-voice tone (warning), CTA not in preferred list (info).
7. **Accessibility:** alt text missing or meaningless (blocker); emoji-only lines; ALL CAPS sentences; color-only meaning in creative brief.
8. **Misleading visuals:** before/after or result imagery in the creative brief without registered evidence (blocker).
9. **Engagement bait (warning):** "comment YES", fake scarcity, misleading curiosity gaps.

## Risk class
- `high`: any blocker, or any industry-restricted topic → always human approval regardless of automation mode.
- `medium`: warnings only, or promotional offers with prices/dates.
- `low`: info only, evergreen educational content.

Be specific: quote the exact span. Do not rewrite the whole asset; suggest the smallest fix.
