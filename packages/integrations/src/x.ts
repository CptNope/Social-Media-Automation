import { xWeightedLength } from "@jat/core";
import { PublishError, callJson, expiresAtFrom, resetHeaderMs, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult, type RefreshedCredential, type TokenRefresher } from "./types.ts";

/**
 * X (Twitter) API v2 adapter: OAuth 2.0 with PKCE, 2-hour access tokens refreshed with
 * `offline.access`, text posts with the link inside the text. See docs/research/2026-10-more-platforms.md.
 * Pay-per-use: $0.015 per post, $0.20 per post containing a URL.
 */
export interface XAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface XCredential {
  userId: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "offline.access"] as const;
const API = "https://api.x.com";
const MAX_WEIGHTED = 280;

export function classifyXError(status: number, body: unknown, res?: Response): PublishError {
  const b = body as { title?: string; detail?: string; type?: string; errors?: Array<{ message?: string; code?: number }>; error?: string; error_description?: string } | null;
  const detail = b?.detail ?? b?.errors?.[0]?.message ?? b?.error_description ?? b?.title ?? b?.error ?? "unknown error";
  const msg = `X ${status}: ${detail}`.slice(0, 500);
  if (status === 429) return new PublishError("transient", msg, res ? resetHeaderMs(res, "x-rate-limit-reset") : undefined, "429");
  if (status === 401 || b?.error === "invalid_grant") return new PublishError("auth", msg, undefined, String(status));
  // Duplicate-content wording is UNVERIFIED in X's docs; treat it as a content problem, not a permission one.
  if (status === 403 && /duplicate/i.test(detail)) return new PublishError("permanent", msg, undefined, "duplicate");
  if (status === 403) return new PublishError("permission", msg, undefined, "403");
  if (status >= 500) return new PublishError("transient", msg, undefined, String(status));
  return new PublishError("permanent", msg, undefined, String(status));
}

export class XAdapter implements ChannelAdapter<XCredential>, OAuthConnector<XCredential> {
  readonly channel = "x" as const;
  readonly accountNoun = "account";
  readonly scopes = X_SCOPES;
  readonly usesPkce = true;

  constructor(
    private readonly app: XAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authorizeUrl({ state, codeChallenge }: { state: string; codeChallenge?: string }): string {
    if (!codeChallenge) throw new Error("X requires PKCE");
    const q = new URLSearchParams({ response_type: "code", client_id: this.app.clientId, redirect_uri: this.app.redirectUri, scope: X_SCOPES.join(" "), state, code_challenge: codeChallenge, code_challenge_method: "S256" });
    return `https://x.com/i/oauth2/authorize?${q}`;
  }

  async #token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const { json } = await callJson(
      this.fetchImpl,
      `${API}/2/oauth2/token`,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${this.app.clientId}:${this.app.clientSecret}`).toString("base64")}` }, body: new URLSearchParams(params).toString() },
      { write: false, classify: (s, b, r) => (s === 400 ? new PublishError("auth", `X sign-in failed: ${(b as { error_description?: string } | null)?.error_description ?? "invalid grant"}`) : classifyXError(s, b, r)) },
    );
    const t = json as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!t?.access_token) throw new PublishError("auth", "X didn't return an access token.");
    return t as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  async #me(accessToken: string): Promise<{ id: string; username: string; name?: string }> {
    const { json } = await callJson(this.fetchImpl, `${API}/2/users/me`, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } }, { write: false, classify: classifyXError });
    const d = (json as { data?: { id?: string; username?: string; name?: string } } | null)?.data;
    if (!d?.id || !d.username) throw new PublishError("permanent", "X didn't return the account.");
    return d as { id: string; username: string; name?: string };
  }

  async accountsFromCode({ code, codeVerifier }: { code: string; codeVerifier?: string }): Promise<Array<ConnectableAccount<XCredential>>> {
    if (!codeVerifier) throw new Error("X requires PKCE");
    const t = await this.#token({ grant_type: "authorization_code", code, redirect_uri: this.app.redirectUri, code_verifier: codeVerifier });
    if (!t.refresh_token) throw new PublishError("permanent", "X didn't return a refresh token (offline.access).");
    const me = await this.#me(t.access_token);
    return [{ id: me.id, name: `@${me.username}`, canPost: true, credential: { userId: me.id, username: me.username, accessToken: t.access_token, refreshToken: t.refresh_token }, tokenExpiresAt: expiresAtFrom(t.expires_in) }];
  }

  /** 2-hour access tokens. Always keep the newest refresh token (rotation is UNVERIFIED). */
  readonly refresh: TokenRefresher<XCredential> = {
    windowMs: 30 * 60_000,
    keepAlive: false,
    run: async (cred): Promise<RefreshedCredential<XCredential>> => {
      const t = await this.#token({ grant_type: "refresh_token", refresh_token: cred.refreshToken });
      return { credential: { ...cred, accessToken: t.access_token, refreshToken: t.refresh_token ?? cred.refreshToken }, tokenExpiresAt: expiresAtFrom(t.expires_in) };
    },
  };

  /** X has no link field: the link goes at the end of the text (matching publishedText in @jat/core). */
  static textFor(post: PublishablePost): string {
    const text = post.text.trim();
    return post.link ? `${text}\n\n${post.link.url}` : text;
  }

  async publish(post: PublishablePost, cred: XCredential): Promise<PublishResult> {
    const text = XAdapter.textFor(post);
    const len = xWeightedLength(text);
    if (len > MAX_WEIGHTED) throw new PublishError("permanent", `X posts are limited to ${MAX_WEIGHTED} characters (links count 23, emoji 2); this one has ${len}.`);
    const { json } = await callJson(this.fetchImpl, `${API}/2/tweets`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cred.accessToken}` }, body: JSON.stringify({ text }) }, { write: true, classify: classifyXError });
    const id = (json as { data?: { id?: string } } | null)?.data?.id;
    if (!id) throw new PublishError("ambiguous", "X didn't return a post id.");
    return { externalId: id, permalink: `https://x.com/${encodeURIComponent(cred.username)}/status/${encodeURIComponent(id)}` };
  }

  async remove(externalId: string, cred: XCredential): Promise<void> {
    await callJson(this.fetchImpl, `${API}/2/tweets/${encodeURIComponent(externalId)}`, { method: "DELETE", headers: { authorization: `Bearer ${cred.accessToken}` } }, { write: false, classify: classifyXError });
  }

  async check(cred: XCredential): Promise<{ ok: true; accountName: string }> {
    return { ok: true, accountName: `@${(await this.#me(cred.accessToken)).username}` };
  }
}
