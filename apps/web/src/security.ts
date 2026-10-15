import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Req } from "./http.ts";
import { HttpError } from "./http.ts";

/**
 * Stateless signed sessions + CSRF tokens.
 *
 * Cookie value: base64url(JSON {u: userId, n: nonce, e: expiresEpochSeconds}) + "." + HMAC-SHA256.
 * CSRF token:   HMAC-SHA256(secret, "csrf|" + nonce) — bound to the session, verified on every POST.
 * All POSTs additionally require a same-origin Origin (or Referer) header.
 */
export const SESSION_COOKIE = "jat_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface Session {
  userId: string;
  nonce: string;
  expiresAt: number;
  /** users.session_epoch at sign-in; sessions from older epochs are rejected. */
  epoch: number;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

function hmac(secret: Buffer, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function assertSecret(secret: Buffer): void {
  if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 bytes");
}

export function signSession(secret: Buffer, userId: string, epoch: number, now = Date.now()): { value: string; session: Session } {
  const session: Session = { userId, nonce: randomBytes(16).toString("base64url"), expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS, epoch };
  const payload = b64u(JSON.stringify({ u: session.userId, n: session.nonce, e: session.expiresAt, p: epoch }));
  return { value: `${payload}.${b64u(hmac(secret, `session|${payload}`))}`, session };
}

export function verifySession(secret: Buffer, value: string | undefined, now = Date.now()): Session | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const payload = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1), "base64url");
  if (!safeEqual(sig, hmac(secret, `session|${payload}`))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; n?: unknown; e?: unknown; p?: unknown };
    if (typeof p.u !== "string" || typeof p.n !== "string" || typeof p.e !== "number" || typeof p.p !== "number") return null;
    if (p.e * 1000 <= now) return null;
    return { userId: p.u, nonce: p.n, expiresAt: p.e, epoch: p.p };
  } catch {
    return null;
  }
}

export const csrfToken = (secret: Buffer, s: Session): string => b64u(hmac(secret, `csrf|${s.nonce}`));

export function assertCsrf(secret: Buffer, s: Session, token: string | null): void {
  if (!token || !safeEqual(Buffer.from(token), Buffer.from(csrfToken(secret, s)))) throw new HttpError(403, "Invalid or missing CSRF token. Reload the page and try again.");
}

/** Reject cross-site POSTs. Browsers send Origin on form POSTs; fall back to Referer. */
export function assertSameOrigin(req: Req, baseUrl: URL): void {
  const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
  if (!origin || origin !== baseUrl.origin) throw new HttpError(403, "Cross-site request blocked");
}

function safeOrigin(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

export const newLoginToken = (): { token: string; hash: string } => {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256Hex(token) };
};

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self' https://www.facebook.com; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
};

/** Simple fixed-window limiter (per process) for unauthenticated endpoints. */
export class RateLimiter {
  #hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.#hits.get(key);
    if (!h || h.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (v.resetAt <= now) this.#hits.delete(k);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }
}
