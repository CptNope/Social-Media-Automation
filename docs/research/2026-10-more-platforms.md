# Google Business Profile, LinkedIn, Threads and X — verified 2026-10-15

Evidence for the adapters in `packages/integrations`. Official sources only; anything not confirmed is marked **UNVERIFIED** and the code is written to tolerate it. Re-verify before enabling a channel in production.

## Google Business Profile (local posts)

- **OAuth:** `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, revoke `https://oauth2.googleapis.com/revoke`. Scope `https://www.googleapis.com/auth/business.manage`. `access_type=offline` + `prompt=consent` to get a refresh token; PKCE S256 supported. Access-token lifetime: use `expires_in` (no fixed value documented — **UNVERIFIED** as 1 h). Refresh tokens expire after 7 days while the consent screen is External + Testing; `invalid_grant` when revoked/expired.
- **Accounts:** `GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts` → `{accounts[{name: "accounts/{id}", accountName, type, role}], nextPageToken}` (pageSize ≤ 20).
- **Locations:** `GET https://mybusinessbusinessinformation.googleapis.com/v1/{accounts/*}/locations?readMask=name,title,metadata` → `{locations[{name: "locations/{id}", title, metadata.canOperateLocalPost}], nextPageToken}` (pageSize ≤ 100).
- **Post:** `POST https://mybusiness.googleapis.com/v4/accounts/{a}/locations/{l}/localPosts` `{languageCode, summary, topicType: "STANDARD", callToAction: {actionType: "LEARN_MORE", url}}` → LocalPost `{name, searchUrl, state: LIVE|PROCESSING|REJECTED|…}`. Combining the account id and location id into the v4 parent is the documented pattern but inferred from v4 docs. Not on the sunset list (updated 2026-08-28). Google reviews posts after publishing (PROCESSING/REJECTED). Delete: `DELETE https://mybusiness.googleapis.com/v4/{name}`.
- **Summary limit:** 1,500 characters — **UNVERIFIED** (third-party sources only; kept as our lint limit).
- **Access:** API access application required (0 QPM until approved, then 300 QPM); edits capped at 10/min per profile. Errors assumed to be the google.rpc.Status envelope `{error: {code, message, status}}` — **UNVERIFIED** on GBP pages.
- Sources: developers.google.com/identity/protocols/oauth2/web-server, /my-business/content/implement-oauth, /my-business/reference/accountmanagement/rest/v1/accounts/list, /my-business/reference/businessinformation/rest/v1/accounts.locations/list, /my-business/reference/rest/v4/accounts.locations.localPosts/create, /my-business/content/prereqs, /my-business/content/limits, /my-business/content/sunset-dates.

## LinkedIn (Company Pages)

- **OAuth:** `https://www.linkedin.com/oauth/v2/authorization`, token `POST https://www.linkedin.com/oauth/v2/accessToken` (form: grant_type, code, client_id, client_secret, redirect_uri). Access tokens 60 days. Refresh tokens only for approved partners — whether a Community Management app qualifies is **UNVERIFIED**, so we plan for reconnecting every 60 days and warn before expiry. PKCE only for native apps (not used).
- **Scopes:** `w_organization_social` (post as an organization; member role ADMINISTRATOR, CONTENT_ADMINISTRATOR or DIRECT_SPONSORED_CONTENT_POSTER), `r_organization_admin` (read the member's org roles — which scope `organizationAcls` needs is **UNVERIFIED**; we request both).
- **Orgs:** `GET https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED` → `elements[{role, state, organizationTarget | organization: "urn:li:organization:{id}"}]` (the docs show both field names). Names: `GET /rest/organizations/{id}` → `localizedName`.
- **Post:** `POST https://api.linkedin.com/rest/posts`, headers `Linkedin-Version: 202610` (active 202511–202610; 202610 sunsets 2027-10-15), `X-Restli-Protocol-Version: 2.0.0`. Body `{author, commentary, visibility: "PUBLIC", distribution: {feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: []}, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false, content?: {article: {source, title, description}}}` → 201 with `x-restli-id: urn:li:share:…|urn:li:ugcPost:…`. Delete: `DELETE /rest/posts/{encoded urn}` (204).
- **Little text format:** `commentary` must backslash-escape `| { } @ [ ] ( ) < > # \ * _ ~`.
- **Limits/unknowns:** 3,000-character commentary limit — **UNVERIFIED** (docs only name `FIELD_LENGTH_TOO_LONG`). Permalink `https://www.linkedin.com/feed/update/{urn}/` documented for ugcPost URNs; for share URNs **UNVERIFIED**. Duplicate-post error code **UNVERIFIED**.
- **Errors:** `{message, serviceErrorCode, status}`; 401 = token invalid/expired/revoked; 403 ACCESS_DENIED; 429 throttled; 409 retryable; 422 semantic.
- **Access:** Community Management API — Development tier (500 calls/app/day, build within 12 months) then Standard tier (screencast review, discretionary). Registered legal entities only.
- Sources: learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow, …/programmatic-refresh-tokens, …/marketing/community-management/shares/posts-api, …/post-api-schema?view=li-lms-2026-10, …/little-text-format, …/organizations/organization-access-control-by-role, …/integrations/migrations?view=li-lms-2026-10, …/shared/api-guide/concepts/error-handling, …/marketing/increasing-access.

## Threads

- **Hosts:** current docs use `threads.com` / `graph.threads.com`; the changelog (2025-06-06) says `graph.threads.net` also works. Both are configurable (`THREADS_GRAPH_HOST`).
- **OAuth:** `https://threads.com/oauth/authorize` (scopes comma-separated: `threads_basic,threads_content_publish,threads_delete`); code valid 1 h, single use. Exchange `POST https://graph.threads.com/oauth/access_token` → `{access_token, user_id}` (1 h). Long-lived: `GET /access_token?grant_type=th_exchange_token&client_secret&access_token` (60 days). Refresh: `GET /refresh_access_token?grant_type=th_refresh_token&access_token` — only when the token is ≥ 24 h old and not expired; result lasts 60 days.
- **appsecret_proof:** not mentioned in Threads docs — **UNVERIFIED**; not sent.
- **User:** `GET /v1.0/me?fields=id,username`.
- **Post:** container `POST /v1.0/{user-id}/threads` (`media_type=TEXT`, `text`, optional `link_attachment` for TEXT only) → `{id}`; publish `POST /v1.0/{user-id}/threads_publish?creation_id=` → `{id}`. Docs recommend waiting ~30 s before publishing a container (no TEXT exemption stated); we check the container `status` (`FINISHED`) first and poll briefly. Containers expire after 24 h. Permalink: `GET /{media-id}?fields=permalink` (may be absent). Delete: `DELETE /v1.0/{media-id}` (needs `threads_delete`, 100/day).
- **Limits:** 500 characters (emoji counted by UTF-8 bytes — we lint by characters, so emoji-heavy posts could still be rejected); ≤ 5 links; 250 posts per 24 h.
- **Errors:** Graph-style `{error: {message, code, error_subcode}}` with 190 = expired token — documented for the Graph API generally, **UNVERIFIED** for Threads specifically.
- Sources: developers.facebook.com/docs/threads/posts, /threads/overview, /threads/get-started/long-lived-tokens, /documentation/threads/get-started/get-access-tokens-and-permissions, /threads/threads-profiles, /threads/threads-media, /threads/posts/delete-posts, /threads/troubleshooting, /threads/changelog, /graph-api/guides/error-handling.

## X (Twitter) API v2

- **OAuth 2.0 + PKCE (S256):** authorize `https://x.com/i/oauth2/authorize`, token `POST https://api.x.com/2/oauth2/token` (form; confidential clients send `Authorization: Basic base64(id:secret)`). Code expires 30 s after approval. Scopes `tweet.read tweet.write users.read offline.access`. Access tokens 2 h; refresh with `grant_type=refresh_token`. Whether refresh tokens rotate is **UNVERIFIED** — we always store the newest one and serialize refreshes per account.
- **User:** `GET https://api.x.com/2/users/me` → `{data: {id, name, username}}`.
- **Post:** `POST https://api.x.com/2/tweets` `{text}` → 201 `{data: {id, text}}`. Delete `DELETE /2/tweets/{id}`. Permalink `https://x.com/{username}/status/{id}` — **UNVERIFIED** (conventional form).
- **Length:** 280 weighted characters; URLs count 23; emoji/CJK count 2; NFC-normalized (officially documented, "counting characters"). Links go in the text (there is no separate link field).
- **Pricing (pay-per-use, no subscriptions):** create post $0.015; **create post containing a URL $0.200**; prepaid credits.
- **Limits/errors:** `POST /2/tweets` 100 per 15 min per user, 10,000 per 24 h per app; 429 with `x-rate-limit-reset` (Unix time). Problem objects `{type, title, detail}` or legacy `{code, message}`. 401 = invalid/missing credentials (expired-token specifics **UNVERIFIED**); 403 = permission. Duplicate-content error **UNVERIFIED** (treated as permanent when `detail` mentions "duplicate").
- Sources: docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code, …/user-access-token, docs.x.com/x-api/users/get-my-user, /x-api/posts/create-post, /x-api/posts/delete-post, /fundamentals/counting-characters, /x-api/getting-started/pricing, /x-api/fundamentals/rate-limits, /x-api/fundamentals/response-codes-and-errors.

## Known limits in the adapters (from review)

- **LinkedIn hashtags:** commentary escaping turns `#tag` into plain text; LinkedIn's hashtag element is `{hashtag|\#|tag}` (little-text format) — not yet used.
- **Google `REJECTED` posts:** treated as a permanent failure, so the rejected post's name isn't stored for later removal in the app.
- **Threads tokens** travel as `access_token` query parameters, as in Meta's examples; whether Threads accepts `Authorization: Bearer` is UNVERIFIED. No URLs are logged.
- **X counting:** bare domains are detected with a generic pattern (X only recognises real top-level domains) and counted conservatively; every emoji grapheme counts 2.
- **Refresh tokens:** if the database write fails after a platform issued new tokens, the connection is marked "Reconnect needed" rather than failing silently later. The publisher database must not set `idle_in_transaction_session_timeout` below about 60 seconds (a refresh holds a row lock for up to 30 s).
