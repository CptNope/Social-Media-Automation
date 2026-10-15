import { classifyGraphError } from "./facebook.ts";
import { PublishError, callJson, expiresAtFrom, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult, type RefreshedCredential, type TokenRefresher } from "./types.ts";

/**
 * Threads adapter: OAuth → long-lived (60-day) token, refreshed in the background before it
 * lapses; text posts with an optional link attachment, published in two steps (container →
 * publish). See docs/research/2026-10-more-platforms.md.
 */
export interface ThreadsAppConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  /** graph.threads.net or graph.threads.com (both documented). */
  graphHost?: string;
  /** threads.com (current docs) — configurable in case it changes again. */
  authHost?: string;
}

export interface ThreadsCredential {
  userId: string;
  username: string;
  accessToken: string;
}

export const THREADS_SCOPES = ["threads_basic", "threads_content_publish", "threads_delete"] as const;
const MAX_CHARS = 500;

const classify = (status: number, body: unknown): PublishError => classifyGraphError(status, body, "Threads");
/** Graph throttling codes (and HTTP 429) mean the request was refused, so a publish can be retried. */
const THROTTLED = new Set([4, 17, 32, 341, 613, 80001]);
const retrySafe = (status: number, body: unknown): boolean => status === 429 || THROTTLED.has(Number((body as { error?: { code?: number } } | null)?.error?.code));

export class ThreadsAdapter implements ChannelAdapter<ThreadsCredential>, OAuthConnector<ThreadsCredential> {
  readonly channel = "threads" as const;
  readonly accountNoun = "account";
  readonly scopes = THREADS_SCOPES;
  readonly usesPkce = false;
  readonly #graph: string;

  constructor(
    private readonly app: ThreadsAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
    /** Waits between container checks (injectable for tests). */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.#graph = `https://${app.graphHost ?? "graph.threads.net"}`;
  }

  authorizeUrl({ state }: { state: string }): string {
    const q = new URLSearchParams({ client_id: this.app.appId, redirect_uri: this.app.redirectUri, scope: THREADS_SCOPES.join(","), response_type: "code", state });
    return `https://${this.app.authHost ?? "threads.com"}/oauth/authorize?${q}`;
  }

  async #get(path: string, params: Record<string, string>): Promise<unknown> {
    return (await callJson(this.fetchImpl, `${this.#graph}/${path}?${new URLSearchParams(params)}`, { method: "GET" }, { write: false, classify })).json;
  }

  async #post(path: string, params: Record<string, string>, write: boolean): Promise<unknown> {
    return (await callJson(this.fetchImpl, `${this.#graph}/${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }, { write, classify, retrySafe })).json;
  }

  async accountsFromCode({ code }: { code: string }): Promise<Array<ConnectableAccount<ThreadsCredential>>> {
    const short = (await this.#post("oauth/access_token", { client_id: this.app.appId, client_secret: this.app.appSecret, code, grant_type: "authorization_code", redirect_uri: this.app.redirectUri }, false)) as { access_token?: string };
    if (!short?.access_token) throw new PublishError("auth", "Threads didn't return an access token.");
    const long = (await this.#get("access_token", { grant_type: "th_exchange_token", client_secret: this.app.appSecret, access_token: short.access_token })) as { access_token?: string; expires_in?: number };
    if (!long?.access_token) throw new PublishError("auth", "Threads didn't return a long-lived token.");
    const me = await this.#me(long.access_token);
    return [{ id: me.id, name: `@${me.username}`, canPost: true, credential: { userId: me.id, username: me.username, accessToken: long.access_token }, tokenExpiresAt: expiresAtFrom(long.expires_in) }];
  }

  async #me(token: string): Promise<{ id: string; username: string }> {
    const me = (await this.#get("v1.0/me", { fields: "id,username", access_token: token })) as { id?: string; username?: string };
    if (!me?.id || !me.username) throw new PublishError("permanent", "Threads didn't return the account.");
    return { id: me.id, username: me.username };
  }

  /** 60-day tokens; refreshable once ≥ 24 h old and before expiry — so keep them alive in the background. */
  readonly refresh: TokenRefresher<ThreadsCredential> = {
    windowMs: 7 * 24 * 3_600_000,
    keepAlive: true,
    run: async (cred): Promise<RefreshedCredential<ThreadsCredential>> => {
      const t = (await this.#get("refresh_access_token", { grant_type: "th_refresh_token", access_token: cred.accessToken })) as { access_token?: string; expires_in?: number };
      if (!t?.access_token) throw new PublishError("auth", "Threads didn't refresh the token.");
      // A refreshed token lasts 60 days; never store "no expiry" (it would stop the keep-alive).
      return { credential: { ...cred, accessToken: t.access_token }, tokenExpiresAt: expiresAtFrom(t.expires_in) ?? new Date(Date.now() + 60 * 86_400_000).toISOString() };
    },
  };

  async publish(post: PublishablePost, cred: ThreadsCredential): Promise<PublishResult> {
    const text = post.text.trim();
    if ([...text].length > MAX_CHARS) throw new PublishError("permanent", `Threads posts are limited to ${MAX_CHARS} characters; this one has ${[...text].length}.`);
    const params: Record<string, string> = { media_type: "TEXT", text, access_token: cred.accessToken };
    if (post.link) params.link_attachment = post.link.url;
    // Creating a container publishes nothing, so it is safe to repeat.
    const container = (await this.#post(`v1.0/${encodeURIComponent(cred.userId)}/threads`, params, false)) as { id?: string };
    if (!container?.id) throw new PublishError("transient", "Threads didn't return a container id.");
    await this.#waitReady(container.id, cred.accessToken);
    const published = (await this.#post(`v1.0/${encodeURIComponent(cred.userId)}/threads_publish`, { creation_id: container.id, access_token: cred.accessToken }, true)) as { id?: string };
    if (!published?.id) throw new PublishError("ambiguous", "Threads didn't return a post id.");
    let permalink: string | null = null;
    try {
      permalink = ((await this.#get(encodeURIComponent(published.id), { fields: "permalink", access_token: cred.accessToken })) as { permalink?: string }).permalink ?? null;
    } catch {
      /* the post is live; the link is optional (absent for flagged media) */
    }
    return { externalId: published.id, permalink };
  }

  /** Meta recommends waiting before publishing a container; poll its status (max ~30 s). */
  async #waitReady(containerId: string, token: string): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const c = (await this.#get(encodeURIComponent(containerId), { fields: "status,error_message", access_token: token })) as { status?: string; error_message?: string };
      if (c.status === "FINISHED" || c.status === undefined) return;
      if (c.status === "ERROR" || c.status === "EXPIRED") throw new PublishError("permanent", `Threads couldn't prepare the post (${c.status}${c.error_message ? `: ${c.error_message}` : ""}).`);
      if (c.status === "PUBLISHED") throw new PublishError("ambiguous", "This Threads container was already published.");
      await this.sleep(3_000);
    }
    throw new PublishError("transient", "Threads is still preparing the post; trying again later.");
  }

  async remove(externalId: string, cred: ThreadsCredential): Promise<void> {
    await callJson(this.fetchImpl, `${this.#graph}/v1.0/${encodeURIComponent(externalId)}?${new URLSearchParams({ access_token: cred.accessToken })}`, { method: "DELETE" }, { write: false, classify });
  }

  async check(cred: ThreadsCredential): Promise<{ ok: true; accountName: string }> {
    return { ok: true, accountName: `@${(await this.#me(cred.accessToken)).username}` };
  }
}
