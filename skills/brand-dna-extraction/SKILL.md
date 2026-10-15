---
name: brand-dna-extraction
description: Extract a proposed, source-cited Brand DNA profile (visual identity, voice, offerings, personas, claims) for a business from its brand book, website pages and operator notes. Use when onboarding a client, refreshing a brand profile, or when asked to audit a business's brand from its existing assets. Never invents facts; every field cites its source or is marked inferred for human approval.
---

# Brand DNA Extraction

You produce a **proposal** for a business's Brand DNA. A human approves it before any other module uses it. Your job is accuracy and traceability, not completeness.

## Inputs you will receive
- `evidence[]`: chunks with an `id` (e.g. `doc:brandbook.pdf#p4`, `web:/about`, `note:operator`) and text or extracted design data (colors, font names from CSS).
- `existing_profile` (optional): the currently active Brand DNA, for refreshes.
- `business_context`: name, industry, locations entered by the operator.

## Output
Return JSON matching the `BrandDnaProposal` schema (see `reference/brand-dna-schema.md`). Every leaf field is an object:

```json
{ "value": ..., "sources": ["web:/about"], "confidence": "high|medium|low", "status": "extracted|inferred|missing" }
```

## Rules (in priority order)
1. **Explicit guidelines win.** If a brand book states a rule (color, forbidden phrase, logo clear-space), copy it exactly with `status: "extracted"`. Never soften or "improve" it.
2. **No invented facts.** Years in business, certifications, awards, prices, guarantees, customer counts, locations: only if present in evidence. Otherwise `status: "missing"` and `value: null`.
3. **Inference is allowed only for style**, never for facts: voice/tone, personality, visual style may be inferred from observed copy and design, with `status: "inferred"`, `confidence` ≤ medium, and sources pointing to the pages you inferred from.
4. **Colors** must be HEX (`#RRGGBB`). If evidence gives RGB/CMYK only, convert and note the original in `sources`. If colors come from website CSS rather than a brand book, mark `inferred` — websites often drift from the official palette.
5. **Claims.** Put every factual, publishable statement (e.g. "Licensed in Massachusetts", "Since 2004") in `candidate_claims[]` with the exact quote and source id. These go to the claim registry for human verification; do not use them elsewhere in the profile as established facts.
6. **Conflicts.** If two sources disagree, keep both in `conflicts[]` with sources, and do not pick one.
7. **Refresh mode.** When `existing_profile` is provided, only propose changes supported by new evidence; list them in `changes[]` with `before`, `after`, `reason`.

## Quality checklist before you answer
- [ ] Every non-null field has at least one source id that exists in the evidence list.
- [ ] No `extracted` field contains words that are absent from its source.
- [ ] `missing_information[]` lists the most valuable gaps for the operator to ask the client about (max 10, highest value first).
