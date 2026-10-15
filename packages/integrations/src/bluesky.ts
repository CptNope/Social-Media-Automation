import { createHash } from "node:crypto";
import { PublishError, retryAfterMs, timedFetch, type ChannelAdapter, type FetchLike, type PublishablePost, type PublishResult } from "./types.ts";

/**
 * Bluesky adapter (AT Protocol, app password). See docs/research/2026-10-publishing-apis.md.
 * Sessions are cached per account (createSession is limited to 30 per 5 minutes).
 */
export interface BlueskyCredential {
  identifier: string;
  appPassword: string;
}

interface Session {
  did: string;
  handle: string;
  pds: string;
  accessJwt: string;
  refreshJwt: string;
}

const ENTRYWAY = "https://bsky.social";
/** Sessions are cached per identifier *and* password, so a wrong password never reuses someone's session. */
const cacheKey = (c: BlueskyCredential): string => `${c.identifier.toLowerCase()}\u0000${createHash("sha256").update(c.appPassword).digest("hex")}`;
const graphemes = (s: string): number => [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length;

function pdsFromDidDoc(doc: unknown): string | null {
  const services = (doc as { service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }> } | undefined)?.service ?? [];
  const s = services.find((x) => (x.id ?? "").endsWith("#atproto_pds") && x.type === "AtprotoPersonalDataServer");
  const ep = typeof s?.serviceEndpoint === "string" ? s.serviceEndpoint : null;
  if (!ep) return null;
  try {
    const u = new URL(ep);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

async function xrpcError(res: Response): Promise<PublishError> {
  let name = "";
  let message = res.statusText;
  try {
    const b = (await res.json()) as { error?: string; message?: string };
    name = b.error ?? "";
    message = b.message ?? message;
  } catch {
    /* non-JSON */
  }
  const text = `Bluesky ${res.status}${name ? ` ${name}` : ""}: ${message}`.slice(0, 500);
  if (res.status === 429 || res.status >= 500) return new PublishError("transient", text, retryAfterMs(res), name);
  if (res.status === 401 || ["AuthenticationRequired", "InvalidToken", "ExpiredToken", "AccountTakedown"].includes(name)) return new PublishError("auth", text, undefined, name);
  return new PublishError("permanent", text, undefined, name);
}

export class BlueskyAdapter implements ChannelAdapter<BlueskyCredential> {
  readonly channel = "bluesky" as const;
  #sessions = new Map<string, Session>();
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  static readonly MAX_SESSIONS = 500;
  /** Bounded cache (oldest evicted) so tokens for long-gone accounts don't accumulate. */
  #remember(cred: BlueskyCredential, s: Session): void {
    const key = cacheKey(cred);
    this.#sessions.delete(key);
    this.#sessions.set(key, s);
    while (this.#sessions.size > BlueskyAdapter.MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value!);
  }

  async #login(cred: BlueskyCredential): Promise<Session> {
    const res = await timedFetch(this.fetchImpl, `${ENTRYWAY}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: cred.identifier, password: cred.appPassword }),
    }, { idempotent: true });
    if (!res.ok) {
      const e = await xrpcError(res);
      throw res.status === 401 || e.platformCode === "AuthenticationRequired" ? new PublishError("auth", "Bluesky rejected the handle or app password.", undefined, e.platformCode) : e;
    }
    const b = (await res.json()) as { did: string; handle: string; accessJwt: string; refreshJwt: string; didDoc?: unknown };
    const pds = pdsFromDidDoc(b.didDoc) ?? ENTRYWAY;
    const s: Session = { did: b.did, handle: b.handle, pds, accessJwt: b.accessJwt, refreshJwt: b.refreshJwt };
    this.#remember(cred, s);
    return s;
  }

  async #refresh(cred: BlueskyCredential, s: Session): Promise<Session> {
    const res = await timedFetch(this.fetchImpl, `${s.pds}/xrpc/com.atproto.server.refreshSession`, { method: "POST", headers: { authorization: `Bearer ${s.refreshJwt}` } }, { idempotent: true });
    if (!res.ok) return this.#login(cred);
    const b = (await res.json()) as { accessJwt: string; refreshJwt: string };
    const next = { ...s, accessJwt: b.accessJwt, refreshJwt: b.refreshJwt };
    this.#remember(cred, next);
    return next;
  }

  /** Authenticated call with one refresh-and-retry on expired tokens. */
  async #call(cred: BlueskyCredential, nsid: string, body: unknown): Promise<unknown> {
    let s = this.#sessions.get(cacheKey(cred)) ?? (await this.#login(cred));
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await timedFetch(this.fetchImpl, `${s.pds}/xrpc/${nsid}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.accessJwt}` }, body: JSON.stringify(body) });
      if (res.ok) return res.json();
      const err = await xrpcError(res);
      // A server error on createRecord may still have written the post: never auto-retry it.
      if (res.status >= 500 && nsid === "com.atproto.repo.createRecord") throw new PublishError("ambiguous", `${err.message} — the post may or may not have been created.`, undefined, err.platformCode);
      if (attempt === 0 && (err.platformCode === "ExpiredToken" || err.platformCode === "InvalidToken")) {
        s = await this.#refresh(cred, s);
        continue;
      }
      throw err;
    }
    throw new PublishError("auth", "Bluesky session could not be refreshed.");
  }

  async publish(post: PublishablePost, cred: BlueskyCredential): Promise<PublishResult> {
    const text = post.text.trim();
    if (graphemes(text) > 300) throw new PublishError("permanent", `Bluesky posts are limited to 300 characters; this one has ${graphemes(text)}.`);
    const record: Record<string, unknown> = { $type: "app.bsky.feed.post", text, createdAt: new Date().toISOString(), langs: ["en"] };
    if (post.link) {
      record.embed = { $type: "app.bsky.embed.external", external: { uri: post.link.url, title: post.link.title.slice(0, 300), description: post.link.description.slice(0, 1000) } };
    }
    const s = this.#sessions.get(cacheKey(cred)) ?? (await this.#login(cred));
    const out = (await this.#call(cred, "com.atproto.repo.createRecord", { repo: s.did, collection: "app.bsky.feed.post", record })) as { uri?: string; cid?: string };
    if (!out.uri) throw new PublishError("ambiguous", "Bluesky didn't return a post URI.");
    const rkey = out.uri.split("/").pop() ?? "";
    const current = this.#sessions.get(cacheKey(cred)) ?? s;
    return { externalId: out.uri, permalink: `https://bsky.app/profile/${current.handle}/post/${encodeURIComponent(rkey)}` };
  }

  async remove(externalId: string, cred: BlueskyCredential): Promise<void> {
    const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(externalId);
    if (!m) throw new PublishError("permanent", "Not a Bluesky post URI.");
    await this.#call(cred, "com.atproto.repo.deleteRecord", { repo: m[1], collection: "app.bsky.feed.post", rkey: m[2] });
  }

  async check(cred: BlueskyCredential): Promise<{ ok: true; accountName: string }> {
    const s = await this.#login(cred);
    return { ok: true, accountName: `@${s.handle}` };
  }
}
