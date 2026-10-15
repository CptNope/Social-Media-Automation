import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BlueskyAdapter, FacebookPagesAdapter, PublishError, WordPressClient, appSecretProof, classifyGraphError, signWordPressRequest } from "../src/index.ts";

type Handler = (url: URL, init: RequestInit) => { status?: number; json?: unknown; headers?: Record<string, string> } | Promise<never>;
function fakeFetch(handler: Handler) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const f = (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    calls.push({ url, init });
    const r = await handler(url, init);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { f, calls };
}
const body = (init: RequestInit) => JSON.parse(String(init.body));
const post = { text: "Three checks before the first hard freeze.", link: { url: "https://acme.example/winter?utm_source=bluesky", title: "Three checks", description: "Insulate pipes." }, idempotencyKey: "pub-1" };

const DID_DOC = { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://shiitake.us-east.host.bsky.network" }] };

describe("Bluesky adapter", () => {
  it("logs in at the entryway, posts to the PDS with a link card, returns a permalink", async () => {
    const { f, calls } = fakeFetch((url, init) => {
      if (url.pathname.endsWith("createSession")) {
        assert.equal(url.origin, "https://bsky.social");
        assert.deepEqual(body(init), { identifier: "acme.bsky.social", password: "app-pass" });
        return { json: { did: "did:plc:abc", handle: "acme.bsky.social", accessJwt: "A1", refreshJwt: "R1", didDoc: DID_DOC } };
      }
      assert.equal(url.origin, "https://shiitake.us-east.host.bsky.network");
      assert.equal((init.headers as Record<string, string>).authorization, "Bearer A1");
      const b = body(init);
      assert.equal(b.repo, "did:plc:abc");
      assert.equal(b.collection, "app.bsky.feed.post");
      assert.equal(b.record.$type, "app.bsky.feed.post");
      assert.equal(b.record.text, post.text);
      assert.deepEqual(b.record.embed, { $type: "app.bsky.embed.external", external: { uri: post.link.url, title: "Three checks", description: "Insulate pipes." } });
      assert.ok(!Number.isNaN(Date.parse(b.record.createdAt)));
      return { json: { uri: "at://did:plc:abc/app.bsky.feed.post/3kabc", cid: "bafy" } };
    });
    const a = new BlueskyAdapter(f);
    const r = await a.publish(post, { identifier: "acme.bsky.social", appPassword: "app-pass" });
    assert.equal(r.externalId, "at://did:plc:abc/app.bsky.feed.post/3kabc");
    assert.equal(r.permalink, "https://bsky.app/profile/acme.bsky.social/post/3kabc");
    // Session is cached: a second post doesn't log in again.
    await a.publish(post, { identifier: "acme.bsky.social", appPassword: "app-pass" });
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("createSession")).length, 1);
  });

  it("refreshes an expired session once and retries", async () => {
    let creates = 0;
    const { f } = fakeFetch((url, init) => {
      if (url.pathname.endsWith("createSession")) return { json: { did: "did:plc:abc", handle: "h", accessJwt: "A1", refreshJwt: "R1", didDoc: DID_DOC } };
      if (url.pathname.endsWith("refreshSession")) {
        assert.equal((init.headers as Record<string, string>).authorization, "Bearer R1");
        return { json: { accessJwt: "A2", refreshJwt: "R2" } };
      }
      creates++;
      if ((init.headers as Record<string, string>).authorization === "Bearer A1") return { status: 400, json: { error: "ExpiredToken", message: "Token has expired" } };
      return { json: { uri: "at://did:plc:abc/app.bsky.feed.post/1", cid: "c" } };
    });
    await new BlueskyAdapter(f).publish({ ...post, link: null }, { identifier: "h", appPassword: "p" });
    assert.equal(creates, 2);
  });

  it("classifies failures and enforces the 300-character limit before calling", async () => {
    const bad = fakeFetch(() => ({ status: 401, json: { error: "AuthenticationRequired", message: "Invalid identifier or password" } }));
    await assert.rejects(new BlueskyAdapter(bad.f).check({ identifier: "h", appPassword: "wrong" }), (e: unknown) => e instanceof PublishError && e.kind === "auth");
    const limited = fakeFetch((url) => (url.pathname.endsWith("createSession") ? { json: { did: "d", handle: "h", accessJwt: "A", refreshJwt: "R", didDoc: DID_DOC } } : { status: 429, json: { error: "RateLimitExceeded" }, headers: { "retry-after": "120" } }));
    await assert.rejects(new BlueskyAdapter(limited.f).publish({ ...post, link: null }, { identifier: "h", appPassword: "p" }), (e: unknown) => e instanceof PublishError && e.kind === "transient" && e.retryAfterMs === 120_000);
    const never = fakeFetch(() => assert.fail("should not call"));
    await assert.rejects(new BlueskyAdapter(never.f).publish({ ...post, text: "x".repeat(301) }, { identifier: "h", appPassword: "p" }), (e: unknown) => e instanceof PublishError && e.kind === "permanent");
  });

  it("never retries a server error on createRecord (the post may exist): ambiguous", async () => {
    const { f, calls } = fakeFetch((url) => (url.pathname.endsWith("createSession") ? { json: { did: "d", handle: "h", accessJwt: "A", refreshJwt: "R", didDoc: DID_DOC } } : { status: 502, json: { error: "UpstreamFailure" } }));
    await assert.rejects(new BlueskyAdapter(f).publish({ ...post, link: null }, { identifier: "h", appPassword: "p" }), (e: unknown) => e instanceof PublishError && e.kind === "ambiguous");
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("createRecord")).length, 1);
  });

  it("a connection dropped after sending a post is ambiguous; a DNS failure is retryable", async () => {
    const drop = (code: string) => fakeFetch((url) => {
      if (url.pathname.endsWith("createSession")) return { json: { did: "d", handle: "h", accessJwt: "A", refreshJwt: "R", didDoc: DID_DOC } };
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    });
    await assert.rejects(new BlueskyAdapter(drop("ECONNRESET").f).publish({ ...post, link: null }, { identifier: "h", appPassword: "p" }), (e: unknown) => e instanceof PublishError && e.kind === "ambiguous");
    await assert.rejects(new BlueskyAdapter(drop("ENOTFOUND").f).publish({ ...post, link: null }, { identifier: "h", appPassword: "p" }), (e: unknown) => e instanceof PublishError && e.kind === "transient");
    // Logging in is safe to repeat, so a dropped login is retryable.
    const login = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    await assert.rejects(new BlueskyAdapter(login.f).check({ identifier: "h", appPassword: "p" }), (e: unknown) => e instanceof PublishError && e.kind === "transient");
  });

  it("doesn't reuse a cached session for a different password", async () => {
    const { f, calls } = fakeFetch((url, init) => {
      if (url.pathname.endsWith("createSession")) return body(init).password === "right" ? { json: { did: "d", handle: "h", accessJwt: "A", refreshJwt: "R", didDoc: DID_DOC } } : { status: 401, json: { error: "AuthenticationRequired" } };
      return { json: { uri: "at://d/app.bsky.feed.post/1" } };
    });
    const a = new BlueskyAdapter(f);
    await a.publish({ ...post, link: null }, { identifier: "h", appPassword: "right" });
    await assert.rejects(a.publish({ ...post, link: null }, { identifier: "h", appPassword: "wrong" }), (e: unknown) => e instanceof PublishError && e.kind === "auth");
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("createRecord")).length, 1);
  });

  it("ignores non-https PDS endpoints from the DID document", async () => {
    const { f, calls } = fakeFetch((url) => (url.pathname.endsWith("createSession") ? { json: { did: "d", handle: "h", accessJwt: "A", refreshJwt: "R", didDoc: { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "http://169.254.169.254" }] } } } : { json: { uri: "at://d/app.bsky.feed.post/1" } }));
    await new BlueskyAdapter(f).publish({ ...post, link: null }, { identifier: "h", appPassword: "p" });
    assert.equal(calls[1]!.url.origin, "https://bsky.social");
  });

  it("deletes by rkey", async () => {
    const { f, calls } = fakeFetch((url) => (url.pathname.endsWith("createSession") ? { json: { did: "did:plc:abc", handle: "h", accessJwt: "A", refreshJwt: "R", didDoc: DID_DOC } } : { json: {} }));
    await new BlueskyAdapter(f).remove("at://did:plc:abc/app.bsky.feed.post/3kabc", { identifier: "h", appPassword: "p" });
    assert.deepEqual(body(calls[1]!.init), { repo: "did:plc:abc", collection: "app.bsky.feed.post", rkey: "3kabc" });
  });
});

describe("Facebook Pages adapter", () => {
  const app = { appId: "123", appSecret: "shh", version: "v26.0", redirectUri: "https://app.example/oauth/facebook/callback" };

  it("builds the login URL with state and the minimal scopes", () => {
    const u = new URL(new FacebookPagesAdapter(app).authorizeUrl({ state: "state-1" }));
    assert.equal(u.origin + u.pathname, "https://www.facebook.com/v26.0/dialog/oauth");
    assert.equal(u.searchParams.get("state"), "state-1");
    assert.equal(u.searchParams.get("scope"), "pages_show_list,pages_read_engagement,pages_manage_posts");
    assert.equal(u.searchParams.get("redirect_uri"), app.redirectUri);
  });

  it("exchanges the code for a long-lived token and lists Pages", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith("/oauth/access_token")) return { json: { access_token: url.searchParams.get("grant_type") ? "LONG" : "SHORT", token_type: "bearer" } };
      assert.equal(url.pathname, "/v26.0/me/accounts");
      assert.equal(url.searchParams.get("access_token"), "LONG");
      assert.equal(url.searchParams.get("appsecret_proof"), appSecretProof("shh", "LONG"));
      return { json: { data: [{ id: "111", name: "Acme Plumbing", access_token: "PAGE", tasks: ["CREATE_CONTENT", "MANAGE"] }, { id: "222", name: "Other", access_token: "P2", tasks: ["ANALYZE"] }] } };
    });
    const pages = await new FacebookPagesAdapter(app, f).pagesFromCode("CODE");
    assert.deepEqual(pages, [{ id: "111", name: "Acme Plumbing", accessToken: "PAGE", canPost: true }, { id: "222", name: "Other", accessToken: "P2", canPost: false }]);
    assert.equal(calls[0]!.url.searchParams.get("code"), "CODE");
    assert.equal(calls[1]!.url.searchParams.get("fb_exchange_token"), "SHORT");
  });

  it("publishes to /{page}/feed with message, link and appsecret_proof", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { id: "111_999" } }));
    const r = await new FacebookPagesAdapter(app, f).publish(post, { pageId: "111", pageName: "Acme", pageAccessToken: "PAGE" });
    const form = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(calls[0]!.url.pathname, "/v26.0/111/feed");
    assert.equal(form.get("message"), post.text);
    assert.equal(form.get("link"), post.link.url);
    assert.equal(form.get("appsecret_proof"), appSecretProof("shh", "PAGE"));
    assert.deepEqual(r, { externalId: "111_999", permalink: "https://www.facebook.com/111/posts/999" });
  });

  it("treats a server error on publish as ambiguous (never auto-retried), but rate limits as transient", async () => {
    const five = fakeFetch(() => ({ status: 500, json: { error: { message: "An unknown error occurred", code: 1 } } }));
    await assert.rejects(new FacebookPagesAdapter(app, five.f).publish(post, { pageId: "111", pageName: "Acme", pageAccessToken: "PAGE" }), (e: unknown) => e instanceof PublishError && e.kind === "ambiguous");
    const limited = fakeFetch(() => ({ status: 400, json: { error: { message: "Application request limit reached", code: 4 } } }));
    await assert.rejects(new FacebookPagesAdapter(app, limited.f).publish(post, { pageId: "111", pageName: "Acme", pageAccessToken: "PAGE" }), (e: unknown) => e instanceof PublishError && e.kind === "transient");
  });

  it("classifies Graph API errors", () => {
    const k = (code: number, status = 400) => classifyGraphError(status, { error: { message: "x", code } }).kind;
    assert.equal(k(190), "auth");
    assert.equal(k(4), "transient");
    assert.equal(k(80001), "transient");
    assert.equal(k(200, 403), "permission");
    assert.equal(k(10, 403), "permission");
    assert.equal(k(368), "permanent");
    assert.equal(k(506), "permanent");
    assert.equal(classifyGraphError(500, null).kind, "transient");
  });
});

describe("WordPress connector client", () => {
  const cred = { siteUrl: "https://acme.example/blog", username: "jat-bot", applicationPassword: "abcd efgh", signingSecret: "s3cret" };

  it("signs requests and uses rest_route so it works without pretty permalinks", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { ok: true, plugin_version: "0.1.0", wordpress_version: "6.8", seo_plugin: "yoast", user: "jat-bot", can_publish: false } }));
    const c = new WordPressClient(cred, f, () => 1_760_000_000);
    await c.health();
    const { url, init } = calls[0]!;
    assert.equal(url.origin + url.pathname, "https://acme.example/blog/");
    assert.equal(url.searchParams.get("rest_route"), "/jat/v1/health");
    const h = init.headers as Record<string, string>;
    assert.equal(h.authorization, `Basic ${Buffer.from("jat-bot:abcd efgh").toString("base64")}`);
    assert.equal(h["x-jat-signature"], signWordPressRequest("s3cret", "GET", "/jat/v1/health", "", 1_760_000_000, h["x-jat-nonce"]!));
  });

  it("refuses non-https sites and maps plugin-missing errors", async () => {
    assert.throws(() => new WordPressClient({ ...cred, siteUrl: "http://acme.example" }, fetch), /https/);
    const { f } = fakeFetch(() => ({ status: 404, json: { code: "rest_no_route", message: "No route" } }));
    await assert.rejects(new WordPressClient(cred, f).health(), /plugin isn't active/);
  });
});
