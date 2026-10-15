import { PublishError, callJson, expiresAtFrom, retryAfterMs, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult, type RefreshedCredential, type TokenRefresher } from "./types.ts";

/**
 * Google Business Profile adapter: Google OAuth with PKCE and offline access, short-lived access
 * tokens refreshed before each send, STANDARD local posts (v4) with a "Learn more" button for
 * the link. See docs/research/2026-10-more-platforms.md.
 */
export interface GoogleAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GbpCredential {
  /** v4 parent: accounts/{accountId}/locations/{locationId} */
  locationName: string;
  title: string;
  accessToken: string;
  refreshToken: string;
}

export const GBP_SCOPES = ["https://www.googleapis.com/auth/business.manage"] as const;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_PAGES = 5;

export function classifyGoogleError(status: number, body: unknown, res?: Response): PublishError {
  const b = body as { error?: { code?: number; message?: string; status?: string } | string; error_description?: string } | null;
  const e = typeof b?.error === "object" ? b.error : null;
  const tokenError = typeof b?.error === "string" ? b.error : null;
  const msg = `Google ${status}${e?.status ? ` ${e.status}` : tokenError ? ` ${tokenError}` : ""}: ${e?.message ?? b?.error_description ?? "unknown error"}`.slice(0, 500);
  const code = e?.status ?? tokenError ?? String(status);
  if (status === 401 || tokenError === "invalid_grant" || e?.status === "UNAUTHENTICATED") return new PublishError("auth", msg, undefined, code);
  if (status === 429 || e?.status === "RESOURCE_EXHAUSTED") return new PublishError("transient", msg, res ? retryAfterMs(res) : undefined, code);
  if (status === 403 || e?.status === "PERMISSION_DENIED") return new PublishError("permission", msg, undefined, code);
  if (status >= 500) return new PublishError("transient", msg, undefined, code);
  return new PublishError("permanent", msg, undefined, code);
}

export class GoogleBusinessAdapter implements ChannelAdapter<GbpCredential>, OAuthConnector<GbpCredential> {
  readonly channel = "google_business_profile" as const;
  readonly accountNoun = "location";
  readonly scopes = GBP_SCOPES;
  readonly usesPkce = true;

  constructor(
    private readonly app: GoogleAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authorizeUrl({ state, codeChallenge }: { state: string; codeChallenge?: string }): string {
    if (!codeChallenge) throw new Error("PKCE challenge required");
    const q = new URLSearchParams({
      client_id: this.app.clientId,
      redirect_uri: this.app.redirectUri,
      response_type: "code",
      scope: GBP_SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  async #token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const { json } = await callJson(
      this.fetchImpl,
      TOKEN_URL,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...params }).toString() },
      { write: false, classify: (s, b, r) => (s === 400 ? new PublishError("auth", `Google sign-in failed: ${(b as { error_description?: string; error?: string } | null)?.error_description ?? (b as { error?: string } | null)?.error ?? "invalid grant"}`, undefined, "invalid_grant") : classifyGoogleError(s, b, r)) },
    );
    const t = json as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!t?.access_token) throw new PublishError("auth", "Google didn't return an access token.");
    return t as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  async #get(url: string, token: string): Promise<unknown> {
    return (await callJson(this.fetchImpl, url, { method: "GET", headers: { authorization: `Bearer ${token}` } }, { write: false, classify: classifyGoogleError })).json;
  }

  async accountsFromCode({ code, codeVerifier }: { code: string; codeVerifier?: string }): Promise<Array<ConnectableAccount<GbpCredential>>> {
    if (!codeVerifier) throw new Error("PKCE verifier required");
    const t = await this.#token({ grant_type: "authorization_code", code, redirect_uri: this.app.redirectUri, code_verifier: codeVerifier });
    if (!t.refresh_token) throw new PublishError("permanent", "Google didn't return a refresh token. Remove JAT's access in your Google account settings and connect again.");
    const expires = expiresAtFrom(t.expires_in);
    const out = new Map<string, ConnectableAccount<GbpCredential>>();
    let pageToken = "";
    for (let p = 0; p < MAX_PAGES; p++) {
      const accounts = (await this.#get(`https://mybusinessaccountmanagement.googleapis.com/v1/accounts?${new URLSearchParams({ pageSize: "20", ...(pageToken ? { pageToken } : {}) })}`, t.access_token)) as { accounts?: Array<{ name?: string }>; nextPageToken?: string };
      for (const a of accounts?.accounts ?? []) {
        if (!a.name || !/^accounts\/[\w-]+$/.test(a.name)) continue;
        let locToken = "";
        for (let q = 0; q < MAX_PAGES; q++) {
          const locs = (await this.#get(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?${new URLSearchParams({ readMask: "name,title,metadata", pageSize: "100", ...(locToken ? { pageToken: locToken } : {}) })}`, t.access_token)) as { locations?: Array<{ name?: string; title?: string; metadata?: { canOperateLocalPost?: boolean } }>; nextPageToken?: string };
          for (const l of locs?.locations ?? []) {
            const id = /^locations\/([\w-]+)$/.exec(l.name ?? "")?.[1];
            // The same location can appear under several accounts (personal + group): keep the first.
            if (!id || out.has(id)) continue;
            const canPost = l.metadata?.canOperateLocalPost !== false;
            const title = l.title ?? `Location ${id}`;
            out.set(id, { id, name: title, canPost, ...(canPost ? {} : { reason: "Google doesn't allow posts for this location" }), credential: { locationName: `${a.name}/locations/${id}`, title, accessToken: t.access_token, refreshToken: t.refresh_token }, tokenExpiresAt: expires });
          }
          if (!locs?.nextPageToken) break;
          locToken = locs.nextPageToken;
        }
      }
      if (!accounts?.nextPageToken) break;
      pageToken = accounts.nextPageToken;
    }
    return [...out.values()];
  }

  /** Access tokens last about an hour (use expires_in); refresh shortly before each send. */
  readonly refresh: TokenRefresher<GbpCredential> = {
    windowMs: 15 * 60_000,
    keepAlive: false,
    run: async (cred): Promise<RefreshedCredential<GbpCredential>> => {
      const t = await this.#token({ grant_type: "refresh_token", refresh_token: cred.refreshToken });
      return { credential: { ...cred, accessToken: t.access_token, refreshToken: t.refresh_token ?? cred.refreshToken }, tokenExpiresAt: expiresAtFrom(t.expires_in) };
    },
  };

  async publish(post: PublishablePost, cred: GbpCredential): Promise<PublishResult> {
    if (!/^accounts\/[\w-]+\/locations\/[\w-]+$/.test(cred.locationName)) throw new PublishError("permanent", "Stored location is invalid; reconnect Google Business Profile.");
    const body: Record<string, unknown> = { languageCode: "en-US", summary: post.text.trim(), topicType: "STANDARD" };
    if (post.link) body.callToAction = { actionType: "LEARN_MORE", url: post.link.url };
    const { json } = await callJson(
      this.fetchImpl,
      `https://mybusiness.googleapis.com/v4/${cred.locationName}/localPosts`,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cred.accessToken}` }, body: JSON.stringify(body) },
      { write: true, classify: classifyGoogleError },
    );
    const lp = json as { name?: string; searchUrl?: string; state?: string } | null;
    if (!lp?.name) throw new PublishError("ambiguous", "Google didn't return the post.");
    if (lp.state === "REJECTED") throw new PublishError("permanent", `Google rejected the post (${lp.name}). Check it in Business Profile.`);
    return { externalId: lp.name, permalink: lp.searchUrl && /^https:\/\//.test(lp.searchUrl) ? lp.searchUrl : null };
  }

  async remove(externalId: string, cred: GbpCredential): Promise<void> {
    if (!/^accounts\/[\w-]+\/locations\/[\w-]+\/localPosts\/[\w-]+$/.test(externalId)) throw new PublishError("permanent", "Not a Business Profile post name.");
    await callJson(this.fetchImpl, `https://mybusiness.googleapis.com/v4/${externalId}`, { method: "DELETE", headers: { authorization: `Bearer ${cred.accessToken}` } }, { write: false, classify: classifyGoogleError });
  }

  async check(cred: GbpCredential): Promise<{ ok: true; accountName: string }> {
    const id = cred.locationName.split("/").pop()!;
    const l = (await this.#get(`https://mybusinessbusinessinformation.googleapis.com/v1/locations/${encodeURIComponent(id)}?readMask=title`, cred.accessToken)) as { title?: string };
    return { ok: true, accountName: l?.title ?? cred.title };
  }
}
