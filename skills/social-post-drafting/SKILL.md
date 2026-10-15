---
name: social-post-drafting
description: Draft one platform-specific social media or Google Business Profile post for a planned calendar slot, using the client's approved Brand DNA and registered claims only. Use when generating posts, captions, short-video scripts, carousel copy or creative briefs for Facebook, Instagram, LinkedIn, Threads, Bluesky, X, Pinterest, TikTok, YouTube Shorts or Google Business Profile.
---

# Social Post Drafting

You write one post for one slot. Output must match the `PostDraft` JSON schema exactly.

## Inputs
- `brief`: channel, format (text/image/carousel/video_script/story), pillar id, objective, persona id, publish window, destination URL.
- `brand`: active Brand DNA (voice, forbidden phrases, CTAs, pillars, personas).
- `claims[]`: registered claims `{id, text}` — the **only** facts you may state about the business.
- `recent_hooks[]`: hooks used in the last 60 days — do not reuse or closely paraphrase them.

## Required output fields
`channel, format, persona_id, objective, pillar_id, hook, body, cta, hashtags[], creative_brief, alt_text, publish_window, link {url, utm}, expected_kpi, claim_ids_used[], external_sources[], verification_status`.

## Rules
1. **Facts:** Any statement about the business (experience, credentials, prices, results, guarantees) must come from `claims[]`, and its id must appear in `claim_ids_used`. General industry knowledge must either be common knowledge or listed in `external_sources` with a URL; otherwise set `verification_status: "needs_verification"`.
2. **No fabricated people.** Never invent testimonials, reviews, customer names, quotes or case studies. If the slot is a testimonial slot and no real testimonial is supplied, write a post that *invites* reviews instead and say so in `notes`.
3. **Platform fit.** Follow `reference/platform-specs.md`. Adapt — do not paste the same caption across channels.
4. **Voice.** Use `brand.voice`. Never use `forbidden_phrases`. Prefer `preferred_ctas`.
5. **Useful, not bait.** No "comment YES", no fake urgency, no clickbait questions with no payoff, no engagement pods language.
6. **Hashtags:** follow `brand.voice.hashtag_policy`; 0 on LinkedIn/Facebook by default unless policy says otherwise; ≤ 5 on Instagram; none on GBP.
7. **Creative brief:** describe the graphic for a *template renderer*: headline text (≤ 8 words), supporting text, which brand template, image subject. Never ask an image model to render text.
8. **Alt text:** always present, describes the image content in ≤ 125 characters, no "image of".
9. **Disclosures:** if the brief marks the post as sponsored, affiliate or a material connection, include the required disclosure at the start of the body.
10. **UTM:** `utm_source` = channel, `utm_medium` = `social` (or `organic_local` for GBP), `utm_campaign` = campaign slug from the brief, `utm_content` = slot id.
