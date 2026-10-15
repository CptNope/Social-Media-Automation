import { createHmac } from "node:crypto";
import { PublishError, timedFetch, type ChannelAdapter, type FetchLike, type PublishablePost, type PublishResult } from "./types.ts";

/**
 * Facebook Pages adapter (Graph API). See docs/research/2026-10-publishing-apis.md.
 * Not exercised against the live API yet: requires a reviewed Meta app.
 */
export interface FacebookAppConfig {
  appId: string;
  appSecret: string;
  /** e.g. "v26.0" (latest confirmed 2026-10-15). */
  version: string;
  redirectUri: string;
}

export interface FacebookPageCredential {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
}

export const FACEBOOK_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];

const TRANSIENT = new Set([1, 2, 4, 17, 32, 341, 613, 80001]);
const AUTH = new Set([190, 102]);

export function appSecretProof(appSecret: string, token: string): string {
  return createHmac("sha256", appSecret).update(token).digest("hex");
}

export function classifyGraphError(status: number, body: unknown): PublishError {
  const e = (body as { error?: { message?: string; code?: number; error_subcode?: number; fbtrace_id?: string } } | null)?.error;
  const code = e?.code ?? 0;
  const msg = `Facebook ${status} (code ${code}${e?.error_subcode ? `/${e.error_subcode}` : ""}): ${e?.message ?? "unknown error"}`.slice(0, 500);
  if (TRANSIENT.has(code) || status >= 500) return new PublishError("transient", msg, 15 * 60_000, String(code));
  if (AUTH.has(code)) return new PublishError("auth", msg, undefined, String(code));
  if (code === 10 || (code >= 200 && code <= 299)) return new PublishError("permission", msg, undefined, String(code));
  return new PublishError("permanent", msg, undefined, String(code));
}

export class FacebookPagesAdapter implements ChannelAdapter<FacebookPageCredential> {
  readonly channel = "facebook" as const;
  constructor(
    private readonly app: FacebookAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  #graph(path: string): string {
    return `https://graph.facebook.com/${this.app.version}/${path.replace(/^\//, "")}`;
  }

  async #request(method: "GET" | "POST" | "DELETE", path: string, token: string, params: Record<string, string> = {}): Promise<unknown> {
    const body = new URLSearchParams({ ...params, access_token: token, appsecret_proof: appSecretProof(this.app.appSecret, token) });
    const url = method === "GET" ? `${this.#graph(path)}?${body}` : this.#graph(path);
    const res = await timedFetch(this.fetchImpl, url, method === "GET" ? { method } : { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
    if (!res.ok || (json as { error?: unknown } | null)?.error) {
      const err = classifyGraphError(res.status, json);
      // A server error on a write may still have created the post: never auto-retry it (no duplicates).
      const code = (json as { error?: { code?: number } } | null)?.error?.code ?? 0;
      if (method === "POST" && err.kind === "transient" && (res.status >= 500 || code === 1 || code === 2)) {
        throw new PublishError("ambiguous", `${err.message} — the post may or may not have been created.`, undefined, err.platformCode);
      }
      throw err;
    }
    return json;
  }

  // -------------------------------------------------------------- OAuth
  authorizeUrl(state: string): string {
    const q = new URLSearchParams({ client_id: this.app.appId, redirect_uri: this.app.redirectUri, state, scope: FACEBOOK_SCOPES.join(","), response_type: "code" });
    return `https://www.facebook.com/${this.app.version}/dialog/oauth?${q}`;
  }

  /** Code → short-lived user token → long-lived user token → the Pages this person manages. */
  async pagesFromCode(code: string): Promise<Array<{ id: string; name: string; accessToken: string; canPost: boolean }>> {
    const get = async (params: Record<string, string>) => {
      const res = await timedFetch(this.fetchImpl, `${this.#graph("oauth/access_token")}?${new URLSearchParams(params)}`, { method: "GET" });
      const json = (await res.json().catch(() => null)) as { access_token?: string; error?: unknown } | null;
      if (!res.ok || !json?.access_token) throw classifyGraphError(res.status, json);
      return json.access_token;
    };
    const shortLived = await get({ client_id: this.app.appId, redirect_uri: this.app.redirectUri, client_secret: this.app.appSecret, code });
    const longLived = await get({ grant_type: "fb_exchange_token", client_id: this.app.appId, client_secret: this.app.appSecret, fb_exchange_token: shortLived });
    const accounts = (await this.#request("GET", "me/accounts", longLived, { fields: "id,name,access_token,tasks", limit: "100" })) as { data?: Array<{ id: string; name: string; access_token: string; tasks?: string[] }> };
    return (accounts.data ?? []).map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token, canPost: (p.tasks ?? []).includes("CREATE_CONTENT") }));
  }

  // -------------------------------------------------------------- publishing
  async publish(post: PublishablePost, cred: FacebookPageCredential): Promise<PublishResult> {
    const params: Record<string, string> = { message: post.text };
    if (post.link) params.link = post.link.url;
    const out = (await this.#request("POST", `${encodeURIComponent(cred.pageId)}/feed`, cred.pageAccessToken, params)) as { id?: string };
    if (!out.id) throw new PublishError("ambiguous", "Facebook didn't return a post id.");
    const [pageId, postId] = out.id.split("_");
    return { externalId: out.id, permalink: pageId && postId ? `https://www.facebook.com/${pageId}/posts/${postId}` : null };
  }

  async remove(externalId: string, cred: FacebookPageCredential): Promise<void> {
    await this.#request("DELETE", encodeURIComponent(externalId), cred.pageAccessToken);
  }

  async check(cred: FacebookPageCredential): Promise<{ ok: true; accountName: string }> {
    const me = (await this.#request("GET", encodeURIComponent(cred.pageId), cred.pageAccessToken, { fields: "id,name" })) as { name?: string };
    return { ok: true, accountName: me.name ?? cred.pageName };
  }
}
