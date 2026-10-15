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
