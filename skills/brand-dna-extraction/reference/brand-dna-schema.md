# Brand DNA schema reference

The canonical schema is code: `packages/core/src/brand/brand-dna.ts` (zod). This file explains intent.

## Sections

### identity
- `legal_name`, `display_name`, `tagline`, `industry`, `founded_year` (fact → evidence required)
- `locations[]`: address, service area (cities/ZIPs/radius), hours (fact)

### visual
- `colors[]`: `{ name, hex, role: primary|secondary|accent|neutral|background|text, usage_notes }`
- `typography[]`: `{ family, role: heading|body|accent, weights[], fallback }`
- `logo_rules`: clear space, minimum size, forbidden treatments
- `photography_style`, `illustration_style`, `iconography`, `layout_notes`

### voice
- `personality[]` (3–5 adjectives), `tone_by_context` (e.g. educational vs promotional)
- `vocabulary.preferred[]`, `vocabulary.avoid[]`
- `forbidden_phrases[]` — hard blocks used by the linter
- `preferred_ctas[]`
- `reading_level` (target grade), `emoji_policy`, `hashtag_policy`

### strategy
- `messaging_pillars[]`: `{ id, name, description, proof_claim_ids[] }`
- `offerings[]`: `{ name, description, price_note?, url? }`
- `personas[]`: `{ id, name, description, goals[], objections[], channels[] }`
- `differentiators[]`, `seasonality[]`, `geo_targets[]`

### compliance
- `industry_restrictions[]` (e.g. health claims, financial promises)
- `required_disclosures[]`
- `accessibility`: alt text required (always true), contrast minimum

## Provenance
`status = extracted` — copied from a source.
`status = inferred` — a style judgment; must be human-confirmed before activation.
`status = missing` — needed but not found.
