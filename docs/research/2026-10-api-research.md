# API & Platform Research Notes — verified 2026-10-15

These notes are the evidence base for the Integration Feasibility Matrix (`docs/D-integration-feasibility.md`).
Everything here was checked against official documentation on 2026-10-15 unless marked **UNVERIFIED**.
Platform APIs change often; re-verify before building each adapter (Implementation Rule #1).

---

## Social platforms

### Facebook Pages (Meta Graph API)
- Auth: Facebook Login for Business → long-lived User token (~60 days) → Page token (no expiry when derived from a long-lived User token, but can be invalidated by password change, role removal, etc.). No server-side auto-refresh.
- Publish permissions: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` (+ `publish_video` for video). Insights: `read_insights`.
- App Review: Advanced Access required to manage Pages you don't own. Business Verification likely required — **UNVERIFIED** detail.
- Publish types: text/link (`/feed`), photos, video, Reels (`/video_reels`, 3–90s, 9:16). **Native scheduling supported** (`published=false` + `scheduled_publish_time`, 10 min–30 days).
- Analytics: Page/post insights, 2-year history, 90-day request window; several metrics deprecated in recent versions (e.g. `post_impressions`) — build the metric layer defensively.
- Limits: Reels 30 API posts/24h; Page rate limit based on engaged users.
- Cost: no API fee.
- Docs: developers.facebook.com/docs/pages-api/posts · /docs/graph-api/reference/page/insights · /docs/video-api/guides/reels-publishing · /docs/graph-api/overview/rate-limiting

### Instagram (Instagram Platform)
- Two auth paths: **Instagram Login** (no Facebook Page needed; `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`) or **Facebook Login** (via linked Page; `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`).
- Professional (Business/Creator) accounts only. Advanced Access via App Review for accounts you don't own.
- Publish: single image (JPEG), video, Reels, Stories, carousels up to 10. Media must be on a public URL; containers expire after 24h. **No native scheduling** → our scheduler must fire at publish time.
- Limits: content publishing limit per 24h (docs show both 50 and 100 — query `/content_publishing_limit` at runtime).
- Metrics: `impressions`/`plays` deprecated April 2025 → use `views`.
- Token lifetime for Instagram Login path: **UNVERIFIED** (docs failed to load).
- Docs: developers.facebook.com/docs/instagram-platform/content-publishing · /docs/instagram-platform/insights

### Threads
- OAuth; short-lived 1h → long-lived 60d token, refreshable after 24h (`th_refresh_token`).
- Scopes: `threads_basic`, `threads_content_publish`, `threads_manage_insights`, reply scopes. App Review per permission.
- Publish: text, image, video, carousel (2–20), link attachments; two-step container → publish. No native scheduling. 250 posts/24h. Max 5 links/post (since Dec 2025).
- Insights: views, likes, replies, reposts, quotes, shares; account-level incl. link clicks.
- Docs: developers.facebook.com/docs/threads/posts · /docs/threads/insights · /docs/threads/get-started/long-lived-tokens

### LinkedIn
- 3-legged OAuth. Access tokens 60 days; refresh tokens (365 days, non-extending) **only for approved Marketing Developer Platform partners**.
- Company Page posting: `w_organization_social` via **Community Management API** — access limited to registered legal entities; Development tier (500 calls/app/day, 12-month expiry) then Standard tier (screencast review; may be declined). **Hardest approval in the matrix — apply early.**
- Member posting: `w_member_social` via self-serve "Share on LinkedIn" (150 req/member/day).
- Posts API: text, image, video, document, article, multi-image, poll. Organic carousels not supported. No native scheduling. Versioned headers `Linkedin-Version: YYYYMM` required; versions sunset roughly yearly (202510 sunset 2026-10-15).
- Analytics: organization share statistics (12 months).
- Docs: learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api · /marketing/increasing-access · /marketing/community-management-app-review

### X (Twitter) API v2
- OAuth 2.0 + PKCE; access tokens 2h; refresh with `offline.access`.
- **Pay-per-use pricing (announced Feb 2026):** create post $0.015; **create post containing a URL $0.20**; reads $0.005/post. Free tier effectively removed. Basic/Pro legacy prices **UNVERIFIED**.
- Limits: 100 posts/user/15 min; 10,000/app/24h.
- Implication: pass-through usage billing; every link post costs ~13× a plain post. UTM-tagged link posts must be priced in.
- Docs: docs.x.com/x-api/getting-started/pricing · /x-api/fundamentals/rate-limits

### TikTok Content Posting API
- OAuth; access token 24h, refresh 365d (rotating).
- Scopes: `video.publish` (Direct Post), `video.upload` (inbox draft).
- **Unaudited apps: all posts forced private (`SELF_ONLY`), max 5 users/24h.** Audit enforces strict UX rules (creator nickname, privacy dropdown with no default, interaction toggles off by default, music/branded-content consent, preview). Internal-only tools don't qualify.
- ~15 posts/day/creator across all apps; must call Creator Info before every post. Research API is academic-only (not usable).
- MVP approach: **upload-to-inbox** (creator finalizes in-app) or manual export.
- Docs: developers.tiktok.com/doc/content-posting-api-get-started · /content-sharing-guidelines

### YouTube Data API v3
- Google OAuth; `youtube.upload`; analytics `yt-analytics.readonly`. Refresh tokens expire after 7 days while consent screen is in "Testing".
- `videos.insert` docs now state unverified projects are **not** restricted to private (reversal of the 2020 rule; effective date **UNVERIFIED**).
- Quota: since June 2026, `videos.insert` has its own bucket of 100 calls/day/project. Native scheduling via `status.publishAt`. No Shorts-specific API flag (Shorts guidance **UNVERIFIED** from official docs).
- Docs: developers.google.com/youtube/v3/docs/videos/insert · /v3/revision_history · /v3/guides/quota_and_compliance_audits

### Pinterest API v5
- OAuth; access 30 days; continuous refresh token 60 days (renewable).
- Scopes: `pins:write`, `boards:read`. Business account required.
- Trial access (sandbox-visible only) → Standard access requires video demo. Difficulty low-medium.
- Analytics: 90-day lookback. Standard write limit 100/min/user.
- Docs: developers.pinterest.com/docs/getting-started/access-tiers/ · /docs/reference/rate-limits/

### Bluesky (AT Protocol)
- App passwords (recommended by docs for headless/bot clients) or OAuth (PAR + DPoP). No approval process.
- `com.atproto.repo.createRecord` (`app.bsky.feed.post`), blobs ≤50MB. No native scheduling, no first-party analytics API.
- Limits: 5,000 write points/hour (create = 3).
- **Note:** app passwords are not the account password, but they are still a credential the user pastes — acceptable under our "never ask for passwords" rule only because they are scoped, revocable, and purpose-issued. Prefer OAuth once stable for confidential clients.
- Docs: docs.bsky.app/docs/get-started · atproto.com/specs/oauth

### Google Business Profile
- OAuth `business.manage`. **Access requires an application**; quota is 0 until approved, then 300 QPM. Eligibility: verified profile active 60+ days.
- v4 `localPosts` still supported: STANDARD, EVENT, OFFER, ALERT; `scheduledTime` supported. Per-post insights discontinued 2023. Q&A API discontinued Nov 2025.
- Performance API v1: impressions, direction requests, calls, website clicks, keyword impressions.
- Docs: developers.google.com/my-business/content/posts-data · /content/prereqs · /content/sunset-dates

---

## Website & search

### WordPress REST API
- **Application Passwords** (core since 5.6) over HTTPS = default auth for the connector. OAuth/JWT are third-party plugins only.
- `/wp/v2/posts|pages|media`; `status` ∈ publish, future, draft, pending, private. Revisions readable via `/revisions`; **no core restore endpoint** — rollback must be implemented by our connector.
- Custom meta must be registered with `register_post_meta(... show_in_rest, auth_callback)`; underscore-prefixed keys are protected.

### SEO plugins
| Plugin | Read via REST | Write via core REST |
|---|---|---|
| Yoast | `yoast_head_json` | **No** — Yoast REST is read-only. Needs our connector plugin. |
| Rank Math | `rankmath/v1/getHead` (headless mode) | **No documented write** — needs connector plugin. Meta keys `rank_math_*` (**UNVERIFIED** against official docs). |
| AIOSEO | `aioseo_meta_data` | **Yes** — POST `aioseo_meta_data` with AIOSEO capabilities. |

→ Conclusion: the **JAT Connector WordPress plugin is mandatory** for reliable, auditable SEO writes and rollback.

### Google APIs
- Search Console: searchanalytics.query (rowLimit ≤25,000); URL Inspection 2,000/day/site.
- GA4 Data API: token quotas, standard 200,000 tokens/property/day, 10 concurrent.
- CrUX API: free, API key, 150 QPM/project. PageSpeed Insights API: key recommended; quota **UNVERIFIED**.

### AI search guidance (affects GEO module claims)
- Google: "no additional requirements" and no special schema or AI text files needed for AI Overviews/AI Mode (developers.google.com/search/docs/appearance/ai-features).
- Google AI optimization guide (updated 2026-07-10): Google Search does not use llms.txt; chunking tactics unnecessary.
- **FAQ rich results stopped appearing in Google Search on 2026-05-07**; HowTo rich results removed 2023. FAQ *content* still helps users and answer engines, but we must not sell FAQ schema as a rich-result tactic.

---

## Claude platform (for the AI layer)
- Models (Oct 2026): `claude-opus-5-5` $4/$20 per MTok; `claude-sonnet-5-5` $2/$10; `claude-haiku-5-5` $0.10/$0.50 (≤100K prompt). All 1M context.
- Native **structured outputs** (`output_config.format` JSON schema) — GA. Validate min/max lengths in code (unsupported in schema).
- Prompt caching: reads 0.05× on 5.5 Opus/Sonnet; 1h TTL writes 2×. Batches API: 50% off, stacks with caching.
- Web search tool $10/1,000 searches; web fetch billed by tokens only.
- **Agent Skills**: SKILL.md (`name` ≤64 chars, lowercase/hyphens, no "claude"/"anthropic"; `description` ≤1024 chars). Custom skills upload via `POST /v1/skills`; require code execution tool; sandbox has no network.
- **Agent SDK** (`@anthropic-ai/claude-agent-sdk`): `allowedTools` only auto-approves — it does not restrict. Lock down with `disallowedTools` + `permissionMode: "dontAsk"` + `PreToolUse` hooks.
- **Managed Agents** (beta): $0.08/session-hour + tokens; not ZDR/HIPAA eligible; stores session history server-side.
- Docs: platform.claude.com/docs/en/agents-and-tools/agent-skills/overview · /build-with-claude/structured-outputs · /about-claude/pricing · code.claude.com/docs/en/agent-sdk/permissions
