import { PublishError, callJson, expiresAtFrom, retryAfterMs, timedFetch, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult, type RefreshedCredential, type TokenRefresher } from "./types.ts";

/**
 * Pinterest API v5: OAuth with continuous refresh tokens (kept alive in the background), one
 * board per connection, image pins sent as base64 and video pins through Pinterest's media
 * upload. Trial-access apps work against api-sandbox.pinterest.com (pins visible only to the
 * creator). See docs/research/2026-10-media-platforms.md.
 */
export interface PinterestAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** "api.pinterest.com" (default) or "api-sandbox.pinterest.com" for Trial access. */
  apiHost?: string;
}

export interface PinterestCredential {
  boardId: string;
  boardName: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

export const PINTEREST_SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"] as const;

export function classifyPinterestError(status: number, body: unknown, res?: Response): PublishError {
  const b = body as { code?: number; message?: string; error?: string; error_description?: string } | null;
  const msg = `Pinterest ${status}${b?.code ? ` (${b.code})` : ""}: ${b?.message ?? b?.error_description ?? b?.error ?? "unknown error"}`.slice(0, 500);
  if (status === 401 || b?.error === "invalid_grant") return new PublishError("auth", msg, undefined, String(status));
  if (status === 403) return new PublishError("permission", msg, undefined, String(status));
  if (status === 429) return new PublishError("transient", msg, res ? retryAfterMs(res) : undefined, "429");
  if (status >= 500) return new PublishError("transient", msg, undefined, String(status));
  return new PublishError("permanent", msg, undefined, String(status));
}

export class PinterestAdapter implements ChannelAdapter<PinterestCredential>, OAuthConnector<PinterestCredential> {
  readonly channel = "pinterest" as const;
  readonly accountNoun = "board";
  readonly scopes = PINTEREST_SCOPES;
  readonly usesPkce = false;
  readonly #api: string;

  constructor(
    private readonly app: PinterestAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.#api = `https://${app.apiHost ?? "api.pinterest.com"}/v5`;
  }

  authorizeUrl({ state }: { state: string }): string {
    const q = new URLSearchParams({ client_id: this.app.clientId, redirect_uri: this.app.redirectUri, response_type: "code", scope: PINTEREST_SCOPES.join(","), state });
    return `https://www.pinterest.com/oauth/?${q}`;
  }

  async #token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const { json } = await callJson(
      this.fetchImpl,
      `${this.#api}/oauth/token`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${this.app.clientId}:${this.app.clientSecret}`).toString("base64")}` }, body: new URLSearchParams(params).toString() },
      { write: false, classify: (s, b, r) => (s === 400 ? new PublishError("auth", `Pinterest sign-in failed: ${(b as { message?: string } | null)?.message ?? "invalid grant"}`) : classifyPinterestError(s, b, r)) },
    );
    const t = json as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!t?.access_token) throw new PublishError("auth", "Pinterest didn't return an access token.");
    return t as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  async #get(path: string, token: string): Promise<unknown> {
    return (await callJson(this.fetchImpl, `${this.#api}/${path}`, { method: "GET", headers: { authorization: `Bearer ${token}` } }, { write: false, classify: classifyPinterestError })).json;
  }

  async accountsFromCode({ code }: { code: string }): Promise<Array<ConnectableAccount<PinterestCredential>>> {
    const t = await this.#token({ grant_type: "authorization_code", code, redirect_uri: this.app.redirectUri });
    if (!t.refresh_token) throw new PublishError("permanent", "Pinterest didn't return a refresh token.");
    const me = (await this.#get("user_account", t.access_token)) as { username?: string };
    const out: Array<ConnectableAccount<PinterestCredential>> = [];
    let bookmark: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r = (await this.#get(`boards?${new URLSearchParams({ page_size: "250", ...(bookmark ? { bookmark } : {}) })}`, t.access_token)) as { items?: Array<{ id?: string; name?: string; privacy?: string }>; bookmark?: string | null };
      for (const b of r?.items ?? []) {
        if (!b.id || !/^\d+$/.test(b.id)) continue;
        const name = b.name ?? b.id;
        out.push({ id: b.id, name: `${name}${b.privacy === "SECRET" ? " (secret)" : ""}`, canPost: true, credential: { boardId: b.id, boardName: name, username: me?.username ?? "", accessToken: t.access_token, refreshToken: t.refresh_token }, tokenExpiresAt: expiresAtFrom(t.expires_in) });
      }
      if (!r?.bookmark) break;
      bookmark = r.bookmark;
    }
    return out;
  }

  /** 30-day access tokens with 60-day continuous refresh tokens: renew in the background so they never lapse. */
  readonly refresh: TokenRefresher<PinterestCredential> = {
    windowMs: 5 * 24 * 3_600_000,
    keepAlive: true,
    run: async (cred): Promise<RefreshedCredential<PinterestCredential>> => {
      const t = await this.#token({ grant_type: "refresh_token", refresh_token: cred.refreshToken });
      return { credential: { ...cred, accessToken: t.access_token, refreshToken: t.refresh_token ?? cred.refreshToken }, tokenExpiresAt: expiresAtFrom(t.expires_in) ?? new Date(Date.now() + 30 * 86_400_000).toISOString() };
    },
  };

  async publish(post: PublishablePost, cred: PinterestCredential): Promise<PublishResult> {
    const media = post.media;
    if (!media) throw new PublishError("permanent", "Pinterest pins need an image or a video.");
    let mediaSource: Record<string, unknown>;
    if (media.kind === "image") {
      if (!["image/jpeg", "image/png"].includes(media.mime)) throw new PublishError("permanent", "Pinterest accepts JPEG or PNG images.");
      mediaSource = { source_type: "image_base64", content_type: media.mime, data: (await media.bytes()).toString("base64") };
    } else {
      mediaSource = { source_type: "video_id", media_id: await this.#uploadVideo(media.mime, await media.bytes(), cred.accessToken), cover_image_key_frame_time: 1 };
    }
    const body = {
      board_id: cred.boardId,
      title: (post.title ?? post.text).trim().slice(0, 100),
      description: post.text.trim().slice(0, 800),
      ...(post.link ? { link: post.link.url.slice(0, 2048) } : {}),
      ...(media.altText ? { alt_text: media.altText.slice(0, 500) } : {}),
      media_source: mediaSource,
    };
    const { json } = await callJson(this.fetchImpl, `${this.#api}/pins`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cred.accessToken}` }, body: JSON.stringify(body) }, { write: true, classify: classifyPinterestError });
    const id = (json as { id?: string } | null)?.id;
    if (!id) throw new PublishError("ambiguous", "Pinterest didn't return a pin id.");
    return { externalId: id, permalink: /^\d+$/.test(id) ? `https://www.pinterest.com/pin/${id}/` : null };
  }

  /** Register → upload to Pinterest's storage (form POST) → wait until processed. Publishes nothing. */
  async #uploadVideo(mime: string, bytes: Buffer, token: string): Promise<string> {
    const { json } = await callJson(this.fetchImpl, `${this.#api}/media`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ media_type: "video" }) }, { write: false, classify: classifyPinterestError });
    const reg = json as { media_id?: string; upload_url?: string; upload_parameters?: Record<string, string> } | null;
    if (!reg?.media_id || !reg.upload_url || !/^https:\/\//.test(reg.upload_url)) throw new PublishError("transient", "Pinterest didn't return an upload slot.");
    const form = new FormData();
    for (const [k, v] of Object.entries(reg.upload_parameters ?? {})) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), "video");
    const up = await timedFetch(this.fetchImpl, reg.upload_url, { method: "POST", body: form }, { idempotent: true, timeoutMs: 10 * 60_000 });
    if (!up.ok) throw new PublishError("transient", `Pinterest video upload failed (${up.status}).`);
    for (let i = 0; i < 40; i++) {
      const s = (await this.#get(`media/${encodeURIComponent(reg.media_id)}`, token)) as { status?: string };
      if (s?.status === "succeeded") return reg.media_id;
      if (s?.status === "failed") throw new PublishError("permanent", "Pinterest couldn't process the video.");
      await this.sleep(5_000);
    }
    throw new PublishError("transient", "Pinterest is still processing the video; trying again later.");
  }

  async remove(externalId: string, cred: PinterestCredential): Promise<void> {
    await callJson(this.fetchImpl, `${this.#api}/pins/${encodeURIComponent(externalId)}`, { method: "DELETE", headers: { authorization: `Bearer ${cred.accessToken}` } }, { write: false, classify: classifyPinterestError });
  }

  async check(cred: PinterestCredential): Promise<{ ok: true; accountName: string }> {
    const b = (await this.#get(`boards/${encodeURIComponent(cred.boardId)}`, cred.accessToken)) as { name?: string };
    return { ok: true, accountName: b?.name ?? cred.boardName };
  }
}
