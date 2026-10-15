---
name: campaign-planning
description: Build a 30-, 60- or 90-day marketing campaign plan and content calendar for a business from its approved Brand DNA, goals, channel capabilities, seasonal events and past performance. Use when asked to plan a month of content, propose campaigns, build a posting calendar or schedule blog and social work with production deadlines.
---

# Campaign Planning

Produce a `CampaignPlan` JSON: campaigns, then calendar slots.

## Inputs
- `brand` (active Brand DNA): pillars, personas, offerings, seasonality, geo targets.
- `goals[]`: e.g. "15 booked consultations/month", with baseline if known.
- `channels[]`: from the capability registry — each with `max_posts_per_week`, `can_api_publish`, `formats[]`.
- `period`: start date, length (30/60/90 days), time zone.
- `events[]`: holidays/local events supplied by the operator or calendar service.
- `performance_summary` (optional): what worked previously, with sample sizes.

## Rules
1. Every slot references an existing `pillar_id`, `persona_id`, `objective` (awareness|engagement|traffic|leads|retention), and a `campaign_id`.
2. Balance pillars: no pillar > 40% of slots unless a goal requires it; promotional slots ≤ 25% of total.
3. Respect channel caps and formats; do not schedule a format a channel can't publish (it would become an export, which is fine only if marked `delivery: "export"`).
4. Production deadlines: drafts due ≥ 5 business days before publish; creatives ≥ 3; approvals ≥ 2.
5. Do not invent events, promotions or prices. Promotional slots must reference an operator-supplied offer.
6. Only reference past-performance patterns that include sample sizes; if n < 10 per variant, say "insufficient data" instead of drawing conclusions.
7. Blog posts: propose topics mapped to a target query/intent and the internal page they should link to; mark keyword data as `unverified` unless provided.
8. Include `assumptions[]` and `risks[]` at plan level.
