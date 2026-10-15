import { createHash, createHmac, randomBytes } from "node:crypto";
import { PublishError, timedFetch, type FetchLike } from "./types.ts";

/**
 * Client for the JAT Connector WordPress plugin (wordpress-plugin/jat-connector).
 *
 * Every request carries:
 *  - WordPress Application Password (HTTP Basic) for a dedicated, least-privilege user
 *  - X-JAT-Timestamp, X-JAT-Nonce, X-JAT-Signature: hex HMAC-SHA256(secret,
 *      METHOD \n ROUTE \n TIMESTAMP \n NONCE \n hex(SHA-256(body)))
 *    The plugin rejects stale timestamps (±300 s) and reused nonces.
 *
 * The caller must pass an SSRF-safe fetch (createSafeFetch from @jat/ingest) because the
 * site URL is user-supplied.
 */
export interface WordPressCredential {
  siteUrl: string;
  username: string;
  applicationPassword: string;
  /** Shared secret also entered in the plugin's settings page. */
  signingSecret: string;
}

export function signWordPressRequest(secret: string, method: string, route: string, body: string, timestamp: number, nonce: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret).update(`${method.toUpperCase()}\n${route}\n${timestamp}\n${nonce}\n${bodyHash}`).digest("hex");
}

export interface SeoFields {
  title?: string;
  description?: string;
}

export interface SeoChange {
  changeId: string;
  plugin: "yoast" | "rankmath" | "aioseo" | "none";
  before: SeoFields;
  after: SeoFields;
}

export class WordPressClient {
  constructor(
    private readonly cred: WordPressCredential,
    private readonly fetchImpl: FetchLike,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    const u = new URL(cred.siteUrl);
    if (u.protocol !== "https:") throw new PublishError("permanent", "The WordPress site must use https.");
  }

  async #call<T>(method: "GET" | "POST", route: string, payload?: unknown): Promise<T> {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const ts = this.now();
    const nonce = randomBytes(16).toString("hex");
    const url = `${new URL(this.cred.siteUrl).origin}${new URL(this.cred.siteUrl).pathname.replace(/\/$/, "")}/?rest_route=${encodeURIComponent(route)}`;
    const res = await timedFetch(this.fetchImpl, url, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.cred.username}:${this.cred.applicationPassword}`).toString("base64")}`,
        "content-type": "application/json",
        "x-jat-timestamp": String(ts),
        "x-jat-nonce": nonce,
        "x-jat-signature": signWordPressRequest(this.cred.signingSecret, method, route, body, ts, nonce),
      },
      ...(method === "POST" ? { body } : {}),
    });
    const json = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    if (!res.ok) {
      const msg = `WordPress ${res.status}${json?.code ? ` ${json.code}` : ""}: ${json?.message ?? res.statusText}`.slice(0, 500);
      if (res.status === 401 || res.status === 403) throw new PublishError(json?.code?.startsWith("jat_signature") ? "permanent" : "auth", msg, undefined, json?.code);
      if (res.status === 404 && json?.code === "rest_no_route") throw new PublishError("permanent", "The JAT Connector plugin isn't active on this site.", undefined, json.code);
      if (res.status === 429 || res.status >= 500) throw new PublishError("transient", msg, undefined, json?.code);
      throw new PublishError("permanent", msg, undefined, json?.code);
    }
    return json as T;
  }

  health() {
    return this.#call<{ ok: boolean; plugin_version: string; wordpress_version: string; seo_plugin: SeoChange["plugin"]; user: string; can_publish: boolean }>("GET", "/jat/v1/health");
  }

  createPost(p: { title: string; content: string; excerpt?: string; status: "draft" | "future"; dateGmt?: string }) {
    return this.#call<{ id: number; status: string; link: string; edit_link: string }>("POST", "/jat/v1/posts", { title: p.title, content: p.content, excerpt: p.excerpt ?? "", status: p.status, ...(p.dateGmt ? { date_gmt: p.dateGmt } : {}) });
  }

  getSeo(postId: number) {
    return this.#call<{ post_id: number; plugin: SeoChange["plugin"]; fields: SeoFields }>("GET", `/jat/v1/posts/${postId}/seo`);
  }

  updateSeo(postId: number, fields: SeoFields, changeId: string) {
    return this.#call<SeoChange>("POST", `/jat/v1/posts/${postId}/seo`, { change_id: changeId, fields });
  }

  rollback(changeId: string) {
    return this.#call<{ rolled_back: boolean; post_id: number; restored: SeoFields }>("POST", `/jat/v1/changes/${encodeURIComponent(changeId)}/rollback`, {});
  }
}
