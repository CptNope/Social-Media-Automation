# Instagram, Pinterest, TikTok, YouTube and Cloudflare R2 — verified 2026-10-15

Evidence for the media adapters and storage. Official sources only; anything not confirmed is **UNVERIFIED** and the code tolerates it. Re-verify before going live.

## Instagram (Instagram API with Facebook Login)

- **Why this path:** reuses the Facebook Login app already used for Pages, and is the only path with resumable video upload and DELETE. Host `graph.facebook.com` (+ `rupload.facebook.com` for video bytes).
- **Scopes:** `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement` (+ `instagram_manage_contents` for delete; `ads_management`/`ads_read` only if the Page role comes through Business Manager).
- **Account:** `GET /me/accounts` → for each Page `GET /{page-id}?fields=instagram_business_account{id,username}` (the nested-field syntax is standard Graph field expansion; **UNVERIFIED** on that page).
- **Which token publishes:** docs disagree (content-publishing guide: Page token; IG user media reference: user token) — **UNVERIFIED**. We store both; containers are created with the Page token and, if refused for permission, with the user token (creating a container publishes nothing).
- **Image:** `POST /{ig-user-id}/media` `image_url`, `caption`, `alt_text` (images only, ≤ 1000 chars, since 2025-03-24) → container; poll `GET /{container}?fields=status_code` (`IN_PROGRESS|FINISHED|ERROR|EXPIRED|PUBLISHED`; containers expire after 24 h); `POST /{ig-user-id}/media_publish` `creation_id`. JPEG only, ≤ 8 MB, aspect 4:5 – 1.91:1, width 320–1440, sRGB.
- **Image URL:** fetched by Meta with cURL from a public URL. Whether presigned (query-string) URLs work — **UNVERIFIED**; we use a presigned R2 GET URL valid for 1 hour.
- **Reels:** `media_type=REELS`, `upload_type=resumable`, `share_to_feed`; then `POST https://rupload.facebook.com/ig-api-upload/{container-id}` with `Authorization: OAuth <token>`, `offset: 0`, `file_size`, binary body. MP4/MOV (H.264/HEVC, AAC), 3 s – 15 min, ≤ 300 MB, 9:16 recommended.
- **Limits:** publishing quota conflicts (guide: 100/24 h; `content_publishing_limit` reference: 50) — we don't pre-enforce; error 9/2207042 is treated as retry-later. Caption ≤ 2,200 chars, 30 hashtags, 20 @tags. Carousels 2–10 items (not built yet).
- **Permalink** `GET /{media-id}?fields=permalink`. **Delete** `DELETE /{ig-media-id}` (Facebook Login only).
- **Errors:** Graph format with `error_subcode`; notable: 9004/2207052 media fetch failed, 2207003 download timeout (retry), 2207020/2207008 container expired, 9007/2207027 not ready, 36000–36004 image/caption validation, 9/2207042 daily limit, 4/2207051 spam.
- Sources: developers.facebook.com/docs/instagram-platform/content-publishing, …/instagram-graph-api/reference/ig-user/media, …/reference/instagram-media, …/ig-user/content_publishing_limit, …/reference/error-codes, …/changelog, /documentation/instagram-platform/instagram-api-with-facebook-login/get-started.

## Pinterest (API v5)

- **OAuth:** `https://www.pinterest.com/oauth/` (`client_id`, `redirect_uri`, `response_type=code`, `scope`, `state`); token `POST https://api.pinterest.com/v5/oauth/token` with `Authorization: Basic base64(id:secret)`. PKCE not documented (not used). Access tokens 30 days; **continuous refresh tokens** 60 days, renewed on every refresh (the response carries a new refresh token).
- **Scopes:** `boards:read`, `boards:write`, `pins:read`, `pins:write`, `user_accounts:read`.
- **Boards:** `GET /v5/boards?page_size=250&bookmark=` → `{items[{id, name, privacy}], bookmark}`; `GET /v5/user_account` → `username`, `account_type`.
- **Image pin:** `POST /v5/pins` `{board_id, title ≤ 100, description ≤ 800, link ≤ 2048, alt_text ≤ 500, media_source: {source_type: "image_base64", content_type: image/jpeg|image/png, data}}` → 201 `{id}`. Base64 size limit **UNVERIFIED**. Permalink `https://www.pinterest.com/pin/{id}/` **UNVERIFIED**. Delete `DELETE /v5/pins/{id}`.
- **Video pin:** `POST /v5/media {media_type: "video"}` → `{media_id, upload_url, upload_parameters}`; multipart form POST of every parameter + `file` to `upload_url` (no bearer; 204); poll `GET /v5/media/{id}` (`registered|processing|succeeded|failed`); pin with `media_source {source_type: "video_id", media_id, cover_image_key_frame_time}`. MP4/MOV/M4V; size/length limits **UNVERIFIED**.
- **Access tiers:** Trial — pins are visible only to their creator as sandbox entities, on `api-sandbox.pinterest.com` (separate tokens); Standard requires a video demo. Writes: Trial 300/day/app; Standard 100/min/user. Errors `{code, message}` with HTTP 401/403/429.
- Sources: developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization, /docs/api-features/creating-boards-and-pins, /docs/key-concepts/access-tiers, /docs/developer-tools/sandbox, /docs/reference/rate-limits, Pinterest's OpenAPI spec (github.com/pinterest/api-description, v5).

## TikTok (Content Posting API)

- **OAuth (web):** `https://www.tiktok.com/v2/auth/authorize/` (`client_key`, comma-separated `scope`, `redirect_uri`, `state`, `response_type=code`); PKCE only for mobile/desktop apps. Token `POST https://open.tiktokapis.com/v2/oauth/token/` (form: client_key, client_secret, code, grant_type, redirect_uri). Access 24 h; refresh 365 days from first issue; **refresh tokens rotate** ("you must use the newly-returned token").
- **Scopes:** `user.info.basic`, `video.upload` (inbox), `video.publish` (direct post, not used yet).
- **Why inbox (drafts):** unaudited Direct Post is limited to 5 users/24 h and forced to `SELF_ONLY` on private accounts, and Direct Post needs extra UX (privacy choice with no default, interaction toggles, commercial-content disclosure, music consent). The inbox flow sends the video to the creator's TikTok drafts; they finish posting in the app. Whether audit rules apply to inbox uploads — **UNVERIFIED**; limit 5 pending shares per 24 h.
- **Upload:** `POST /v2/post/publish/inbox/video/init/` `{source_info: {source: "FILE_UPLOAD", video_size, chunk_size, total_chunk_count}}` → `{publish_id, upload_url}` (valid 1 h). Chunks 5–64 MB (last ≤ 128 MB; < 5 MB = one chunk; count = floor(size/chunk)), in order, `PUT upload_url` with `Content-Type`, `Content-Range: bytes a-b/total`.
- **Status:** `POST /v2/post/publish/status/fetch/ {publish_id}` → `PROCESSING_UPLOAD|PROCESSING_DOWNLOAD|SEND_TO_USER_INBOX|PUBLISH_COMPLETE|FAILED` + `fail_reason`.
- **Video:** MP4/WebM/MOV, ≤ 4 GB, 23–60 fps, 360–4096 px, up to 10 min via API (per-creator max). Photo posts require `PULL_FROM_URL` with domain verification (not built).
- **Errors:** `{error: {code, message, log_id}}`, `code: "ok"` on success even for HTTP 200 — always check it. `access_token_invalid` (401), `rate_limit_exceeded` (429), `spam_risk_*`, `reached_active_user_cap`, `url_ownership_unverified` (403).
- **User:** `GET /v2/user/info/?fields=open_id,display_name` (username needs `user.info.profile`).
- Sources: developers.tiktok.com/doc/login-kit-web, /doc/oauth-user-access-token-management, /doc/content-posting-api-get-started, /doc/content-posting-api-reference-upload-video, /doc/content-posting-api-media-transfer-guide, /doc/content-posting-api-reference-get-video-status, /doc/tiktok-api-v2-error-handling, /doc/tiktok-api-v2-get-user-info, /doc/tiktok-api-v2-rate-limit.

## YouTube (Data API v3)

- **OAuth:** Google (`access_type=offline`, `prompt=consent`, PKCE). Scopes `youtube.upload` + `youtube.readonly` (channel lookup; scope requirement for `channels.list` **UNVERIFIED**). `videos.delete` needs `youtube` or `youtube.force-ssl` (not requested → removal is done in YouTube Studio). Sensitive/restricted classification of `youtube.upload` **UNVERIFIED**; Testing-mode refresh tokens expire after 7 days.
- **Channel:** `GET /youtube/v3/channels?part=snippet&mine=true` → `id`, `snippet.title`, `snippet.customUrl`.
- **Resumable upload:** `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` (JSON body; `X-Upload-Content-Length`, `X-Upload-Content-Type`) → `Location`; `PUT` the bytes → 201 video resource. After an interrupted PUT, `PUT` with `Content-Range: bytes */TOTAL` returns the original response if complete, or `308` with `Range` to resume — so an interrupted upload can be checked instead of guessed.
- **Metadata:** title ≤ 100 chars, description ≤ 5,000 bytes (no `<`/`>`), `categoryId` (samples use "22"; required-on-insert **UNVERIFIED**), `privacyStatus` (default public), `selfDeclaredMadeForKids`, `containsSyntheticMedia` (both optional).
- **Unverified projects:** field docs say uploads are *not* restricted to private; the page summary still says they are — **UNVERIFIED**; the adapter reports the resulting privacy.
- **Quota:** since 2026-06-01 `videos.insert` has its own bucket, 100 uploads/day/project by default; other calls share 10,000 units.
- **Shorts:** no API flag; vertical/square videos up to 3 minutes are Shorts.
- **Errors:** `{error: {code, message, errors[{reason}]}}`: `quotaExceeded`/`rateLimitExceeded` (403/429), `uploadLimitExceeded` (400, channel's daily limit), `invalidVideoMetadata`/`invalidTitle`… (400), `forbidden` (403), `authorizationRequired`/`youtubeSignupRequired` (401).
- Sources: developers.google.com/youtube/v3/docs/videos/insert, /docs/videos, /docs/videos/delete, /docs/channels/list, /guides/using_resumable_upload_protocol, /guides/auth/server-side-web-apps, /docs/errors, /docs/core_errors, /determine_quota_cost, /revision_history, /guides/quota_and_compliance_audits; support.google.com/youtube/answer/12779649.

## Cloudflare R2 (media storage)

- **S3 API:** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (jurisdiction: `.<eu|fedramp>.`), region `auto`, SigV4 service `s3` (**UNVERIFIED** on R2 pages; standard), path-style and virtual-hosted both work. Credentials: an R2 API token scoped to one bucket with Object Read & Write.
- **Operations:** PutObject (≤ 4.995 GiB single PUT), GetObject, HeadObject, DeleteObject, multipart. We sign the real payload SHA-256 (`UNSIGNED-PAYLOAD` in header-signed requests **UNVERIFIED**).
- **Presigned URLs:** GET/HEAD/PUT/DELETE, 1 s – 7 days, standard `X-Amz-*` query parameters, work without other auth; only on `*.r2.cloudflarestorage.com` (not custom domains). Buckets are private by default — we keep the bucket private and hand platforms a 1-hour presigned GET URL only when they must fetch by URL (Instagram images).
- **Pricing (Standard):** $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, **no egress fees**; free tier 10 GB, 1 M A, 10 M B per month.
- Sources: developers.cloudflare.com/r2/api/s3/api, /r2/api/s3/presigned-urls, /r2/api/tokens, /r2/reference/data-location, /r2/objects/upload-objects, /r2/platform/limits, /r2/buckets/public-buckets, /r2/buckets/cors, /r2/pricing, /r2/platform/release-notes.

## Known limits of what's built (2026-10-15)

- One file per post. Carousels, Instagram stories and multi-image Bluesky posts are not published automatically; stories are blocked rather than sent as a regular post.
- TikTok goes to the creator's drafts only; the caption isn't sent (the inbox endpoint takes none). Direct Post needs TikTok's audit.
- YouTube: `selfDeclaredMadeForKids` isn't set (YouTube asks in Studio); titles longer than 100 characters are cut.
- Preview and signed-link routes read the whole file into memory before serving a range; fine for the 250 MB default cap, revisit for larger files.
- Files replaced or removed from a post stay in storage (no cleanup job yet). Asset rows are insert-only for the app role.
- Video rotation metadata is ignored when reading width and height, so a rotated phone video may be judged landscape.
