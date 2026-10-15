import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { presignUrl, sha256Hex, signRequest, type SigV4Credentials } from "./sigv4.ts";

/**
 * Where media files live. Keys are `t/{tenantId}/{random}.{ext}`: unguessable, and scoped by
 * tenant so a key from one client can never be read through another (the database row that
 * points at a key is RLS-protected too).
 */
export interface MediaStore {
  /** Store a file (from a path on disk or bytes). */
  put(key: string, src: { path: string } | { bytes: Buffer }, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A URL anyone can GET for `ttlSec` seconds (for platforms that fetch media by URL). */
  signedGetUrl(key: string, ttlSec: number): Promise<string>;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

export function newMediaKey(tenantId: string, mime: string): string {
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new Error("tenantId must be a UUID");
  return `t/${tenantId}/${randomBytes(24).toString("base64url")}.${EXT[mime] ?? "bin"}`;
}

export const isMediaKey = (k: string): boolean => /^t\/[0-9a-f-]{36}\/[A-Za-z0-9_-]{32}\.(jpg|png|webp|mp4|mov|webm|bin)$/.test(k);

const check = (key: string) => {
  if (!isMediaKey(key)) throw new Error("invalid media key");
};

// ---------------------------------------------------------------------------
// Cloudflare R2 (S3-compatible API, SigV4)
// ---------------------------------------------------------------------------
export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** e.g. "eu" for EU-jurisdiction buckets. */
  jurisdiction?: string;
}

export class R2MediaStore implements MediaStore {
  readonly #creds: SigV4Credentials;
  readonly #base: string;

  constructor(
    cfg: R2Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[0-9a-f]{32}$/.test(cfg.accountId)) throw new Error("R2 account id must be 32 hex characters");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cfg.bucket)) throw new Error("invalid R2 bucket name");
    this.#creds = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: "auto", service: "s3" };
    this.#base = `https://${cfg.accountId}.${cfg.jurisdiction ? `${cfg.jurisdiction}.` : ""}r2.cloudflarestorage.com/${cfg.bucket}`;
  }

  #url(key: string): URL {
    check(key);
    return new URL(`${this.#base}/${key}`);
  }

  async #send(method: string, key: string, body: Buffer | null, headers: Record<string, string> = {}): Promise<Response> {
    const url = this.#url(key);
    const payload = body ?? Buffer.alloc(0);
    const signed = signRequest(this.#creds, { method, url, headers, payloadHash: sha256Hex(payload), now: this.now(), s3: true });
    delete signed.host;
    const res = await this.fetchImpl(url, { method, headers: signed, ...(body ? { body } : {}), signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok && !(method === "DELETE" && res.status === 404)) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new Error(`R2 ${method} failed: ${res.status} ${/<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? ""}`.trim());
    }
    return res;
  }

  async put(key: string, src: { path: string } | { bytes: Buffer }, contentType: string): Promise<void> {
    // Single PUT (≤ 4.995 GiB on R2); uploads are capped far below that.
    const bytes = "bytes" in src ? src.bytes : await readFile(src.path);
    await this.#send("PUT", key, bytes, { "content-type": contentType });
  }

  async get(key: string): Promise<Buffer> {
    return Buffer.from(await (await this.#send("GET", key, null)).arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.#send("DELETE", key, null);
  }

  async signedGetUrl(key: string, ttlSec: number): Promise<string> {
    return presignUrl(this.#creds, { method: "GET", url: this.#url(key), expiresSec: Math.min(ttlSec, 604_800), now: this.now() });
  }
}

// ---------------------------------------------------------------------------
// Local folder (development, tests, single-server installs)
// ---------------------------------------------------------------------------
/**
 * Files on local disk. Signed URLs point at the app's own `/media/signed/...` route, which
 * checks an HMAC and expiry (`verifyLocalSignature`). Only reachable by platforms if the app
 * itself is public.
 */
export class LocalMediaStore implements MediaStore {
  readonly #root: string;
  constructor(
    root: string,
    private readonly signing: { secret: Buffer; baseUrl: string },
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#root = resolve(root);
  }

  #path(key: string): string {
    check(key);
    const p = resolve(join(this.#root, key));
    if (!p.startsWith(this.#root + sep)) throw new Error("invalid media key");
    return p;
  }

  async put(key: string, src: { path: string } | { bytes: Buffer }, _contentType?: string): Promise<void> {
    const p = this.#path(key);
    await mkdir(dirname(p), { recursive: true });
    if ("bytes" in src) await writeFile(p, src.bytes);
    else await copyFile(src.path, p);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.#path(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async signedGetUrl(key: string, ttlSec: number): Promise<string> {
    check(key);
    const exp = Math.floor(this.now().getTime() / 1000) + ttlSec;
    const sig = localSignature(this.signing.secret, key, exp);
    return new URL(`/media/signed/${key}?exp=${exp}&sig=${sig}`, this.signing.baseUrl).toString();
  }
}

export const localSignature = (secret: Buffer, key: string, exp: number): string => createHmac("sha256", secret).update(`media:${key}:${exp}`).digest("base64url");

export function verifyLocalSignature(secret: Buffer, key: string, exp: string | null, sig: string | null, now = new Date()): boolean {
  if (!isMediaKey(key) || !exp || !sig || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) < now.getTime() / 1000) return false;
  const want = Buffer.from(localSignature(secret, key, Number(exp)));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
