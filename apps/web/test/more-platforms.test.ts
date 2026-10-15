import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { contentHash, type PostDraft } from "@jat/core";
import { findExpiringTokens, inAnonymous } from "@jat/db";
import { PsqlDatabase } from "@jat/db/testing/psql-client";
import { BlueskyAdapter, GoogleBusinessAdapter, LinkedInAdapter, ThreadsAdapter, XAdapter } from "@jat/integrations";
import { LocalKekProvider } from "@jat/vault";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "../../../packages/db/test/pg-harness.ts";
import { brandFixture, postFixture } from "../../../packages/core/test/fixtures.ts";
import { createApp, type Mailer } from "../src/app.ts";
import { InProcessJobs } from "../src/jobs.ts";
import { dispatchDue, refreshExpiringTokens, type PublisherDeps } from "../src/publisher.ts";
import type { PublishingConfig } from "../src/publishing-routes.ts";

const bin = findPgBin();
const T = "11111111-1111-4111-8111-111111111111";
const BRAND = "b1111111-1111-4111-8111-111111111111";
const DNA = "d1111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

class MemoryMailer implements Mailer {
  sent: Array<{ email: string; url: string }> = [];
  async sendLoginLink(email: string, url: string) {
    this.sent.push({ email, url });
  }
}

class Browser {
  jar = new Map<string, string>();
  constructor(private readonly base: string) {}
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async get(path: string) {
    const res = await fetch(this.base + path, { headers: { cookie: this.cookie }, redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  async post(path: string, fields: Record<string, string>, csrfFrom?: string) {
    const form = new URLSearchParams(fields);
    const m = csrfFrom ? /name="_csrf" value="([^"]+)"/.exec(csrfFrom) : null;
    if (m) form.set("_csrf", m[1]!);
    const res = await fetch(this.base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: this.base, cookie: this.cookie }, body: form.toString(), redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  #store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";");
      const [k, v] = kv!.split("=") as [string, string];
      if (!v || attrs.some((a) => /max-age=0/i.test(a.trim()))) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
}

/** One fake for all four platforms' APIs, routed by host. Records every call. */
class FakePlatforms {
  calls: Array<{ url: URL; method: string; body: string; headers: Record<string, string> }> = [];
  x = { challenge: "", refreshToken: "RT1", refreshFails: false, n: 0 };
  threadsToken = "TH-LONG-1";
  googleDown = false;
  fetch = (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    const method = init.method ?? "GET";
    const body = String(init.body ?? "");
    const headers = (init.headers ?? {}) as Record<string, string>;
    this.calls.push({ url, method, body, headers });
    const reply = (json: unknown, status = 200, extra: Record<string, string> = {}) => new Response(json === null ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json", ...extra } });
    const form = new URLSearchParams(body);
    // ---- X
    if (url.hostname === "api.x.com") {
      if (url.pathname === "/2/oauth2/token") {
        if (form.get("grant_type") === "authorization_code") {
          // PKCE: the verifier must hash to the challenge sent at the start.
          const ok = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === this.x.challenge;
          return ok ? reply({ access_token: "XAT1", refresh_token: "RT1", expires_in: 7200 }) : reply({ error: "invalid_request" }, 400);
        }
        if (this.x.refreshFails || form.get("refresh_token") !== this.x.refreshToken) return reply({ error: "invalid_request", error_description: "Value passed for the token was invalid." }, 400);
        this.x.n++;
        this.x.refreshToken = `RT${this.x.n + 1}`;
        return reply({ access_token: `XAT${this.x.n + 1}`, refresh_token: this.x.refreshToken, expires_in: 7200 });
      }
      if (url.pathname === "/2/users/me") return reply({ data: { id: "42", username: "acmeplumbing", name: "Acme" } });
      if (url.pathname === "/2/tweets") return reply({ data: { id: "1800", text: JSON.parse(body).text } }, 201);
    }
    // ---- Threads
    if (url.hostname === "graph.threads.net") {
      if (url.pathname === "/oauth/access_token") return reply({ access_token: "TH-SHORT", user_id: "17" });
      if (url.pathname === "/access_token") return reply({ access_token: this.threadsToken, expires_in: 5_184_000 });
      if (url.pathname === "/refresh_access_token") {
        assert.equal(url.searchParams.get("access_token"), this.threadsToken);
        this.threadsToken = "TH-LONG-2";
        return reply({ access_token: this.threadsToken, expires_in: 5_184_000 });
      }
      if (url.pathname === "/v1.0/me") return reply({ id: "17", username: "acme.plumbing" });
      if (url.pathname === "/v1.0/17/threads") return reply({ id: "C9" });
      if (url.pathname === "/C9") return reply({ status: "FINISHED" });
      if (url.pathname === "/v1.0/17/threads_publish") return reply({ id: "M9" });
      if (url.pathname === "/M9") return reply({ permalink: "https://www.threads.com/@acme.plumbing/post/M9" });
    }
    // ---- LinkedIn
    if (url.hostname === "www.linkedin.com" && url.pathname === "/oauth/v2/accessToken") return reply({ access_token: "LI-AT", expires_in: 5_184_000 });
    if (url.hostname === "api.linkedin.com") {
      if (url.pathname === "/rest/organizationAcls") return reply({ elements: [{ role: "ADMINISTRATOR", state: "APPROVED", organizationTarget: "urn:li:organization:123" }, { role: "ANALYST", state: "APPROVED", organizationTarget: "urn:li:organization:456" }] });
      if (url.pathname === "/rest/organizations/123") return reply({ localizedName: "Acme Plumbing & Heating" });
      if (url.pathname === "/rest/organizations/456") return reply({ localizedName: "Neighbour Co" });
      if (url.pathname === "/rest/posts") return reply(null, 201, { "x-restli-id": "urn:li:share:7001" });
    }
    // ---- Google
    if (url.hostname === "oauth2.googleapis.com" && this.googleDown) return reply({ error: "backend_error" }, 503);
    if (url.hostname === "oauth2.googleapis.com") return reply(form.get("grant_type") === "authorization_code" ? { access_token: "G-AT1", refresh_token: "G-RT", expires_in: 3599 } : { access_token: "G-AT2", expires_in: 3599 });
    if (url.hostname === "mybusinessaccountmanagement.googleapis.com") return reply({ accounts: [{ name: "accounts/111" }] });
    if (url.hostname === "mybusinessbusinessinformation.googleapis.com") return reply({ locations: [{ name: "locations/222", title: "Acme Plumbing — Worcester", metadata: { canOperateLocalPost: true } }] });
    if (url.hostname === "mybusiness.googleapis.com") return reply({ name: "accounts/111/locations/222/localPosts/555", searchUrl: "https://local.google.com/place?id=1&lpsid=555", state: "LIVE" });
    return reply({ error: { message: `unexpected ${method} ${url}` } }, 404);
  }) as typeof fetch;
  last(host: string, path?: string) {
    return [...this.calls].reverse().find((c) => c.url.hostname === host && (!path || c.url.pathname === path))!;
  }
}

describe("more platforms: Google Business Profile, LinkedIn, Threads and X end to end (real Postgres)", { skip: bin ? false : "Postgres binaries not found" }, () => {
  let pg: TempPg;
  let db: PsqlDatabase;
  let publisherDb: PsqlDatabase;
  let server: Server;
  let base: string;
  let deps: PublisherDeps;
  const mailer = new MemoryMailer();
  const jobs = new InProcessJobs(1);
  const errors: unknown[] = [];
  const fake = new FakePlatforms();
  let op: Browser;

  const one = (sql: string) => pg.admin(sql).split("\n")[0]!;
  function seedApproved(over: Partial<PostDraft>): string {
    const post = postFixture({ format: "text", creative_brief: null, alt_text: null, ...over });
    const json = JSON.stringify(post).replace(/'/g, "''");
    const item = one(`INSERT INTO content_items (tenant_id, brand_id, channel, kind, state, risk_class) VALUES ('${T}', '${BRAND}', '${post.channel}', 'social_post', 'approved', 'low') RETURNING id`);
    const rev = one(`INSERT INTO content_revisions (tenant_id, content_item_id, revision, body, content_hash, created_by) VALUES ('${T}', '${item}', 1, '${json}', '${contentHash(post)}', 'test') RETURNING id`);
    pg.admin(`UPDATE content_items SET current_revision_id = '${rev}' WHERE id = '${item}';
      INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision, decided_by) VALUES ('${T}', '${item}', '${rev}', '${contentHash(post)}', 'approved', '${OWNER}');`);
    return item;
  }
  const link = (src: string) => ({ url: `https://acme.example/winter?utm_source=${src}&utm_medium=social&utm_campaign=winter` });
  const fingerprint = (html: string) => /name="fingerprint" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
  async function scheduleNow(item: string) {
    const page = await op.get(`/w/${T}/content/${item}`);
    const r = await op.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: fingerprint(page.body) }, page.body);
    assert.equal(r.status, 303, r.body.slice(0, 400));
    return page;
  }
  const dispatch = async () => (await dispatchDue(deps)).map((x) => x.outcome);
  const integ = (channel: string, col: string) => pg.admin(`SELECT ${col} FROM integrations WHERE channel = '${channel}' AND status <> 'revoked'`);

  /** Runs the whole OAuth flow in the browser and returns the account picker page. */
  async function signInWith(channel: string) {
    const conn = await op.get(`/w/${T}/connections`);
    const start = await op.post(`/w/${T}/connections/${channel}/start`, {}, conn.body);
    assert.equal(start.status, 303, start.body.slice(0, 300));
    const dialog = new URL(start.location!);
    if (channel === "x") fake.x.challenge = dialog.searchParams.get("code_challenge")!;
    const cb = await op.get(`/oauth/${channel}/callback?code=c0de&state=${encodeURIComponent(dialog.searchParams.get("state")!)}`);
    assert.equal(cb.status, 303, cb.body.slice(0, 300));
    return { dialog, pickUrl: cb.location!, pick: await op.get(cb.location!) };
  }
  async function pick(channel: string, pickUrl: string, pickBody: string, accountId: string) {
    const k = new URL(pickUrl, base).searchParams.get("k")!;
    const r = await op.post(`/w/${T}/connections/${channel}/pick`, { k, account_id: accountId }, pickBody);
    assert.match(r.location ?? "", /m=connected/, r.body.slice(0, 300));
  }

  before(async () => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    const dna = JSON.stringify(brandFixture()).replace(/'/g, "''");
    pg.admin(`
      INSERT INTO tenants (id, name, slug, publishing_enabled) VALUES ('${T}', 'Acme Plumbing', 'acme', true);
      INSERT INTO users (id, email, name) VALUES ('${OWNER}', 'owner@acme.example', 'Olive'), ('${OP}', 'ops@jat.example', 'Oscar');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${T}', '${OWNER}', 'client_owner'), ('${T}', '${OP}', 'agency_operator');
      INSERT INTO brands (id, tenant_id, name) VALUES ('${BRAND}', '${T}', 'Acme');
      INSERT INTO brand_dna_versions (id, tenant_id, brand_id, version, status, data, created_by, approved_by, approved_at) VALUES ('${DNA}', '${T}', '${BRAND}', 1, 'active', '${dna}', 'test', '${OWNER}', now());
      UPDATE brands SET active_dna_version_id = '${DNA}' WHERE id = '${BRAND}';`);
    db = new PsqlDatabase(pg.conn);
    publisherDb = new PsqlDatabase(pg.conn, "publisher_user");
    const kek = new LocalKekProvider(randomBytes(32), "test-kek");
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const cb = (c: string) => `${base}/oauth/${c}/callback`;
    const oauth = {
      x: new XAdapter({ clientId: "xid", clientSecret: "xsecret", redirectUri: cb("x") }, fake.fetch),
      threads: new ThreadsAdapter({ appId: "tid", appSecret: "tsecret", redirectUri: cb("threads") }, fake.fetch, async () => {}),
      linkedin: new LinkedInAdapter({ clientId: "lid", clientSecret: "lsecret", redirectUri: cb("linkedin") }, fake.fetch),
      google_business_profile: new GoogleBusinessAdapter({ clientId: "gid", clientSecret: "gsecret", redirectUri: cb("google_business_profile") }, fake.fetch),
    };
    const bluesky = new BlueskyAdapter(fake.fetch);
    deps = { publisherDb, keks: kek, activeKek: kek, media: null, mode: "live", adapters: { bluesky, ...oauth }, safeFetch: fake.fetch, log: (m, e) => errors.push([m, e]) };
    const publishing: PublishingConfig = { mode: "live", activeKek: kek, bluesky, oauth, publisher: deps };
    const handler = createApp({ db, sessionSecret: randomBytes(32), baseUrl: base, mailer, jobs, log: (m, e) => errors.push([m, e]), onboarding: { crawl: async () => assert.fail("not used"), extract: null }, contentAi: null, publishing });
    server.on("request", (req, res) => void handler(req, res));
    op = new Browser(base);
    await op.post("/login", { email: "ops@jat.example" });
    await jobs.idle();
    await op.post("/login/verify", { token: new URL(mailer.sent.at(-1)!.url).searchParams.get("token")! });
  });

  after(async () => {
    await new Promise((r) => server?.close(r));
    await db?.close();
    await publisherDb?.close();
    pg?.stop();
  });

  it("X: PKCE sign-in, refresh before sending (keeping the newest refresh token), link inside the text", async () => {
    const { dialog, pickUrl, pick: page } = await signInWith("x");
    assert.equal(dialog.origin, "https://x.com");
    assert.equal(dialog.searchParams.get("code_challenge_method"), "S256");
    assert.doesNotMatch(page.body, /XAT1|RT1/, "tokens never reach the page");
    assert.match(page.body, /@acmeplumbing/);
    await pick("x", pickUrl, page.body, "42");
    assert.equal(integ("x", "display_name"), "@acmeplumbing");
    assert.ok(Date.parse(integ("x", "token_expires_at")) > Date.now() + 7_000_000, "2-hour token");
    assert.doesNotMatch(pg.admin("SELECT ciphertext FROM credentials"), /XAT1|RT1/);

    const item = seedApproved({ channel: "x", hook: "Three checks before the first hard freeze.", link: link("x") });
    const page2 = await scheduleNow(item);
    assert.match(page2.body, /X charges this account's API credits \$0\.20 for this post/);
    // The token is about to expire: the publisher refreshes it first.
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '5 minutes' WHERE channel = 'x'`);
    assert.deepEqual(await dispatch(), ["published"]);
    const tweet = fake.last("api.x.com", "/2/tweets");
    assert.equal(tweet.headers.authorization, "Bearer XAT2", "sent with the refreshed token");
    assert.match(JSON.parse(tweet.body).text, /\n\nhttps:\/\/acme\.example\/winter\?utm_source=x/);
    assert.equal(pg.admin(`SELECT permalink FROM publications WHERE content_item_id = '${item}'`), "https://x.com/acmeplumbing/status/1800");
    assert.ok(Date.parse(integ("x", "token_expires_at")) > Date.now() + 7_000_000);

    // Next refresh must use the rotated refresh token (RT2); the fake rejects anything else.
    const item2 = seedApproved({ channel: "x", hook: "Know where your main shut-off is.", link: null });
    await scheduleNow(item2);
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '5 minutes' WHERE channel = 'x'`);
    assert.deepEqual(await dispatch(), ["published"]);
    assert.equal(fake.x.refreshToken, "RT3");

    // A refused refresh: "Reconnect needed", and the post isn't sent.
    fake.x.refreshFails = true;
    const item3 = seedApproved({ channel: "x", hook: "Insulate exposed pipes.", link: null });
    await scheduleNow(item3);
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '5 minutes' WHERE channel = 'x'`);
    assert.deepEqual(await dispatch(), ["blocked"]);
    assert.equal(integ("x", "status"), "needs_reauth");
    assert.equal(pg.admin(`SELECT state FROM content_items WHERE id = '${item3}'`), "approved");
    const conn = await op.get(`/w/${T}/connections`);
    assert.match(conn.body, /Reconnect needed/);
  });

  it("Threads: sign-in, two-step publish with a link attachment, and background token renewal", async () => {
    const { dialog, pickUrl, pick: page } = await signInWith("threads");
    assert.equal(dialog.origin, "https://threads.com");
    await pick("threads", pickUrl, page.body, "17");
    const item = seedApproved({ channel: "threads", hook: "Three checks before the first hard freeze.", hashtags: [], link: link("threads") });
    await scheduleNow(item);
    assert.deepEqual(await dispatch(), ["published"]);
    const container = new URLSearchParams(fake.last("graph.threads.net", "/v1.0/17/threads").body);
    assert.equal(container.get("media_type"), "TEXT");
    assert.match(container.get("link_attachment")!, /utm_source=threads/);
    assert.equal(pg.admin(`SELECT permalink FROM publications WHERE content_item_id = '${item}'`), "https://www.threads.com/@acme.plumbing/post/M9");

    // 60-day tokens die if they lapse: the worker renews them a week ahead, with no post needed.
    assert.equal(await refreshExpiringTokens(deps), 0, "not yet");
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '3 days' WHERE channel = 'threads'`);
    assert.equal(await refreshExpiringTokens(deps), 1);
    assert.equal(fake.threadsToken, "TH-LONG-2");
    assert.ok(Date.parse(integ("threads", "token_expires_at")) > Date.now() + 50 * 86_400_000);
    // Only keep-alive channels are fetched, so idle short-lived tokens (X here) can't crowd Threads out.
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '3 days' WHERE channel = 'threads'`);
    const listed = await inAnonymous(publisherDb, (q) => findExpiringTokens(q, new Date(Date.now() + 8 * 86_400_000), ["threads"]));
    assert.deepEqual(listed.map((r) => r.channel), ["threads"]);
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '60 days' WHERE channel = 'threads'`);
    // X tokens are short-lived but renewed on demand only (not kept alive in the background).
    assert.equal(fake.calls.filter((c) => c.url.pathname === "/2/oauth2/token").length, 4);
  });

  it("LinkedIn: pick a Company Page, escaped commentary, expiry warning, and expiry → reconnect", async () => {
    const { pickUrl, pick: page } = await signInWith("linkedin");
    assert.match(page.body, /Choose a LinkedIn Company Page/);
    assert.match(page.body, /Not available[\s\S]*Neighbour Co[\s\S]*Super admin or Content admin/);
    assert.equal((await op.post(`/w/${T}/connections/linkedin/pick`, { k: new URL(pickUrl, base).searchParams.get("k")!, account_id: "urn:li:organization:456" }, page.body)).status, 400, "can't connect a Page without posting rights");
    await pick("linkedin", pickUrl, page.body, "urn:li:organization:123");
    let conn = await op.get(`/w/${T}/connections`);
    assert.match(conn.body, /Access expires/);
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '9 days 12 hours' WHERE channel = 'linkedin'`);
    conn = await op.get(`/w/${T}/connections`);
    assert.match(conn.body, /Access expires in 9 days/);

    const item = seedApproved({ channel: "linkedin", hook: "Winter (finally) is here.", hashtags: [], link: link("linkedin") });
    await scheduleNow(item);
    assert.deepEqual(await dispatch(), ["published"]);
    const sent = fake.last("api.linkedin.com", "/rest/posts");
    assert.equal(sent.headers["linkedin-version"], "202610");
    const body = JSON.parse(sent.body);
    assert.match(body.commentary, /^Winter \\\(finally\\\) is here\./);
    assert.equal(body.author, "urn:li:organization:123");
    assert.equal(pg.admin(`SELECT permalink FROM publications WHERE content_item_id = '${item}'`), "https://www.linkedin.com/feed/update/urn:li:share:7001/");

    // LinkedIn tokens can't be renewed without the person: once expired, it asks for reconnection.
    const item2 = seedApproved({ channel: "linkedin", hook: "Know your shut-off.", hashtags: [], link: null });
    await scheduleNow(item2);
    pg.admin(`UPDATE integrations SET token_expires_at = now() - interval '1 minute' WHERE channel = 'linkedin'`);
    const before = fake.calls.filter((c) => c.url.pathname === "/rest/posts").length;
    assert.deepEqual(await dispatch(), ["blocked"]);
    assert.equal(fake.calls.filter((c) => c.url.pathname === "/rest/posts").length, before);
    assert.equal(integ("linkedin", "status"), "needs_reauth");
  });

  it("Google Business Profile: pick a location, refresh the 1-hour token, post with a Learn more button", async () => {
    const { dialog, pickUrl, pick: page } = await signInWith("google_business_profile");
    assert.equal(dialog.searchParams.get("access_type"), "offline");
    assert.ok(dialog.searchParams.get("code_challenge"));
    assert.match(page.body, /Acme Plumbing — Worcester/);
    await pick("google_business_profile", pickUrl, page.body, "222");
    const item = seedApproved({ channel: "google_business_profile", hook: "Three checks before the first hard freeze.", hashtags: [], link: link("google") });
    await scheduleNow(item);
    pg.admin(`UPDATE integrations SET token_expires_at = now() + interval '5 minutes' WHERE channel = 'google_business_profile'`);
    // Google's token endpoint is briefly down: the post waits and retries; it isn't cancelled.
    fake.googleDown = true;
    assert.deepEqual(await dispatch(), ["token_retry"]);
    assert.equal(pg.admin(`SELECT state FROM content_items WHERE id = '${item}'`), "scheduled");
    assert.equal(integ("google_business_profile", "status"), "connected");
    fake.googleDown = false;
    pg.admin(`UPDATE publications SET next_attempt_at = NULL WHERE content_item_id = '${item}'`);
    assert.deepEqual(await dispatch(), ["published"]);
    const sent = fake.last("mybusiness.googleapis.com");
    assert.equal(sent.url.pathname, "/v4/accounts/111/locations/222/localPosts");
    assert.equal(sent.headers.authorization, "Bearer G-AT2", "refreshed first");
    const b = JSON.parse(sent.body);
    assert.equal(b.topicType, "STANDARD");
    assert.deepEqual(b.callToAction, { actionType: "LEARN_MORE", url: link("google").url });
    // The refresh kept the stored refresh token (Google didn't send a new one).
    assert.equal(new URLSearchParams(fake.last("oauth2.googleapis.com").body).get("refresh_token"), "G-RT");

    const audit = pg.admin(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log`);
    for (const a of ["integration.connected", "integration.token_refreshed", "integration.refresh_failed", "publish.succeeded", "publish.blocked"]) assert.ok(audit.includes(a), `audit has ${a}`);
    assert.deepEqual(errors, []);
  });
});
