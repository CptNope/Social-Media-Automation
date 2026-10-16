import { PublishError, callJson, expiresAtFrom, timedFetch, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult, type RefreshedCredential, type TokenRefresher } from "./types.ts";

/**
 * TikTok Content Posting API, "upload to inbox" mode: the video is sent to the creator's TikTok
 * drafts, and they finish posting (caption, privacy) in the TikTok app. This avoids Direct Post's
 * pre-audit limits (private-only, 5 users/day) and its required in-app style UX. Tokens last 24 h
 * and refresh tokens rotate. See docs/research/2026-10-media-platforms.md.
 */
export interface TikTokAppConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TikTokCredential {
  openId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
}

export const TIKTOK_SCOPES = ["user.info.basic", "video.upload"] as const;
const API = "https://open.tiktokapis.com";
const MIN_CHUNK = 5 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

export function classifyTikTokError(status: number, body: unknown): PublishError {
  const e = (body as { error?: { code?: string; message?: string } | string; error_description?: string } | null)?.error;
  const code = typeof e === "object" ? (e?.code ?? "") : (e ?? "");
  const message = typeof e === "object" ? e?.message : (body as { error_description?: string } | null)?.error_description;
  const msg = `TikTok ${status}${code ? ` ${code}` : ""}: ${message ?? "unknown error"}`.slice(0, 500);
  if (code === "access_token_invalid" || code === "invalid_grant" || status === 401) return new PublishError("auth", msg, undefined, code || "401");
  if (code === "rate_limit_exceeded" || status === 429) return new PublishError("transient", msg, 60_000, code || "429");
  if (code === "spam_risk_too_many_pending_share") return new PublishError("transient", `${msg} — too many videos are waiting in the creator's TikTok drafts.`, 6 * 3_600_000, code);
  if (code === "scope_not_authorized" || code === "scope_permission_missed" || code === "reached_active_user_cap" || code === "spam_risk_user_banned_from_posting") return new PublishError("permission", msg, undefined, code);
  if (status >= 500 || code === "internal_error") return new PublishError("transient", msg, undefined, code || String(status));
  return new PublishError("permanent", msg, undefined, code || String(status));
}

/** Splits a file per TikTok's rules: 5–64 MB chunks, the last one absorbing the remainder; < 5 MB in one. */
export function tiktokChunks(size: number): { chunkSize: number; count: number } {
  if (size < MIN_CHUNK) return { chunkSize: size, count: 1 };
  const count = Math.max(1, Math.floor(size / CHUNK));
  return { chunkSize: count === 1 ? size : CHUNK, count };
}

export class TikTokAdapter implements ChannelAdapter<TikTokCredential>, OAuthConnector<TikTokCredential> {
  readonly channel = "tiktok" as const;
  readonly accountNoun = "account";
  readonly scopes = TIKTOK_SCOPES;
  readonly usesPkce = false;

  constructor(
    private readonly app: TikTokAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  authorizeUrl({ state }: { state: string }): string {
    const q = new URLSearchParams({ client_key: this.app.clientKey, scope: TIKTOK_SCOPES.join(","), response_type: "code", redirect_uri: this.app.redirectUri, state });
    return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
  }

  /** TikTok returns errors inside 200 responses too: `error.code` must be "ok". */
  async #api(path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
    const { res, json } = await callJson(this.fetchImpl, `${API}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" }, body: JSON.stringify(body) }, { write: false, classify: classifyTikTokError });
    const code = (json as { error?: { code?: string } } | null)?.error?.code;
    if (code && code !== "ok") throw classifyTikTokError(res.status, json);
    return ((json as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  }

  async #token(params: Record<string, string>): Promise<{ access_token: string; refresh_token: string; expires_in?: number; open_id: string }> {
    const { json } = await callJson(
      this.fetchImpl,
      `${API}/v2/oauth/token/`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_key: this.app.clientKey, client_secret: this.app.clientSecret, ...params }).toString() },
      { write: false, classify: classifyTikTokError },
    );
    const t = json as { access_token?: string; refresh_token?: string; expires_in?: number; open_id?: string; error?: string; error_description?: string } | null;
    if (!t?.access_token || !t.refresh_token || !t.open_id) throw classifyTikTokError(400, { error: t?.error ?? "invalid_grant", error_description: t?.error_description ?? "TikTok didn't return tokens." });
    return t as { access_token: string; refresh_token: string; expires_in?: number; open_id: string };
  }

  async #displayName(token: string): Promise<string> {
    const { json } = await callJson(this.fetchImpl, `${API}/v2/user/info/?fields=open_id,display_name`, { method: "GET", headers: { authorization: `Bearer ${token}` } }, { write: false, classify: classifyTikTokError });
    return ((json as { data?: { user?: { display_name?: string } } } | null)?.data?.user?.display_name ?? "TikTok account").slice(0, 100);
  }

  async accountsFromCode({ code }: { code: string }): Promise<Array<ConnectableAccount<TikTokCredential>>> {
    const t = await this.#token({ code, grant_type: "authorization_code", redirect_uri: this.app.redirectUri });
    const name = await this.#displayName(t.access_token);
    return [{ id: t.open_id, name, canPost: true, credential: { openId: t.open_id, displayName: name, accessToken: t.access_token, refreshToken: t.refresh_token }, tokenExpiresAt: expiresAtFrom(t.expires_in) }];
  }

  /** 24-hour access tokens; refresh tokens rotate, so the newest one is always stored. */
  readonly refresh: TokenRefresher<TikTokCredential> = {
    windowMs: 2 * 3_600_000,
    keepAlive: false,
    run: async (cred): Promise<RefreshedCredential<TikTokCredential>> => {
      const t = await this.#token({ grant_type: "refresh_token", refresh_token: cred.refreshToken });
      return { credential: { ...cred, accessToken: t.access_token, refreshToken: t.refresh_token }, tokenExpiresAt: expiresAtFrom(t.expires_in) };
    },
  };

  async publish(post: PublishablePost, cred: TikTokCredential): Promise<PublishResult> {
    const media = post.media;
    if (!media || media.kind !== "video") throw new PublishError("permanent", "TikTok posts need a video.");
    const bytes = await media.bytes();
    const { chunkSize, count } = tiktokChunks(bytes.length);
    // Sending to the creator's drafts is not public, so these steps can be retried safely.
    const init = await this.#api("/v2/post/publish/inbox/video/init/", cred.accessToken, { source_info: { source: "FILE_UPLOAD", video_size: bytes.length, chunk_size: chunkSize, total_chunk_count: count } });
    const publishId = init.publish_id;
    const uploadUrl = init.upload_url;
    if (typeof publishId !== "string" || typeof uploadUrl !== "string" || !/^https:\/\//.test(uploadUrl)) throw new PublishError("transient", "TikTok didn't return an upload slot.");
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize;
      const end = i === count - 1 ? bytes.length : start + chunkSize;
      const res = await timedFetch(this.fetchImpl, uploadUrl, { method: "PUT", headers: { "content-type": media.mime, "content-length": String(end - start), "content-range": `bytes ${start}-${end - 1}/${bytes.length}` }, body: bytes.subarray(start, end) }, { idempotent: true, timeoutMs: 10 * 60_000 });
      if (!res.ok) throw new PublishError("transient", `TikTok upload failed on part ${i + 1} of ${count} (${res.status}).`);
    }
    // Once every part is uploaded the draft is on its way: a failing status check must not
    // turn into a retry (that would send a second copy to the drafts).
    const DRAFT_NOTE = "Sent to the creator's TikTok drafts. Open TikTok to add the caption and post it.";
    for (let i = 0; i < 30; i++) {
      let s: Record<string, unknown>;
      try {
        s = await this.#api("/v2/post/publish/status/fetch/", cred.accessToken, { publish_id: publishId });
      } catch {
        return { externalId: publishId, permalink: null, note: "Uploaded to TikTok, but we couldn't confirm processing. Check the creator's TikTok drafts; the caption is added in TikTok." };
      }
      if (s.status === "SEND_TO_USER_INBOX" || s.status === "PUBLISH_COMPLETE") {
        return { externalId: publishId, permalink: null, note: DRAFT_NOTE };
      }
      if (s.status === "FAILED") throw new PublishError("permanent", `TikTok couldn't process the video${typeof s.fail_reason === "string" ? ` (${s.fail_reason})` : ""}.`);
      await this.sleep(4_000);
    }
    // The upload finished; TikTok is still processing. The draft will arrive — don't send it again.
    return { externalId: publishId, permalink: null, note: "Uploaded; TikTok is still processing it. It will appear in the creator's TikTok drafts." };
  }

  async remove(): Promise<void> {
    throw new PublishError("permanent", "Drafts sent to TikTok are managed in the TikTok app.");
  }

  async check(cred: TikTokCredential): Promise<{ ok: true; accountName: string }> {
    return { ok: true, accountName: await this.#displayName(cred.accessToken) };
  }
}
