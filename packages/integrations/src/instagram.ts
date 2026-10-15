import { appSecretProof, classifyGraphError, type FacebookAppConfig } from "./facebook.ts";
import { PublishError, callJson, timedFetch, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult } from "./types.ts";

/**
 * Instagram professional accounts through "Instagram API with Facebook Login": the same Meta
 * app as Facebook Pages. Images are fetched by Meta from a short-lived URL; Reels are uploaded
 * directly (resumable upload). Every post is a container that is checked, then published once.
 * See docs/research/2026-10-media-platforms.md.
 */
export interface InstagramCredential {
  igUserId: string;
  username: string;
  pageId: string;
  /** Page token (doesn't expire). */
  pageAccessToken: string;
  /** Long-lived user token (~60 days) — fallback, because Meta's docs disagree on which token publishes. */
  userAccessToken: string;
}

export const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_content_publish", "instagram_manage_contents", "pages_show_list", "pages_read_engagement"] as const;
const THROTTLED = new Set([4, 17, 32, 341, 613, 80001]);
const CAPTION_MAX = 2200;

type GraphBody = { error?: { code?: number; error_subcode?: number; message?: string; is_transient?: boolean } } | null;

export function classifyInstagramError(status: number, body: unknown): PublishError {
  const e = (body as GraphBody)?.error;
  const sub = e?.error_subcode ?? 0;
  const msg = `Instagram ${status} (code ${e?.code ?? 0}${sub ? `/${sub}` : ""}): ${e?.message ?? "unknown error"}`.slice(0, 500);
  if (sub === 2207042) return new PublishError("transient", `${msg} — the daily publishing limit was reached.`, 6 * 3_600_000, String(sub));
  if (sub === 2207003 || sub === 2207008 || sub === 2207027) return new PublishError("transient", msg, 2 * 60_000, String(sub));
  if (sub === 2207052) return new PublishError("permanent", `${msg} — Instagram couldn't download the image.`, undefined, String(sub));
  if (sub === 2207050) return new PublishError("permission", `${msg} — the account is restricted; sign in to the Instagram app.`, undefined, String(sub));
  return classifyGraphError(status, body, "Instagram");
}

const retrySafe = (status: number, body: unknown) => status === 429 || THROTTLED.has(Number((body as GraphBody)?.error?.code)) || (body as GraphBody)?.error?.error_subcode === 2207042;

export class InstagramAdapter implements ChannelAdapter<InstagramCredential>, OAuthConnector<InstagramCredential> {
  readonly channel = "instagram" as const;
  readonly accountNoun = "account";
  readonly scopes = INSTAGRAM_SCOPES;
  readonly usesPkce = false;

  constructor(
    private readonly app: FacebookAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  #graph(path: string): string {
    return `https://graph.facebook.com/${this.app.version}/${path.replace(/^\//, "")}`;
  }

  async #call(method: "GET" | "POST" | "DELETE", path: string, token: string, params: Record<string, string> = {}, write = false): Promise<Record<string, unknown>> {
    const q = new URLSearchParams({ ...params, access_token: token, appsecret_proof: appSecretProof(this.app.appSecret, token) });
    const url = method === "GET" ? `${this.#graph(path)}?${q}` : this.#graph(path);
    const init: RequestInit = method === "GET" ? { method } : { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: q.toString() };
    const { json } = await callJson(this.fetchImpl, url, init, { write, classify: classifyInstagramError, retrySafe });
    if ((json as GraphBody)?.error) throw classifyInstagramError(400, json);
    return (json ?? {}) as Record<string, unknown>;
  }

  authorizeUrl({ state }: { state: string }): string {
    const q = new URLSearchParams({ client_id: this.app.appId, redirect_uri: this.app.redirectUri, state, scope: INSTAGRAM_SCOPES.join(","), response_type: "code" });
    return `https://www.facebook.com/${this.app.version}/dialog/oauth?${q}`;
  }

  async accountsFromCode({ code }: { code: string }): Promise<Array<ConnectableAccount<InstagramCredential>>> {
    const token = async (params: Record<string, string>) => {
      const { json } = await callJson(this.fetchImpl, `${this.#graph("oauth/access_token")}?${new URLSearchParams(params)}`, { method: "GET" }, { write: false, classify: classifyInstagramError });
      const t = (json as { access_token?: string } | null)?.access_token;
      if (!t) throw new PublishError("auth", "Facebook didn't return an access token.");
      return t;
    };
    const short = await token({ client_id: this.app.appId, redirect_uri: this.app.redirectUri, client_secret: this.app.appSecret, code });
    const long = await token({ grant_type: "fb_exchange_token", client_id: this.app.appId, client_secret: this.app.appSecret, fb_exchange_token: short });
    const pages = (await this.#call("GET", "me/accounts", long, { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100" })) as { data?: Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id?: string; username?: string } }> };
    const out: Array<ConnectableAccount<InstagramCredential>> = [];
    for (const p of pages.data ?? []) {
      const ig = p.instagram_business_account;
      if (!ig?.id) continue;
      const username = ig.username ?? ig.id;
      out.push({ id: ig.id, name: `@${username} (via ${p.name})`, canPost: true, credential: { igUserId: ig.id, username, pageId: p.id, pageAccessToken: p.access_token, userAccessToken: long }, tokenExpiresAt: null });
    }
    return out;
  }

  /** Creates a container; creating one publishes nothing, so trying the other token is safe. */
  async #container(cred: InstagramCredential, params: Record<string, string>): Promise<{ id: string; token: string; uri?: string }> {
    let last: unknown;
    for (const token of [cred.pageAccessToken, cred.userAccessToken]) {
      try {
        const c = await this.#call("POST", `${encodeURIComponent(cred.igUserId)}/media`, token, params);
        if (typeof c.id !== "string") throw new PublishError("transient", "Instagram didn't return a container id.");
        return { id: c.id, token, ...(typeof c.uri === "string" ? { uri: c.uri } : {}) };
      } catch (err) {
        last = err;
        if (!(err instanceof PublishError) || (err.kind !== "permission" && err.kind !== "auth")) throw err;
      }
    }
    throw last;
  }

  async #waitReady(containerId: string, token: string, video: boolean): Promise<void> {
    // Meta suggests polling about once a minute for up to 5 minutes; images are usually ready at once.
    const tries = video ? 30 : 10;
    for (let i = 0; i < tries; i++) {
      const s = (await this.#call("GET", encodeURIComponent(containerId), token, { fields: "status_code,status" })) as { status_code?: string; status?: string };
      if (s.status_code === "FINISHED") return;
      if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new PublishError("permanent", `Instagram couldn't process the ${video ? "video" : "image"} (${s.status_code}${s.status ? `: ${s.status}` : ""}).`);
      if (s.status_code === "PUBLISHED") throw new PublishError("ambiguous", "This Instagram container was already published.");
      await this.sleep(video ? 10_000 : 3_000);
    }
    throw new PublishError("transient", "Instagram is still processing the media; trying again later.");
  }

  async publish(post: PublishablePost, cred: InstagramCredential): Promise<PublishResult> {
    const media = post.media;
    if (!media) throw new PublishError("permanent", "Instagram posts need an image or a video.");
    const caption = post.text.trim();
    if ([...caption].length > CAPTION_MAX) throw new PublishError("permanent", `Instagram captions are limited to ${CAPTION_MAX} characters.`);
    let container: { id: string; token: string };
    if (media.kind === "image") {
      if (media.mime !== "image/jpeg") throw new PublishError("permanent", "Instagram only accepts JPEG images.");
      container = await this.#container(cred, { image_url: await media.publicUrl(), caption, ...(media.altText ? { alt_text: media.altText.slice(0, 1000) } : {}) });
    } else {
      container = await this.#container(cred, { media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true" });
      const bytes = await media.bytes();
      // Uploading to a container publishes nothing; failures here are safe to retry later.
      const res = await timedFetch(this.fetchImpl, `https://rupload.facebook.com/ig-api-upload/${encodeURIComponent(container.id)}`, { method: "POST", headers: { authorization: `OAuth ${container.token}`, offset: "0", file_size: String(bytes.length), "content-type": "application/octet-stream" }, body: bytes }, { idempotent: true, timeoutMs: 10 * 60_000 });
      const up = (await res.json().catch(() => null)) as { success?: boolean; debug_info?: { message?: string } } | null;
      if (!res.ok || !up?.success) throw new PublishError("transient", `Instagram video upload failed (${res.status}${up?.debug_info?.message ? `: ${up.debug_info.message}` : ""}).`);
    }
    await this.#waitReady(container.id, container.token, media.kind === "video");
    const published = await this.#call("POST", `${encodeURIComponent(cred.igUserId)}/media_publish`, container.token, { creation_id: container.id }, true);
    if (typeof published.id !== "string") throw new PublishError("ambiguous", "Instagram didn't return a post id.");
    let permalink: string | null = null;
    try {
      const p = (await this.#call("GET", encodeURIComponent(published.id), container.token, { fields: "permalink" })) as { permalink?: string };
      permalink = p.permalink && /^https:\/\//.test(p.permalink) ? p.permalink : null;
    } catch {
      /* the post is live; the link is optional */
    }
    return { externalId: published.id, permalink };
  }

  async remove(externalId: string, cred: InstagramCredential): Promise<void> {
    await this.#call("DELETE", encodeURIComponent(externalId), cred.pageAccessToken);
  }

  async check(cred: InstagramCredential): Promise<{ ok: true; accountName: string }> {
    const r = (await this.#call("GET", encodeURIComponent(cred.igUserId), cred.pageAccessToken, { fields: "username" })) as { username?: string };
    return { ok: true, accountName: `@${r.username ?? cred.username}` };
  }
}
