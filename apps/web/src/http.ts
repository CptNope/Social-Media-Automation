import type { IncomingMessage, ServerResponse } from "node:http";
import { Html } from "./html.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Req {
  method: string;
  url: URL;
  headers: IncomingMessage["headers"];
  params: Record<string, string>;
  cookies: Record<string, string>;
  ip: string;
  /** Parsed urlencoded form body (POST only). */
  form: URLSearchParams;
}

export interface Res {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
}

export const htmlResponse = (body: Html, status = 200, headers: Record<string, string | string[]> = {}): Res => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body: "<!doctype html>" + body.value,
});

export const redirect = (location: string, headers: Record<string, string | string[]> = {}): Res => ({
  status: 303,
  headers: { location, ...headers },
  body: "",
});

export const text = (body: string, status = 200, type = "text/plain; charset=utf-8"): Res => ({ status, headers: { "content-type": type }, body });

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function serializeCookie(name: string, value: string, opts: { maxAgeSeconds?: number; secure: boolean; httpOnly?: boolean }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`);
  return parts.join("; ");
}

const MAX_BODY = 256 * 1024;

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") throw new HttpError(415, "Forms must be application/x-www-form-urlencoded");
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY) throw new HttpError(413, "Request body too large");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export type Handler = (req: Req) => Promise<Res>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

/** Tiny router: "/w/:tenantId/brand" style patterns, exact segment counts. */
export class Router {
  #routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    this.#routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) {
    return this.on("GET", p, h);
  }
  post(p: string, h: Handler) {
    return this.on("POST", p, h);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | "method_not_allowed" | null {
    const segs = pathname.split("/").filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return "\u0000";
      }
    });
    let pathMatched = false;
    for (const r of this.#routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i]!;
        if (p.startsWith(":")) params[p.slice(1)] = segs[i]!;
        else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method || (method === "HEAD" && r.method === "GET")) return { handler: r.handler, params };
    }
    return pathMatched ? "method_not_allowed" : null;
  }
}

export function send(res: ServerResponse, r: Res, extraHeaders: Record<string, string>): void {
  res.statusCode = r.status;
  for (const [k, v] of Object.entries({ ...extraHeaders, ...r.headers })) res.setHeader(k, v);
  res.end(r.body);
}
