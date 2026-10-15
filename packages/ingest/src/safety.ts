import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

/**
 * SSRF protection for user-supplied URLs (client websites, competitor URLs).
 * - Only public http(s) hosts on default ports.
 * - Every redirect hop is re-checked by the crawler.
 * - `safeFetch` pins the socket to an address that passed the check (no DNS rebinding window).
 */
export type Resolver = (hostname: string) => Promise<string[]>;

export const defaultResolver: Resolver = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------
function v4Bytes(ip: string): number[] {
  return ip.split(".").map(Number);
}

const V4_BLOCKS: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function inPrefix(bytes: number[], base: number[], bits: number): boolean {
  for (let i = 0; i < base.length && bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if (((bytes[i] ?? 0) & mask) !== ((base[i] ?? 0) & mask)) return false;
  }
  return true;
}

function isPrivateV4(bytes: number[]): boolean {
  return V4_BLOCKS.some(([base, bits]) => inPrefix(bytes, base, bits));
}

/** Parse an IPv6 literal (incl. "::" and embedded dotted IPv4) into 16 bytes. */
export function v6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, "");
  let tailV4: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    tailV4 = v4Bytes(dotted[1]!);
    s = s.slice(0, -dotted[1]!.length) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":") : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && fill !== 0) || fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tailV4.length) bytes.splice(12, 4, ...tailV4);
  return bytes;
}

const V6_BLOCKS: Array<[number[], number]> = [
  [[0xfc], 7], // unique local
  [[0xfe, 0x80], 10], // link local
  [[0xfe, 0xc0], 10], // site local (deprecated)
  [[0xff], 8], // multicast
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x20, 0x01, 0x00, 0x00], 32], // Teredo
  [[0x01, 0, 0, 0, 0, 0, 0, 0], 64], // discard-only
];

export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateV4(v4Bytes(ip));
  if (fam !== 6) return true; // not an IP: treat as unsafe
  const b = v6Bytes(ip);
  if (!b) return true;
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (b.every((x) => x === 0)) return true; // ::
  if (zeros(15) && b[15] === 1) return true; // ::1
  // Embedded IPv4 forms are judged by their IPv4 address.
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(b.slice(12)); // ::ffff:a.b.c.d
  if (zeros(12)) return isPrivateV4(b.slice(12)); // ::a.b.c.d (IPv4-compatible)
  if (inPrefix(b, [0x00, 0x64, 0xff, 0x9b], 32) && b.slice(4, 12).every((x) => x === 0)) return isPrivateV4(b.slice(12)); // 64:ff9b::/96 (NAT64)
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(b.slice(2, 6)); // 6to4
  return V6_BLOCKS.some(([base, bits]) => inPrefix(b, base, bits));
}

// ---------------------------------------------------------------------------
// URL checks
// ---------------------------------------------------------------------------
export async function assertPublicUrl(raw: string | URL, resolve: Resolver = defaultResolver): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeUrlError(`Only http(s) URLs are allowed: ${u.protocol}`);
  if (u.username || u.password) throw new UnsafeUrlError("URLs with credentials are not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError(`Non-standard port ${u.port} is not allowed`);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new UnsafeUrlError(`Host ${host} is not public`);
  }
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.length === 0) throw new UnsafeUrlError(`Host ${host} did not resolve`);
  for (const a of addrs) if (isPrivateAddress(a)) throw new UnsafeUrlError(`Host ${host} resolves to a non-public address`);
  return u;
}

/**
 * DNS lookup for sockets that only ever returns addresses that pass `isPrivateAddress`,
 * so the address that was checked is the one the connection uses.
 */
export function pinnedLookup(resolve: Resolver = defaultResolver): LookupFunction {
  return (hostname, options, callback) => {
    const cb = callback as unknown as (err: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;
    resolve(hostname)
      .then((addrs) => {
        const safe = addrs.filter((a) => !isPrivateAddress(a));
        if (!safe.length || safe.length !== addrs.length) throw new UnsafeUrlError(`Host ${hostname} resolves to a non-public address`);
        const list = safe.map((address) => ({ address, family: isIP(address) }));
        if ((options as { all?: boolean }).all) cb(null, list);
        else cb(null, list[0]!.address, list[0]!.family);
      })
      .catch((err: Error) => cb(err));
  };
}

/**
 * fetch-compatible GET over node:http(s) with a pinned, validated DNS lookup.
 * Never follows redirects (the caller re-validates each hop).
 */
export function createSafeFetch(resolve: Resolver = defaultResolver): typeof fetch {
  const lookup = pinnedLookup(resolve);
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      headers: init.headers as Record<string, string>,
      lookup,
      signal: init.signal ?? undefined,
    });
    const res: IncomingMessage = await new Promise((resolveRes, reject) => {
      req.on("response", resolveRes);
      req.on("error", reject);
      req.end();
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else if (v !== undefined) headers.set(k, v);
    }
    const status = res.statusCode ?? 0;
    if (status < 200 || status > 599) {
      res.destroy();
      throw new Error(`Unexpected HTTP status ${status}`);
    }
    const nullBody = status === 204 || status === 304;
    if (nullBody) res.resume();
    return new Response(nullBody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers });
  }) as typeof fetch;
}
