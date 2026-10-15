# D — Integration Feasibility Matrix

Verified against official docs on 2026-10-15 (evidence and URLs: `docs/research/2026-10-api-research.md`). **No integration is claimed to work until its adapter passes the staging test suite** (Implementation Rule #15). Status column below is design feasibility, not tested status.

Legend — Approval difficulty: 🟢 none/self-serve · 🟡 review with demo · 🔴 restrictive/partner-only.

## Social & local

| Platform | Auth | Publish via API | Native scheduling | Analytics via API | Approval | API cost | MVP plan |
|---|---|---|---|---|---|---|---|
| **Facebook Pages** | FB Login for Business → Page token (no expiry when from long-lived user token) | Text, link, photo, video, Reels | ✅ 10 min–30 days | Page & post insights (some metrics deprecated) | 🟡 Meta App Review (Advanced Access); business verification likely (UNVERIFIED) | Free | **API (P0)** — develop with JAT-owned Page under Standard Access; submit review in week 1 |
| **Instagram** | Instagram Login or FB Login; Professional accounts only | Image (JPEG), video, Reels, Stories, carousel ≤10 | ❌ (we schedule) | Media & account insights (`views` replaced `impressions`) | 🟡 Meta App Review | Free | Export (P0) → API (P1) after review |
| **Threads** | OAuth, 60-day long-lived token, refreshable | Text, image, video, carousel 2–20, links | ❌ | Post & account insights | 🟡 App Review per permission | Free | Export (P0) → API (P2) |
| **LinkedIn (company page)** | OAuth 3-legged, 60-day tokens; refresh only for partners | Text, image, video, document, article, multi-image, poll; no organic carousel | ❌ | Org share stats (12 mo) | 🔴 Community Management API: legal entity, dev tier → standard tier screencast; may be declined | Free | Export (P0); **apply week 1**; API (P1) if approved |
| **LinkedIn (member)** | Share on LinkedIn, `w_member_social` | Text, image, video, article | ❌ | Limited | 🟢 self-serve | Free | Optional P1 for founder-led brands |
| **X** | OAuth 2.0 PKCE, 2h tokens | Text, media | ❌ | Per-read billing | 🟢 self-serve, prepaid credits | **$0.015/post; $0.20/post with URL** (pay-per-use, Feb 2026) | Export (P0); API P2 with cost pass-through |
| **Bluesky** | App password (docs recommend for headless) or OAuth (PAR+DPoP) | Text, images, video (≤50 MB blobs), link facets | ❌ | Public counts only | 🟢 none | Free | **API (P0)** |
| **Google Business Profile** | Google OAuth `business.manage` | Local posts: STANDARD, EVENT, OFFER, ALERT | ✅ `scheduledTime` | Performance API (impressions, calls, directions, clicks); no per-post insights | 🟡 Access application; quota 0 until approved; profile verified 60+ days | Free | Export (P0); **apply week 1**; API (P1) |
| **Pinterest** | OAuth, 30-day access / 60-day continuous refresh | Pins (details partly UNVERIFIED) | UNVERIFIED | 90-day analytics | 🟡 trial → standard with video demo | Free | Export (P0) → API (P2) |
| **TikTok** | OAuth, 24h access / 365d refresh | Direct Post (video/photo) or upload-to-inbox | ❌ | Display API basic counts | 🔴 Audit with strict UX rules; unaudited = private-only, 5 users/day | Free | Export (P0); inbox upload P2 |
| **YouTube / Shorts** | Google OAuth `youtube.upload` | Video upload (Shorts = vertical upload; no Shorts flag documented) | ✅ `publishAt` | YouTube Analytics API | 🟡 Google OAuth verification; quota audit beyond defaults | Free; uploads limited to 100/day/project (June 2026) | Export (P0) → API (P2) |

## Website & search

| System | Auth | Capabilities | Limitations | MVP plan |
|---|---|---|---|---|
| **WordPress core REST** | Application Passwords (HTTPS Basic) for dedicated low-privilege user | Posts/pages/media CRUD, draft/future scheduling, revisions read | No revision-restore endpoint; unregistered meta not exposed | Used *through* the JAT Connector plugin |
| **JAT Connector plugin** (we build) | App Password + HMAC-SHA256 signed requests, timestamp + nonce replay protection | SEO meta read/write for Yoast, Rank Math, AIOSEO; snapshots; rollback; health endpoint; site inventory | We must maintain compatibility with 3 SEO plugins | **P0** |
| **Yoast SEO** | via connector | Read `yoast_head_json`; write via plugin-internal storage | REST is read-only | Connector adapter |
| **Rank Math** | via connector | Write `rank_math_*` post meta (keys to confirm against Rank Math source) | No documented REST write | Connector adapter |
| **AIOSEO** | core REST or connector | `aioseo_meta_data` writable with AIOSEO capabilities | Stored in custom tables | Connector adapter (uses AIOSEO REST path) |
| **WooCommerce** | Consumer key/secret (generated via `/wc-auth/v1/authorize`) | Products, orders read | Order data = personal data → minimize | P1 (product catalog import only) |
| **Google Search Console** | Google OAuth `webmasters.readonly` | Search analytics (≤25k rows/request), URL inspection 2,000/day/site, sitemaps | Data delayed ~2–3 days | **P0** read-only |
| **GA4 Data API** | Google OAuth (`analytics.readonly` — scope UNVERIFIED in this pass) | runReport; sessions, conversions by UTM | 200k tokens/property/day | P1 |
| **CrUX API** | API key | Field CWV by origin/URL | 150 QPM/project; low-traffic sites have no data | **P0** |
| **PageSpeed Insights API** | API key (recommended) | Lab + field data | Quota UNVERIFIED | **P0** |
| **Lead forms** (Gravity Forms, WPForms, Contact Form 7) | via connector webhook | Lead counts with UTM capture | Varies by plugin; PII handling | P1 |

## Required account setup (owner: JAT, start in week 1)
1. Meta Business Manager (+ business verification if Meta requires it — UNVERIFIED); create app; request `pages_manage_posts`, `pages_read_engagement`, `read_insights`, Instagram permissions.
2. LinkedIn developer app associated with JAT company page; apply for Community Management API (Development tier).
3. Google Cloud project: enable Search Console, Analytics Data, CrUX, PageSpeed, Business Profile APIs; OAuth consent screen → move to "In production" and complete verification (refresh tokens expire after 7 days while in Testing).
4. GBP API access application (JAT profile must be verified 60+ days).
5. Privacy policy, terms, data deletion URL on the JAT domain (required by Meta, LinkedIn, Google, TikTok reviews).

## Manual export fallback (always available)
Per item: final copy, image/video files at platform crops, alt text, first comment (if any), UTM link, target time in client time zone. Bundle as ZIP + CSV, plus a "mark as posted" action that records the permalink so reporting still works.
