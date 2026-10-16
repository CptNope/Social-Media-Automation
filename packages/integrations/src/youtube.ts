import { classifyGoogleError, type GoogleAppConfig } from "./google-business.ts";
import { PublishError, callJson, expiresAtFrom, jsonOrNull, timedFetch, type ChannelAdapter, type ConnectableAccount, type FetchLike, type OAuthConnector, type PublishablePost, type PublishResult, type RefreshedCredential, type TokenRefresher } from "./types.ts";

/**
 * YouTube Data API v3 uploads (vertical videos up to 3 minutes become Shorts automatically).
 * Resumable upload: if the byte transfer is interrupted, the upload session is asked whether it
 * finished — so an interrupted upload is checked, not guessed at, and never uploaded twice.
 * See docs/research/2026-10-media-platforms.md.
 */
export interface YouTubeCredential {
  channelId: string;
  title: string;
  accessToken: string;
  refreshToken: string;
}

export const YOUTUBE_SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"] as const;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const youtubeReason = (body: unknown) => (body as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors?.[0]?.reason ?? "";

export function classifyYouTubeError(status: number, body: unknown, res?: Response): PublishError {
  const reason = youtubeReason(body);
  if (["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason)) {
    return new PublishError("transient", `YouTube ${status} ${reason}: the daily upload quota is used up; trying again later.`, 6 * 3_600_000, reason);
  }
  if (reason === "uploadLimitExceeded") return new PublishError("transient", "YouTube: this channel reached its daily upload limit; trying again later.", 6 * 3_600_000, reason);
  if (reason === "youtubeSignupRequired") return new PublishError("permission", "This Google account has no YouTube channel.", undefined, reason);
  const e = classifyGoogleError(status, body, res);
  return new PublishError(e.kind, e.message.replace(/^Google/, "YouTube"), e.retryAfterMs, reason || e.platformCode);
}

const clean = (s: string) => s.replace(/[<>]/g, "");
function utf8Slice(s: string, maxBytes: number): string {
  let out = "";
  for (const ch of s) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}

export class YouTubeAdapter implements ChannelAdapter<YouTubeCredential>, OAuthConnector<YouTubeCredential> {
  readonly channel = "youtube" as const;
  readonly accountNoun = "channel";
  readonly scopes = YOUTUBE_SCOPES;
  readonly usesPkce = true;

  constructor(
    private readonly app: GoogleAppConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  authorizeUrl({ state, codeChallenge }: { state: string; codeChallenge?: string }): string {
    if (!codeChallenge) throw new Error("PKCE challenge required");
    const q = new URLSearchParams({ client_id: this.app.clientId, redirect_uri: this.app.redirectUri, response_type: "code", scope: YOUTUBE_SCOPES.join(" "), state, access_type: "offline", prompt: "consent", code_challenge: codeChallenge, code_challenge_method: "S256" });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  async #token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const { json } = await callJson(
      this.fetchImpl,
      TOKEN_URL,
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...params }).toString() },
      { write: false, classify: (s, b, r) => (s === 400 ? new PublishError("auth", `Google sign-in failed: ${(b as { error_description?: string } | null)?.error_description ?? "invalid grant"}`, undefined, "invalid_grant") : classifyGoogleError(s, b, r)) },
    );
    const t = json as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!t?.access_token) throw new PublishError("auth", "Google didn't return an access token.");
    return t as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  async #channels(token: string): Promise<Array<{ id: string; title: string }>> {
    const { json } = await callJson(this.fetchImpl, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { method: "GET", headers: { authorization: `Bearer ${token}` } }, { write: false, classify: classifyYouTubeError });
    return ((json as { items?: Array<{ id?: string; snippet?: { title?: string } }> } | null)?.items ?? []).filter((c) => c.id).map((c) => ({ id: c.id!, title: c.snippet?.title ?? c.id! }));
  }

  async accountsFromCode({ code, codeVerifier }: { code: string; codeVerifier?: string }): Promise<Array<ConnectableAccount<YouTubeCredential>>> {
    if (!codeVerifier) throw new Error("PKCE verifier required");
    const t = await this.#token({ grant_type: "authorization_code", code, redirect_uri: this.app.redirectUri, code_verifier: codeVerifier });
    if (!t.refresh_token) throw new PublishError("permanent", "Google didn't return a refresh token. Remove JAT's access in your Google account settings and connect again.");
    return (await this.#channels(t.access_token)).map((c) => ({ id: c.id, name: c.title, canPost: true, credential: { channelId: c.id, title: c.title, accessToken: t.access_token, refreshToken: t.refresh_token! }, tokenExpiresAt: expiresAtFrom(t.expires_in) }));
  }

  readonly refresh: TokenRefresher<YouTubeCredential> = {
    windowMs: 15 * 60_000,
    keepAlive: false,
    run: async (cred): Promise<RefreshedCredential<YouTubeCredential>> => {
      const t = await this.#token({ grant_type: "refresh_token", refresh_token: cred.refreshToken });
      return { credential: { ...cred, accessToken: t.access_token, refreshToken: t.refresh_token ?? cred.refreshToken }, tokenExpiresAt: expiresAtFrom(t.expires_in) };
    },
  };

  async publish(post: PublishablePost, cred: YouTubeCredential): Promise<PublishResult> {
    const media = post.media;
    if (!media || media.kind !== "video") throw new PublishError("permanent", "YouTube posts need a video.");
    const title = clean(post.title ?? post.text).trim().slice(0, 100) || "Video";
    const description = utf8Slice(clean(post.link ? `${post.text}\n\n${post.link.url}` : post.text), 5000);
    const bytes = await media.bytes();
    // 1. Open an upload session (creates nothing yet).
    const { res: start } = await callJson(
      this.fetchImpl,
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: { authorization: `Bearer ${cred.accessToken}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(bytes.length), "x-upload-content-type": media.mime },
        body: JSON.stringify({ snippet: { title, description, categoryId: "22" }, status: { privacyStatus: "public", selfDeclaredMadeForKids: false } }),
      },
      { write: false, classify: classifyYouTubeError },
    );
    const session = start.headers.get("location");
    if (!session || !/^https:\/\/www\.googleapis\.com\/upload\/youtube\//.test(session)) throw new PublishError("transient", "YouTube didn't open an upload session.");
    // 2. Send the bytes. If that's interrupted, ask the session how far it got.
    let done: Response | null = null;
    try {
      const r = await timedFetch(this.fetchImpl, session, { method: "PUT", headers: { "content-type": media.mime, "content-length": String(bytes.length) }, body: bytes }, { idempotent: true, timeoutMs: 15 * 60_000 });
      if (r.status === 200 || r.status === 201) done = r;
      else if (r.status < 500 && r.status !== 308) throw classifyYouTubeError(r.status, await jsonOrNull(r), r);
    } catch (err) {
      if (err instanceof PublishError && err.kind !== "transient" && err.kind !== "ambiguous") throw err;
    }
    done ??= await this.#resume(session, bytes, media.mime);
    const video = (await jsonOrNull(done)) as { id?: string; status?: { privacyStatus?: string } } | null;
    if (!video?.id) throw new PublishError("ambiguous", "YouTube finished the upload but didn't return the video id.");
    return {
      externalId: video.id,
      permalink: `https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`,
      ...(video.status?.privacyStatus && video.status.privacyStatus !== "public" ? { note: `YouTube set this video to ${video.status.privacyStatus} (projects that haven't passed YouTube's audit may be limited).` } : {}),
    };
  }

  /** Ask an interrupted session for its state; finish the upload if part of it is missing (once). */
  async #resume(session: string, bytes: Buffer, mime: string): Promise<Response> {
    let status: Response;
    try {
      status = await timedFetch(this.fetchImpl, session, { method: "PUT", headers: { "content-range": `bytes */${bytes.length}`, "content-length": "0" } }, { idempotent: true });
    } catch {
      throw new PublishError("ambiguous", "The YouTube upload was interrupted and its state couldn't be checked; it may have finished.");
    }
    if (status.status === 200 || status.status === 201) return status;
    if (status.status === 404) throw new PublishError("transient", "The YouTube upload session expired before finishing; nothing was published.");
    if (status.status !== 308) throw new PublishError("ambiguous", `The YouTube upload was interrupted (status ${status.status}); it may have finished.`);
    const range = /bytes=0-(\d+)/.exec(status.headers.get("range") ?? "");
    const from = range ? Number(range[1]) + 1 : 0;
    const r = await timedFetch(this.fetchImpl, session, { method: "PUT", headers: { "content-type": mime, "content-length": String(bytes.length - from), "content-range": `bytes ${from}-${bytes.length - 1}/${bytes.length}` }, body: bytes.subarray(from) }, { idempotent: true, timeoutMs: 15 * 60_000 }).catch(() => {
      throw new PublishError("ambiguous", "The YouTube upload was interrupted twice; it may have finished.");
    });
    if (r.status === 200 || r.status === 201) return r;
    throw new PublishError("ambiguous", `The YouTube upload didn't complete (status ${r.status}); check YouTube Studio.`);
  }

  async remove(): Promise<void> {
    // Deleting needs the broader "youtube" scope, which we don't request.
    throw new PublishError("permanent", "Remove YouTube videos in YouTube Studio.");
  }

  async check(cred: YouTubeCredential): Promise<{ ok: true; accountName: string }> {
    const c = (await this.#channels(cred.accessToken)).find((x) => x.id === cred.channelId);
    if (!c) throw new PublishError("permission", "This Google account no longer manages that YouTube channel.");
    return { ok: true, accountName: c.title };
  }
}
