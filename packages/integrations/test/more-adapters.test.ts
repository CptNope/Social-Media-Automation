import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GoogleBusinessAdapter, LinkedInAdapter, PublishError, ThreadsAdapter, XAdapter, escapeLittleText, pkcePair } from "../src/index.ts";

type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
function fakeFetch(handler: (url: URL, init: RequestInit) => Reply) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const f = (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { f, calls };
}
const form = (init: RequestInit) => new URLSearchParams(String(init.body));
const json = (init: RequestInit) => JSON.parse(String(init.body));
const hdr = (init: RequestInit, k: string) => (init.headers as Record<string, string>)[k];
const kind = (k: string) => (e: unknown) => e instanceof PublishError && e.kind === k;
const post = { text: "Three checks before the first hard freeze.", link: { url: "https://acme.example/w?utm_source=x&utm_medium=social&utm_campaign=w", title: "Three checks", description: "Insulate pipes." }, idempotencyKey: "k" };

describe("X adapter", () => {
  const app = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://app.example/oauth/x/callback" };
  const cred = { userId: "42", username: "acme", accessToken: "AT", refreshToken: "RT" };

  it("uses OAuth 2.0 with PKCE (S256) and offline access", () => {
    const { challenge } = pkcePair();
    const u = new URL(new XAdapter(app).authorizeUrl({ state: "s1", codeChallenge: challenge }));
    assert.equal(u.origin + u.pathname, "https://x.com/i/oauth2/authorize");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("code_challenge"), challenge);
    assert.equal(u.searchParams.get("scope"), "tweet.read tweet.write users.read offline.access");
    assert.throws(() => new XAdapter(app).authorizeUrl({ state: "s" }), /PKCE/);
  });

  it("exchanges the code (confidential client) and returns the account", async () => {
    const { f, calls } = fakeFetch((url) => (url.pathname === "/2/oauth2/token" ? { json: { access_token: "AT", refresh_token: "RT", expires_in: 7200 } } : { json: { data: { id: "42", username: "acme", name: "Acme" } } }));
    const [acct] = await new XAdapter(app, f).accountsFromCode({ code: "c", codeVerifier: "v" });
    assert.equal(hdr(calls[0]!.init, "authorization"), `Basic ${Buffer.from("cid:csecret").toString("base64")}`);
    assert.equal(form(calls[0]!.init).get("code_verifier"), "v");
    assert.equal(acct!.name, "@acme");
    assert.deepEqual(acct!.credential, cred);
    assert.ok(Date.parse(acct!.tokenExpiresAt!) > Date.now() + 7_000_000);
  });

  it("refresh keeps the newest refresh token; a revoked grant is an auth error", async () => {
    const ok = fakeFetch(() => ({ json: { access_token: "AT2", refresh_token: "RT2", expires_in: 7200 } }));
    const r = await new XAdapter(app, ok.f).refresh.run(cred);
    assert.deepEqual(r.credential, { ...cred, accessToken: "AT2", refreshToken: "RT2" });
    assert.equal(form(ok.calls[0]!.init).get("grant_type"), "refresh_token");
    const bad = fakeFetch(() => ({ status: 400, json: { error: "invalid_request", error_description: "Value passed for the token was invalid." } }));
    await assert.rejects(new XAdapter(app, bad.f).refresh.run(cred), kind("auth"));
  });

  it("posts the link inside the text, checks the weighted limit first, and builds the permalink", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, json: { data: { id: "1799", text: "x" } } }));
    const r = await new XAdapter(app, f).publish(post, cred);
    assert.equal(json(calls[0]!.init).text, `${post.text}\n\n${post.link.url}`);
    assert.equal(hdr(calls[0]!.init, "authorization"), "Bearer AT");
    assert.deepEqual(r, { externalId: "1799", permalink: "https://x.com/acme/status/1799" });
    // 260 letters + a link (23) = 285 weighted → refused without calling X.
    const never = fakeFetch(() => assert.fail("should not call"));
    await assert.rejects(new XAdapter(app, never.f).publish({ ...post, text: "a".repeat(258) }, cred), kind("permanent"));
  });

  it("classifies rate limits, auth, duplicates and server errors on create", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const limited = fakeFetch(() => ({ status: 429, json: { title: "Too Many Requests", detail: "Too Many Requests" }, headers: { "x-rate-limit-reset": reset } }));
    await assert.rejects(new XAdapter(app, limited.f).publish(post, cred), (e: unknown) => e instanceof PublishError && e.kind === "transient" && (e.retryAfterMs ?? 0) > 500_000);
    await assert.rejects(new XAdapter(app, fakeFetch(() => ({ status: 401, json: { title: "Unauthorized", detail: "Unauthorized" } })).f).publish(post, cred), kind("auth"));
    await assert.rejects(new XAdapter(app, fakeFetch(() => ({ status: 403, json: { detail: "You are not allowed to create a Tweet with duplicate content." } })).f).publish(post, cred), kind("permanent"));
    await assert.rejects(new XAdapter(app, fakeFetch(() => ({ status: 503, json: { title: "Service Unavailable" } })).f).publish(post, cred), kind("ambiguous"));
  });
});

describe("Threads adapter", () => {
  const app = { appId: "tid", appSecret: "tsecret", redirectUri: "https://app.example/oauth/threads/callback" };
  const cred = { userId: "17", username: "acme", accessToken: "LONG" };
  const noSleep = async () => {};

  it("signs in, swaps for a 60-day token and reads the profile", async () => {
    const u = new URL(new ThreadsAdapter(app).authorizeUrl({ state: "s" }));
    assert.equal(u.origin + u.pathname, "https://threads.com/oauth/authorize");
    assert.equal(u.searchParams.get("scope"), "threads_basic,threads_content_publish,threads_delete");
    const { f, calls } = fakeFetch((url) => {
      if (url.pathname === "/oauth/access_token") return { json: { access_token: "SHORT", user_id: "17" } };
      if (url.pathname === "/access_token") return { json: { access_token: "LONG", token_type: "bearer", expires_in: 5_184_000 } };
      return { json: { id: "17", username: "acme" } };
    });
    const [a] = await new ThreadsAdapter(app, f).accountsFromCode({ code: "c" });
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(calls[1]!.url.searchParams.get("grant_type"), "th_exchange_token");
    assert.equal(calls[1]!.url.searchParams.get("access_token"), "SHORT");
    assert.deepEqual(a!.credential, cred);
    assert.equal(a!.name, "@acme");
  });

  it("keeps tokens alive: refreshes in the background a week before expiry", async () => {
    const t = new ThreadsAdapter(app, fakeFetch(() => ({ json: { access_token: "LONG2", expires_in: 5_184_000 } })).f);
    assert.equal(t.refresh.keepAlive, true);
    assert.equal(t.refresh.windowMs, 7 * 24 * 3_600_000);
    assert.equal((await t.refresh.run(cred)).credential.accessToken, "LONG2");
  });

  it("creates a text container with the link, waits until it's ready, then publishes once", async () => {
    let statusCalls = 0;
    const { f, calls } = fakeFetch((url, init) => {
      if (url.pathname.endsWith("/threads") && init.method === "POST") return { json: { id: "C1" } };
      if (url.pathname === "/C1") return { json: { status: ++statusCalls < 2 ? "IN_PROGRESS" : "FINISHED" } };
      if (url.pathname.endsWith("/threads_publish")) return { json: { id: "M1" } };
      return { json: { permalink: "https://www.threads.com/@acme/post/abc" } };
    });
    const r = await new ThreadsAdapter(app, f, noSleep).publish(post, cred);
    const container = form(calls[0]!.init);
    assert.equal(container.get("media_type"), "TEXT");
    assert.equal(container.get("link_attachment"), post.link.url);
    assert.equal(form(calls.find((c) => c.url.pathname.endsWith("/threads_publish"))!.init).get("creation_id"), "C1");
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/threads_publish")).length, 1);
    assert.deepEqual(r, { externalId: "M1", permalink: "https://www.threads.com/@acme/post/abc" });
  });

  it("refuses long text, stops on a failed container, and never retries a publish that may have happened", async () => {
    const never = fakeFetch(() => assert.fail("no call"));
    await assert.rejects(new ThreadsAdapter(app, never.f, noSleep).publish({ ...post, text: "x".repeat(501) }, cred), kind("permanent"));
    const failed = fakeFetch((url, init) => (init.method === "POST" ? { json: { id: "C1" } } : { json: { status: "ERROR", error_message: "UNKNOWN" } }));
    await assert.rejects(new ThreadsAdapter(app, failed.f, noSleep).publish(post, cred), kind("permanent"));
    const boom = fakeFetch((url) => (url.pathname.endsWith("/threads_publish") ? { status: 500, json: { error: { message: "x", code: 2 } } } : url.pathname === "/C1" ? { json: { status: "FINISHED" } } : { json: { id: "C1" } }));
    await assert.rejects(new ThreadsAdapter(app, boom.f, noSleep).publish(post, cred), kind("ambiguous"));
    // Graph code 1 ("unknown error") on a 4xx publish might still have posted: never retried.
    const unknown = fakeFetch((url) => (url.pathname.endsWith("/threads_publish") ? { status: 400, json: { error: { message: "An unknown error occurred", code: 1 } } } : url.pathname === "/C1" ? { json: { status: "FINISHED" } } : { json: { id: "C1" } }));
    await assert.rejects(new ThreadsAdapter(app, unknown.f, noSleep).publish(post, cred), kind("ambiguous"));
    // Throttling means it was refused: safe to retry.
    const throttled = fakeFetch((url) => (url.pathname.endsWith("/threads_publish") ? { status: 400, json: { error: { message: "Application request limit reached", code: 4 } } } : url.pathname === "/C1" ? { json: { status: "FINISHED" } } : { json: { id: "C1" } }));
    await assert.rejects(new ThreadsAdapter(app, throttled.f, noSleep).publish(post, cred), kind("transient"));
    const expired = fakeFetch(() => ({ status: 400, json: { error: { message: "Session has expired", code: 190 } } }));
    await assert.rejects(new ThreadsAdapter(app, expired.f, noSleep).publish(post, cred), kind("auth"));
  });
});

describe("LinkedIn adapter", () => {
  const app = { clientId: "lid", clientSecret: "lsecret", redirectUri: "https://app.example/oauth/linkedin/callback" };
  const cred = { organizationUrn: "urn:li:organization:123", organizationName: "Acme", accessToken: "AT" };

  it("escapes LinkedIn's little-text characters", () => {
    assert.equal(escapeLittleText("Save 10% (today) #winter @acme a_b ~x* <y> [z] {q} | \\"), "Save 10% \\(today\\) \\#winter \\@acme a\\_b \\~x\\* \\<y\\> \\[z\\] \\{q\\} \\| \\\\");
  });

  it("lists Pages the person administers, with names, and marks ones they can't post to", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.hostname === "www.linkedin.com") return { json: { access_token: "AT", expires_in: 5_184_000 } };
      if (url.pathname === "/rest/organizationAcls")
        return { json: { elements: [{ role: "ADMINISTRATOR", state: "APPROVED", organizationTarget: "urn:li:organization:123" }, { role: "ANALYST", state: "APPROVED", organization: "urn:li:organization:456" }, { role: "ADMINISTRATOR", organizationTarget: "urn:li:person:9" }] } };
      return { json: { localizedName: url.pathname.endsWith("/123") ? "Acme Plumbing" : "Other Co" } };
    });
    const accts = await new LinkedInAdapter(app, f).accountsFromCode({ code: "c" });
    assert.deepEqual(accts.map((a) => [a.id, a.name, a.canPost]), [["urn:li:organization:123", "Acme Plumbing", true], ["urn:li:organization:456", "Other Co", false]]);
    const acl = calls.find((c) => c.url.pathname === "/rest/organizationAcls")!;
    assert.equal(hdr(acl.init, "linkedin-version"), "202610");
    assert.equal(hdr(acl.init, "x-restli-protocol-version"), "2.0.0");
    assert.ok(accts[0]!.tokenExpiresAt);
  });

  it("posts as the organization with escaped commentary and an article link", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, headers: { "x-restli-id": "urn:li:share:7001" } }));
    const r = await new LinkedInAdapter(app, f).publish({ ...post, text: "Winter (finally) is here #1" }, cred);
    const b = json(calls[0]!.init);
    assert.equal(b.author, "urn:li:organization:123");
    assert.equal(b.commentary, "Winter \\(finally\\) is here \\#1");
    assert.equal(b.lifecycleState, "PUBLISHED");
    assert.deepEqual(b.distribution, { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] });
    assert.equal(b.content.article.source, post.link.url);
    assert.deepEqual(r, { externalId: "urn:li:share:7001", permalink: "https://www.linkedin.com/feed/update/urn:li:share:7001/" });
  });

  it("classifies errors (expired token, missing role, throttling, conflicts, server errors on create)", async () => {
    const run = (status: number) => new LinkedInAdapter(app, fakeFetch(() => ({ status, json: { message: "x", status } })).f).publish(post, cred);
    await assert.rejects(run(401), kind("auth"));
    await assert.rejects(run(403), kind("permission"));
    await assert.rejects(run(429), kind("transient"));
    await assert.rejects(run(409), kind("transient"));
    await assert.rejects(run(422), kind("permanent"));
    await assert.rejects(run(500), kind("ambiguous"));
    // Accepted but no id: may exist.
    await assert.rejects(new LinkedInAdapter(app, fakeFetch(() => ({ status: 201 })).f).publish(post, cred), kind("ambiguous"));
  });
});

describe("Google Business Profile adapter", () => {
  const app = { clientId: "gid", clientSecret: "gsecret", redirectUri: "https://app.example/oauth/google_business_profile/callback" };
  const cred = { locationName: "accounts/111/locations/222", title: "Acme Plumbing", accessToken: "AT", refreshToken: "RT" };

  it("asks for offline access with PKCE", () => {
    const u = new URL(new GoogleBusinessAdapter(app).authorizeUrl({ state: "s", codeChallenge: "ch" }));
    assert.equal(u.searchParams.get("access_type"), "offline");
    assert.equal(u.searchParams.get("prompt"), "consent");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/business.manage");
  });

  it("lists locations across accounts (deduplicated), and flags ones that can't post", async () => {
    const { f } = fakeFetch((url) => {
      if (url.hostname === "oauth2.googleapis.com") return { json: { access_token: "AT", refresh_token: "RT", expires_in: 3599 } };
      if (url.hostname === "mybusinessaccountmanagement.googleapis.com") return { json: { accounts: [{ name: "accounts/111" }, { name: "accounts/999" }] } };
      if (url.pathname === "/v1/accounts/111/locations") {
        assert.equal(url.searchParams.get("readMask"), "name,title,metadata");
        return { json: { locations: [{ name: "locations/222", title: "Acme Plumbing", metadata: { canOperateLocalPost: true } }, { name: "locations/333", title: "Old shop", metadata: { canOperateLocalPost: false } }] } };
      }
      return { json: { locations: [{ name: "locations/222", title: "Acme Plumbing (group)" }] } };
    });
    const accts = await new GoogleBusinessAdapter(app, f).accountsFromCode({ code: "c", codeVerifier: "v" });
    assert.deepEqual(accts.map((a) => [a.id, a.name, a.canPost]), [["222", "Acme Plumbing", true], ["333", "Old shop", false]]);
    assert.deepEqual(accts[0]!.credential, cred);
  });

  it("refuses a sign-in without a refresh token; a revoked refresh token is an auth error", async () => {
    await assert.rejects(new GoogleBusinessAdapter(app, fakeFetch(() => ({ json: { access_token: "AT", expires_in: 3599 } })).f).accountsFromCode({ code: "c", codeVerifier: "v" }), /refresh token/);
    await assert.rejects(new GoogleBusinessAdapter(app, fakeFetch(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } })).f).refresh.run(cred), kind("auth"));
  });

  it("creates a STANDARD local post with a Learn more button", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { name: "accounts/111/locations/222/localPosts/555", searchUrl: "https://local.google.com/place?id=1&use=posts&lpsid=555", state: "LIVE" } }));
    const r = await new GoogleBusinessAdapter(app, f).publish(post, cred);
    assert.equal(calls[0]!.url.toString(), "https://mybusiness.googleapis.com/v4/accounts/111/locations/222/localPosts");
    assert.deepEqual(json(calls[0]!.init), { languageCode: "en-US", summary: post.text, topicType: "STANDARD", callToAction: { actionType: "LEARN_MORE", url: post.link.url } });
    assert.equal(r.externalId, "accounts/111/locations/222/localPosts/555");
    assert.match(r.permalink!, /^https:\/\/local\.google\.com/);
  });

  it("classifies Google errors and rejected posts", async () => {
    const run = (status: number, st: string) => new GoogleBusinessAdapter(app, fakeFetch(() => ({ status, json: { error: { code: status, message: "x", status: st } } })).f).publish(post, cred);
    await assert.rejects(run(401, "UNAUTHENTICATED"), kind("auth"));
    await assert.rejects(run(403, "PERMISSION_DENIED"), kind("permission"));
    await assert.rejects(run(429, "RESOURCE_EXHAUSTED"), kind("transient"));
    await assert.rejects(run(400, "INVALID_ARGUMENT"), kind("permanent"));
    await assert.rejects(run(503, "UNAVAILABLE"), kind("ambiguous"));
    await assert.rejects(new GoogleBusinessAdapter(app, fakeFetch(() => ({ json: { name: "accounts/111/locations/222/localPosts/9", state: "REJECTED" } })).f).publish(post, cred), kind("permanent"));
    await assert.rejects(new GoogleBusinessAdapter(app).publish(post, { ...cred, locationName: "accounts/1/locations/2?x=1" }), kind("permanent"));
  });
});
