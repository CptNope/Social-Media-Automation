import { PublishError, callJson, expiresAtFrom, retryAfterMs, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult } from "./types.ts";

/**
 * LinkedIn Company Page adapter (Community Management API, Posts API). Access tokens last 60
 * days and refresh tokens are partner-only, so connections must be renewed by a person —
 * the Connections page warns before expiry. See docs/research/2026-10-more-platforms.md.
 */
export interface LinkedInAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Linkedin-Version header (YYYYMM). 202610 is the newest active version (sunsets 2027-10-15). */
  version?: string;
}

export interface LinkedInCredential {
  organizationUrn: string;
  organizationName: string;
  accessToken: string;
}

export const LINKEDIN_SCOPES = ["w_organization_social", "r_organization_admin"] as const;
export const LINKEDIN_DEFAULT_VERSION = "202610";
const API = "https://api.linkedin.com/rest";
/** Roles that may publish organic posts for a Page. */
const POSTING_ROLES = new Set(["ADMINISTRATOR", "CONTENT_ADMINISTRATOR"]);

/** LinkedIn "little text format": these characters must be backslash-escaped in commentary. */
export function escapeLittleText(s: string): string {
  return s.replace(/[|{}@[\]()<>#\\*_~]/g, (c) => `\\${c}`);
}

export function classifyLinkedInError(status: number, body: unknown, res?: Response): PublishError {
  const b = body as { message?: string; serviceErrorCode?: number; error?: string; error_description?: string } | null;
  const msg = `LinkedIn ${status}${b?.serviceErrorCode ? ` (${b.serviceErrorCode})` : ""}: ${b?.message ?? b?.error_description ?? b?.error ?? "unknown error"}`.slice(0, 500);
  const code = b?.serviceErrorCode ? String(b.serviceErrorCode) : String(status);
  if (status === 401) return new PublishError("auth", msg, undefined, code);
  if (status === 403) return new PublishError("permission", msg, undefined, code);
  if (status === 429) return new PublishError("transient", msg, res ? retryAfterMs(res) : undefined, code);
  // 409 CONFLICT is documented as retryable; nothing was created.
  if (status === 409 || status >= 500) return new PublishError("transient", msg, undefined, code);
  return new PublishError("permanent", msg, undefined, code);
}

export class LinkedInAdapter implements ChannelAdapter<LinkedInCredential>, OAuthConnector<LinkedInCredential> {
  readonly channel = "linkedin" as const;
  readonly accountNoun = "Company Page";
  readonly scopes = LINKEDIN_SCOPES;
  readonly usesPkce = false;

  constructor(
    private readonly app: LinkedInAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  #headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${token}`, "linkedin-version": this.app.version ?? LINKEDIN_DEFAULT_VERSION, "x-restli-protocol-version": "2.0.0", ...extra };
  }

  authorizeUrl({ state }: { state: string }): string {
    const q = new URLSearchParams({ response_type: "code", client_id: this.app.clientId, redirect_uri: this.app.redirectUri, state, scope: LINKEDIN_SCOPES.join(" ") });
    return `https://www.linkedin.com/oauth/v2/authorization?${q}`;
  }

  async accountsFromCode({ code }: { code: string }): Promise<Array<ConnectableAccount<LinkedInCredential>>> {
    const { json: tok } = await callJson(
      this.fetchImpl,
      "https://www.linkedin.com/oauth/v2/accessToken",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: this.app.clientId, client_secret: this.app.clientSecret, redirect_uri: this.app.redirectUri }).toString() },
      { write: false, classify: (s, b, r) => (s === 400 || s === 401 ? new PublishError("auth", "LinkedIn sign-in failed; try again.") : classifyLinkedInError(s, b, r)) },
    );
    const t = tok as { access_token?: string; expires_in?: number };
    if (!t?.access_token) throw new PublishError("auth", "LinkedIn didn't return an access token.");
    const expires = expiresAtFrom(t.expires_in);
    const { json } = await callJson(this.fetchImpl, `${API}/organizationAcls?${new URLSearchParams({ q: "roleAssignee", state: "APPROVED", count: "100" })}`, { method: "GET", headers: this.#headers(t.access_token) }, { write: false, classify: classifyLinkedInError });
    // The docs show both `organizationTarget` and `organization` for this field.
    const roles = new Map<string, Set<string>>();
    for (const e of ((json as { elements?: Array<{ role?: string; organizationTarget?: string; organization?: string }> } | null)?.elements ?? [])) {
      const urn = e.organizationTarget ?? e.organization;
      if (!urn || !/^urn:li:organization:\d+$/.test(urn)) continue;
      if (!roles.has(urn)) roles.set(urn, new Set());
      if (e.role) roles.get(urn)!.add(e.role);
    }
    const out: Array<ConnectableAccount<LinkedInCredential>> = [];
    for (const [urn, set] of roles) {
      const name = await this.#orgName(urn, t.access_token).catch(() => `Organization ${urn.split(":").pop()}`);
      const canPost = [...set].some((r) => POSTING_ROLES.has(r));
      out.push({ id: urn, name, canPost, ...(canPost ? {} : { reason: "your role on this Page can't post (needs Super admin or Content admin)" }), credential: { organizationUrn: urn, organizationName: name, accessToken: t.access_token }, tokenExpiresAt: expires });
    }
    return out;
  }

  async #orgName(urn: string, token: string): Promise<string> {
    const id = urn.split(":").pop()!;
    const { json } = await callJson(this.fetchImpl, `${API}/organizations/${encodeURIComponent(id)}`, { method: "GET", headers: this.#headers(token) }, { write: false, classify: classifyLinkedInError });
    const name = (json as { localizedName?: string } | null)?.localizedName;
    if (!name) throw new PublishError("permanent", "LinkedIn didn't return the Page name.");
    return name;
  }

  async publish(post: PublishablePost, cred: LinkedInCredential): Promise<PublishResult> {
    const body: Record<string, unknown> = {
      author: cred.organizationUrn,
      commentary: escapeLittleText(post.text.trim()),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (post.link) body.content = { article: { source: post.link.url, title: post.link.title.slice(0, 200), description: post.link.description.slice(0, 300) } };
    const { res } = await callJson(this.fetchImpl, `${API}/posts`, { method: "POST", headers: this.#headers(cred.accessToken, { "content-type": "application/json" }), body: JSON.stringify(body) }, { write: true, classify: classifyLinkedInError, retrySafe: (st) => st === 429 || st === 409 });
    const urn = res.headers.get("x-restli-id");
    if (!urn || !/^urn:li:(share|ugcPost):\d+$/.test(urn)) throw new PublishError("ambiguous", "LinkedIn accepted the post but didn't return its id.");
    return { externalId: urn, permalink: `https://www.linkedin.com/feed/update/${urn}/` };
  }

  async remove(externalId: string, cred: LinkedInCredential): Promise<void> {
    await callJson(this.fetchImpl, `${API}/posts/${encodeURIComponent(externalId)}`, { method: "DELETE", headers: this.#headers(cred.accessToken) }, { write: false, classify: classifyLinkedInError });
  }

  async check(cred: LinkedInCredential): Promise<{ ok: true; accountName: string }> {
    return { ok: true, accountName: await this.#orgName(cred.organizationUrn, cred.accessToken) };
  }
}
