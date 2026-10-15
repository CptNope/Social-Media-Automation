import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for S3-compatible storage (Cloudflare R2), header-signed requests
 * and presigned URLs. Implemented with node:crypto only; checked against AWS's published examples.
 */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

const sha256Hex = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (key: Buffer | string, d: string) => createHmac("sha256", key).update(d).digest();

/** RFC 3986 encoding as SigV4 requires (keeps A-Z a-z 0-9 - _ . ~). */
export function uriEncode(s: string, encodeSlash = true): string {
  return [...Buffer.from(s, "utf8")]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-_.~]/.test(c)) return c;
      if (c === "/" && !encodeSlash) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function signingKey(c: SigV4Credentials, date: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date), c.region), c.service), "aws4_request");
}

function canonicalQuery(params: Array<[string, string]>): string {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/** Signs a request; returns the headers to send (including Authorization and x-amz-date). */
export function signRequest(
  c: SigV4Credentials,
  req: { method: string; url: URL; headers?: Record<string, string>; payloadHash: string; now: Date; s3?: boolean },
): Record<string, string> {
  const t = amzDate(req.now);
  const date = t.slice(0, 8);
  const headers: Record<string, string> = { ...(req.headers ?? {}), host: req.url.host, "x-amz-date": t };
  if (req.s3) headers["x-amz-content-sha256"] = req.payloadHash;
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  // S3 doesn't normalize paths (and encodes each segment once); other services double-encode.
  const path = req.s3 ? uriEncode(decodeURIComponent(req.url.pathname), false) : req.url.pathname.split("/").map((p) => uriEncode(decodeURIComponent(p))).join("/") || "/";
  const canonical = [req.method, path, canonicalQuery([...req.url.searchParams]), canonicalHeaders, signedHeaders, req.payloadHash].join("\n");
  const scope = `${date}/${c.region}/${c.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", t, scope, sha256Hex(canonical)].join("\n");
  const sig = createHmac("sha256", signingKey(c, date)).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}` };
}

/** Presigned URL (query-string auth) valid for `expiresSec` seconds. */
export function presignUrl(c: SigV4Credentials, req: { method: string; url: URL; expiresSec: number; now: Date }): string {
  const t = amzDate(req.now);
  const date = t.slice(0, 8);
  const scope = `${date}/${c.region}/${c.service}/aws4_request`;
  const u = new URL(req.url);
  const params: Array<[string, string]> = [
    ...u.searchParams,
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${c.accessKeyId}/${scope}`],
    ["X-Amz-Date", t],
    ["X-Amz-Expires", String(req.expiresSec)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const path = uriEncode(decodeURIComponent(u.pathname), false);
  const canonical = [req.method, path, canonicalQuery(params), `host:${u.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", t, scope, sha256Hex(canonical)].join("\n");
  const sig = createHmac("sha256", signingKey(c, date)).update(toSign).digest("hex");
  return `${u.origin}${path}?${canonicalQuery(params)}&X-Amz-Signature=${sig}`;
}

export { sha256Hex };
