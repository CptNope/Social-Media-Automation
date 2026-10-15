# Publishing API notes — verified 2026-10-15

Evidence for the Bluesky and Facebook Pages adapters (`packages/integrations`). Official sources only; anything not confirmed is marked **UNVERIFIED**. Re-verify before enabling a channel in production.

## Bluesky (AT Protocol, app password)

- **Login:** `POST https://bsky.social/xrpc/com.atproto.server.createSession` `{identifier, password}` → `{accessJwt, refreshJwt, handle, did, didDoc?, active?, status?}`. Rate limit: 30/5 min and 300/day per account → cache sessions.
- **PDS:** after login, send writes to the user's PDS: `didDoc.service[]` entry with `id` ending `#atproto_pds` and `type: "AtprotoPersonalDataServer"` → `serviceEndpoint`. Whether bsky.social proxies writes for other PDSes: UNVERIFIED (so we always use the PDS).
- **Refresh:** `POST {pds}/xrpc/com.atproto.server.refreshSession` with `Authorization: Bearer <refreshJwt>`; access JWTs last minutes. Error name that signals refresh (`ExpiredToken`): UNVERIFIED → we refresh once on any 400/401 with `ExpiredToken` or `InvalidToken`.
- **Post:** `POST {pds}/xrpc/com.atproto.repo.createRecord` `{repo: did, collection: "app.bsky.feed.post", record: {$type, text, createdAt, langs?, facets?, embed?}}` → `{uri, cid}`. Text ≤ 300 graphemes / 3000 bytes.
- **Link card:** `embed: {$type: "app.bsky.embed.external", external: {uri, title, description, thumb?}}` — thumb optional.
- **Link facets:** UTF-8 byte offsets, feature `{$type: "app.bsky.richtext.facet#link", uri}`.
- **Delete:** `POST {pds}/xrpc/com.atproto.repo.deleteRecord` `{repo, collection, rkey}`; rkey = last segment of the at:// URI.
- **Errors:** `{error, message?}`; 429 with possible `Retry-After`. Write budget 5,000 points/hour (create = 3).

## Facebook Pages (Graph API)

- **Version:** v26.0 released 2026-07-29 (newest confirmed); configurable via `FACEBOOK_GRAPH_VERSION`.
- **OAuth:** dialog `https://www.facebook.com/{v}/dialog/oauth?client_id&redirect_uri&state&scope`; code exchange `GET https://graph.facebook.com/{v}/oauth/access_token?client_id&redirect_uri&client_secret&code`; long-lived `grant_type=fb_exchange_token` (~60 days); Page tokens via `GET /{v}/me/accounts` (guide shows `/{user-id}/accounts`; `/me` equivalence UNVERIFIED) → `data[{id, name, access_token, tasks}]`. Page tokens from a long-lived user token don't expire but can be invalidated (error 190).
- **Permissions:** `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` (for listing pages); user needs CREATE_CONTENT on the Page.
- **Publish:** `POST /{v}/{page-id}/feed` `message`, `link` → `{id: "{page-id}_{post-id}"}`; delete `DELETE /{v}/{post-id}`.
- **appsecret_proof:** `hex(HMAC-SHA256(app_secret, access_token))`; required only if the app enables "Require proof on all calls"; we always send it.
- **Errors:** `{error: {message, type, code, error_subcode, fbtrace_id}}`. Transient: 1, 2, 4, 17, 32, 341, 613, 80001. Auth: 190, 102. Permission: 10, 200–299. Permanent: 368 (policy block, needs a human), 506 (duplicate), 100 (invalid parameter, UNVERIFIED in the error guide).

## WordPress (JAT Connector plugin)

- **Auth:** WordPress Application Passwords (Basic auth, HTTPS; core since 5.6) for a dedicated user, plus our HMAC-SHA256 signature over `METHOD\nROUTE\nTIMESTAMP\nNONCE\nsha256(body)` (±300 s, single-use nonce).
- **Routing:** `?rest_route=/jat/v1/...` works with and without pretty permalinks.
- **Parameter order:** `WP_REST_Request` merges JSON body, POST, GET (query string) and URL params, and the query string outranks URL params — so the plugin reads only `get_json_params()` and `get_url_params()` (the signed parts).
- **SEO meta keys:** Yoast `_yoast_wpseo_title` / `_yoast_wpseo_metadesc`, Rank Math `rank_math_title` / `rank_math_description`, AIOSEO through its model API — all **UNVERIFIED on live sites**; see the plugin readme.

## Duplicate-post risk (design notes)

- Neither Bluesky `createRecord` (record keys are TIDs) nor Facebook `/{page}/feed` exposes a client idempotency key that we have verified. **UNVERIFIED:** whether a client-chosen TID `rkey` derived from our idempotency key would be accepted by the AppView; not used.
- So the publisher never retries anything that may have reached the platform: timeouts after sending, dropped connections after sending, 5xx on create, and unknown errors are "ambiguous" and go to a person. Only rate limits and errors that prove nothing was sent (DNS failure, connection refused, TLS errors) are retried, with backoff, up to 5 attempts.

Sources: docs.bsky.app (posts, api-directory, rate-limits, get-started), atproto.com/specs (xrpc, did, oauth), bluesky-social/atproto lexicons; developers.facebook.com (graph-api changelog v25/v26, pages-api/posts, facebook-login manual-flow and long-lived tokens, graph-api error-handling, rate-limiting, securing-requests).
