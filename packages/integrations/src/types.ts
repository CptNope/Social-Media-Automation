import type { Channel } from "@jat/core";

/**
 * Channel adapter contract. Adapters are plain functions over fetch: no retries, no
 * scheduling, no approval logic — the publisher owns those. Every failure is classified
 * so the publisher knows whether to retry, ask for reconnection, or stop.
 */
export type PublishErrorKind =
  | "transient" // retry later with backoff (rate limits, 5xx, network before send)
  | "auth" // credentials revoked/expired: reconnect the account
  | "permission" // the account lacks a permission or role
  | "permanent" // the content or request is invalid; a human must change something
  | "ambiguous"; // the request may have been processed (timeout after send): verify before retrying

export class PublishError extends Error {
  override name = "PublishError";
  constructor(
    readonly kind: PublishErrorKind,
    message: string,
    readonly retryAfterMs?: number,
    readonly platformCode?: string,
  ) {
    super(message);
  }
}

export interface PublishablePost {
  /** Final caption text exactly as approved. */
  text: string;
  link: { url: string; title: string; description: string } | null;
  /** Stable id used for platform-side idempotency where supported. */
  idempotencyKey: string;
}

export interface PublishResult {
  externalId: string;
  permalink: string | null;
}

export interface ChannelAdapter<Cred> {
  channel: Channel;
  publish(post: PublishablePost, cred: Cred): Promise<PublishResult>;
  remove(externalId: string, cred: Cred): Promise<void>;
  /** Cheap authenticated call to confirm the connection works. */
  check(cred: Cred): Promise<{ ok: true; accountName: string }>;
  /** Present when the platform's access tokens expire and can be renewed without the user. */
  refresh?: TokenRefresher<Cred>;
}

export interface TokenRefresher<Cred> {
  /** Refresh when the access token expires within this window. */
  windowMs: number;
  /**
   * Also refresh in the background (not only before a send), because the grant is lost for good
   * if the token is allowed to lapse (Threads: a 60-day token can only be refreshed before it expires).
   */
  keepAlive: boolean;
  run(cred: Cred): Promise<RefreshedCredential<Cred>>;
}

export interface RefreshedCredential<Cred> {
  credential: Cred;
  /** ISO time the new access token expires, or null if it doesn't. */
  tokenExpiresAt: string | null;
}

/** An account the signed-in person can connect (a Page, a Company Page, a location, or their own profile). */
export interface ConnectableAccount<Cred> {
  id: string;
  name: string;
  canPost: boolean;
  /** Why it can't post (shown to the person). */
  reason?: string;
  /** Server-side only: never rendered or put in a URL. */
  credential: Cred;
  tokenExpiresAt: string | null;
}

/** The OAuth half of a channel: start the sign-in, then turn the returned code into connectable accounts. */
export interface OAuthConnector<Cred> {
  channel: Channel;
  /** "Page", "Company Page", "location", "account". */
  accountNoun: string;
  scopes: readonly string[];
  /** PKCE (S256): the verifier stays server-side. */
  usesPkce: boolean;
  authorizeUrl(a: { state: string; codeChallenge?: string }): string;
  accountsFromCode(a: { code: string; codeVerifier?: string }): Promise<Array<ConnectableAccount<Cred>>>;
}

/** ISO expiry from an OAuth `expires_in` (seconds), or null. */
export function expiresAtFrom(expiresIn: unknown, now = Date.now()): string | null {
  const n = Number(expiresIn);
  return Number.isFinite(n) && n > 0 ? new Date(now + n * 1000).toISOString() : null;
}

/** Read a JSON body without throwing (error responses are not always JSON). */
export async function jsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export type FetchLike = typeof fetch;

/**
 * Fetch with a timeout; distinguishes "never sent" from "sent but no answer".
 * `idempotent` marks non-GET calls that are safe to repeat (logins, token refresh).
 */
export async function timedFetch(f: FetchLike, url: string, init: RequestInit, opts: { timeoutMs?: number; idempotent?: boolean } = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const write = !!init.method && init.method !== "GET" && !opts.idempotent;
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      // For writes we can't know whether the platform processed it.
      throw new PublishError(write ? "ambiguous" : "transient", `No response within ${timeoutMs / 1000}s`);
    }
    throw classifyNetworkError(err, write);
  }
}

/** Errors that prove the request never reached the server (safe to retry a write). */
const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * A connection that drops after the request was written (reset, socket closed) may still have
 * created the post, so for writes it is "ambiguous" — never retried automatically. Only errors that
 * prove nothing was sent are "transient". A blocked host (SSRF guard) is "permanent".
 */
export function classifyNetworkError(err: unknown, write: boolean): PublishError {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string; name?: string; message?: string } } | null;
  const code = e?.code ?? e?.cause?.code ?? "";
  const msg = `Network error: ${e?.cause?.message ?? e?.message ?? String(err)}`.slice(0, 300);
  if (e?.name === "UnsafeUrlError" || e?.cause?.name === "UnsafeUrlError") return new PublishError("permanent", `Host not allowed: ${e?.cause?.message ?? e?.message}`);
  if (!write || NOT_SENT_CODES.has(code)) return new PublishError("transient", msg, undefined, code || undefined);
  return new PublishError("ambiguous", `${msg} — the request may have been processed.`, undefined, code || undefined);
}

export function retryAfterMs(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(n * 1000, 6 * 3_600_000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.min(at - Date.now(), 6 * 3_600_000));
}

/**
 * One JSON API call with shared safety rules: errors are classified by the platform's
 * `classify`, and on a write (a call that may create something public) a "transient" error
 * is "ambiguous" unless `retrySafe` says it proves nothing was created — the post may exist,
 * so it is never retried automatically.
 */
export async function callJson(
  f: FetchLike,
  url: string,
  init: RequestInit,
  opts: {
    write: boolean;
    classify: (status: number, body: unknown, res: Response) => PublishError;
    /** For writes: which "transient" errors prove nothing was created (default: HTTP 429 only). */
    retrySafe?: (status: number, body: unknown) => boolean;
    timeoutMs?: number;
  },
): Promise<{ res: Response; json: unknown }> {
  const res = await timedFetch(f, url, init, { idempotent: !opts.write, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) });
  const json = res.status === 204 ? null : await jsonOrNull(res);
  if (!res.ok) {
    const err = opts.classify(res.status, json, res);
    // On a write, any other "transient" error (5xx, Graph codes 1/2 "unknown"/"unavailable") might have posted.
    if (opts.write && err.kind === "transient" && !(opts.retrySafe ?? ((s) => s === 429))(res.status, json)) {
      throw new PublishError("ambiguous", `${err.message} — the post may or may not have been created.`, undefined, err.platformCode);
    }
    throw err;
  }
  return { res, json };
}

/** Unix-seconds reset header (X) → milliseconds from now. */
export function resetHeaderMs(res: Response, header: string, now = Date.now()): number | undefined {
  const v = Number(res.headers.get(header));
  return Number.isFinite(v) && v > 0 ? Math.max(0, Math.min(v * 1000 - now, 6 * 3_600_000)) : undefined;
}
