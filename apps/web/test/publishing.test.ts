import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { composeCaption, contentHash, type PostDraft } from "@jat/core";
import { PsqlDatabase } from "@jat/db/testing/psql-client";
import { FacebookPagesAdapter, PublishError, appSecretProof, signWordPressRequest, type BlueskyCredential, type ChannelAdapter, type PublishablePost, type PublishResult } from "@jat/integrations";
import { LocalKekProvider } from "@jat/vault";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "../../../packages/db/test/pg-harness.ts";
import { brandFixture, postFixture } from "../../../packages/core/test/fixtures.ts";
import { createApp, type Mailer } from "../src/app.ts";
import { InProcessJobs } from "../src/jobs.ts";
import { dispatchDue, processPublication, runRequestedChecks, type PublisherDeps } from "../src/publisher.ts";
import type { PublishingConfig } from "../src/publishing-routes.ts";

const bin = findPgBin();
const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const BRAND = "b1111111-1111-4111-8111-111111111111";
const DNA = "d1111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EDITOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GOOD = "abcd-efgh-ijkl-mnop";

class MemoryMailer implements Mailer {
  sent: Array<{ email: string; url: string }> = [];
  async sendLoginLink(email: string, url: string) {
    this.sent.push({ email, url });
  }
}

/** Browser with a real cookie jar (the OAuth flow sets a second cookie). */
class Browser {
  jar = new Map<string, string>();
  constructor(private readonly base: string) {}
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async get(path: string) {
    const res = await fetch(path.startsWith("http") ? path : this.base + path, { headers: { cookie: this.cookie }, redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), headers: res.headers, body: await res.text() };
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

/** Records every publish; behaviour of the next calls can be scripted. */
class FakeBluesky implements ChannelAdapter<BlueskyCredential> {
  readonly channel = "bluesky" as const;
  sent: Array<{ post: PublishablePost; cred: BlueskyCredential }> = [];
  script: Array<() => PublishResult> = [];
  async publish(post: PublishablePost, cred: BlueskyCredential): Promise<PublishResult> {
    this.sent.push({ post, cred });
    const next = this.script.shift();
    if (next) return next();
    return { externalId: `at://did:plc:acme/app.bsky.feed.post/p${this.sent.length}`, permalink: `https://bsky.app/profile/acme.bsky.social/post/p${this.sent.length}` };
  }
  async remove(): Promise<void> {}
  async check(cred: BlueskyCredential) {
    if (cred.appPassword !== GOOD) throw new PublishError("auth", "Bluesky rejected the handle or app password.");
    return { ok: true as const, accountName: "@acme.bsky.social" };
  }
}

describe("publishing: connections, scheduling, the publisher and its safety checks (real Postgres)", { skip: bin ? false : "Postgres binaries not found" }, () => {
  let pg: TempPg;
  let db: PsqlDatabase;
  let publisherDb: PsqlDatabase;
  let server: Server;
  let base: string;
  let deps: PublisherDeps;
  let publishing: PublishingConfig;
  const mailer = new MemoryMailer();
  const jobs = new InProcessJobs(1);
  const errors: unknown[] = [];
  const bsky = new FakeBluesky();
  const fbCalls: Array<{ url: URL; body: string }> = [];
  const wpCalls: Array<{ url: URL; headers: Record<string, string> }> = [];
  let clockOffsetMs = 1_000;

  async function signIn(email: string): Promise<Browser> {
    const b = new Browser(base);
    await b.post("/login", { email });
    await jobs.idle();
    const link = new URL(mailer.sent.at(-1)!.url);
    const r = await b.post("/login/verify", { token: link.searchParams.get("token")! });
    assert.equal(r.status, 303);
    return b;
  }

  const one = (sql: string) => pg.admin(sql).split("\n")[0]!;

  /** An approved post (as if it went through drafting and approval). */
  function seedApproved(over: Partial<PostDraft> = {}): string {
    const post = postFixture({ channel: "bluesky", format: "text", creative_brief: null, alt_text: null, link: { url: "https://acme.example/winter?utm_source=bluesky&utm_medium=social&utm_campaign=winter" }, ...over });
    const json = JSON.stringify(post).replace(/'/g, "''");
    const item = one(`INSERT INTO content_items (tenant_id, brand_id, channel, kind, state, risk_class) VALUES ('${T}', '${BRAND}', '${post.channel}', 'social_post', 'approved', 'low') RETURNING id`);
    const rev = one(`INSERT INTO content_revisions (tenant_id, content_item_id, revision, body, content_hash, created_by) VALUES ('${T}', '${item}', 1, '${json}', '${contentHash(post)}', 'test') RETURNING id`);
    pg.admin(`UPDATE content_items SET current_revision_id = '${rev}' WHERE id = '${item}';
      INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision, decided_by) VALUES ('${T}', '${item}', '${rev}', '${contentHash(post)}', 'approved', '${OWNER}');`);
    return item;
  }
  const state = (item: string) => pg.admin(`SELECT state FROM content_items WHERE id = '${item}'`);
  const pubs = (item: string) => pg.admin(`SELECT string_agg(status, ',' ORDER BY created_at) FROM publications WHERE content_item_id = '${item}'`);
  const fingerprint = (html: string) => /name="fingerprint" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";

  async function scheduleNow(b: Browser, item: string) {
    const page = await b.get(`/w/${T}/content/${item}`);
    const r = await b.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: fingerprint(page.body) }, page.body);
    assert.equal(r.status, 303, r.body.slice(0, 500));
    return r;
  }
  const dispatch = async () => (await dispatchDue(deps)).map((x) => x.outcome);

  before(async () => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    const dna = JSON.stringify(brandFixture()).replace(/'/g, "''");
    pg.admin(`
      INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Acme Plumbing', 'acme'), ('${T2}', 'Bravo Bakery', 'bravo');
      INSERT INTO users (id, email, name) VALUES ('${OWNER}', 'owner@acme.example', 'Olive'), ('${OP}', 'ops@jat.example', 'Oscar'), ('${EDITOR}', 'editor@acme.example', 'Edie');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${T}', '${OWNER}', 'client_owner'), ('${T}', '${OP}', 'agency_operator'), ('${T}', '${EDITOR}', 'client_editor'), ('${T2}', '${OP}', 'agency_operator');
      INSERT INTO brands (id, tenant_id, name) VALUES ('${BRAND}', '${T}', 'Acme');
      INSERT INTO brand_dna_versions (id, tenant_id, brand_id, version, status, data, created_by, approved_by, approved_at) VALUES ('${DNA}', '${T}', '${BRAND}', 1, 'active', '${dna}', 'test', '${OWNER}', now());
      UPDATE brands SET active_dna_version_id = '${DNA}' WHERE id = '${BRAND}';`);
    db = new PsqlDatabase(pg.conn);
    publisherDb = new PsqlDatabase(pg.conn, "publisher_user");
    const kek = new LocalKekProvider(randomBytes(32), "test-kek");

    const fbFetch = (async (u: string, init: RequestInit = {}) => {
      const url = new URL(u);
      fbCalls.push({ url, body: String(init.body ?? "") });
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/oauth/access_token")) return json({ access_token: url.searchParams.get("grant_type") ? "LONG" : "SHORT" });
      if (url.pathname.endsWith("/me/accounts")) return json({ data: [{ id: "111", name: "Acme Plumbing Page", access_token: "PAGE-TOKEN-SECRET", tasks: ["CREATE_CONTENT"] }, { id: "222", name: "Fan club", access_token: "OTHER", tasks: ["ANALYZE"] }] });
      if (url.pathname.endsWith("/111/feed")) return json({ id: "111_999" });
      return json({ error: { message: "unexpected", code: 100 } }, 400);
    }) as typeof fetch;
    // Emulates the JAT Connector plugin: verifies the signature with the shared secret.
    const wpFetch = (async (u: string, init: RequestInit = {}) => {
      const url = new URL(u);
      const headers = init.headers as Record<string, string>;
      wpCalls.push({ url, headers });
      const secret = /signing_secret=([^&]+)/.exec(process.env.__WP_SECRET ?? "")?.[1] ?? "";
      const expected = signWordPressRequest(secret, init.method ?? "GET", url.searchParams.get("rest_route")!, String(init.body ?? ""), Number(headers["x-jat-timestamp"]), headers["x-jat-nonce"]!);
      const ok = expected === headers["x-jat-signature"];
      return new Response(JSON.stringify(ok ? { ok: true, plugin_version: "0.1.0", wordpress_version: "6.8", seo_plugin: "yoast", user: "jat-bot", can_publish: false } : { code: "jat_signature_invalid", message: "Bad signature" }), { status: ok ? 200 : 401, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const facebook = new FacebookPagesAdapter({ appId: "app-1", appSecret: "app-secret", version: "v26.0", redirectUri: `${base}/oauth/facebook/callback` }, fbFetch);
    deps = {
      publisherDb,
      keks: kek,
      activeKek: kek,
      media: null,
      mode: "dry_run",
      adapters: { bluesky: bsky, facebook },
      safeFetch: wpFetch,
      now: () => new Date(Date.now() + clockOffsetMs),
      log: (m, e) => errors.push([m, e]),
    };
    publishing = {
      get mode() {
        return deps.mode;
      },
      activeKek: kek,
      bluesky: bsky,
      oauth: { facebook },
      publisher: deps,
    };
    const handler = createApp({
      db,
      sessionSecret: randomBytes(32),
      baseUrl: base,
      mailer,
      jobs,
      log: (m, e) => {
        errors.push([m, e]);
        if (process.env.DEBUG_WEB) console.error(m, e);
      },
      onboarding: { crawl: async () => assert.fail("not used"), extract: null },
      contentAi: null,
      publishing,
    });
    server.on("request", (req, res) => void handler(req, res));
  });

  after(async () => {
    await new Promise((r) => server?.close(r));
    await db?.close();
    await publisherDb?.close();
    pg?.stop();
  });

  it("connects accounts without ever exposing secrets, and only managers can", async () => {
    const op = await signIn("ops@jat.example");
    const editor = await signIn("editor@acme.example");
    let page = await op.get(`/w/${T}/connections`);
    assert.equal(page.status, 200);
    assert.match(page.body, /Dry-run mode/);
    assert.match(page.body, /aria-current="page">Connections/);

    // Editors can't connect accounts.
    const ed = await editor.get(`/w/${T}/connections`);
    assert.doesNotMatch(ed.body, /Check and connect/);
    assert.equal((await editor.post(`/w/${T}/connections/bluesky`, { identifier: "acme.bsky.social", app_password: GOOD }, ed.body)).status, 403);

    // Wrong app password: refused, nothing stored.
    let r = await op.post(`/w/${T}/connections/bluesky`, { identifier: "@Acme.bsky.social", app_password: "wrong-password" }, page.body);
    assert.equal(r.status, 400);
    assert.match(r.body, /didn&#39;t accept/);
    assert.equal(pg.admin("SELECT count(*) FROM integrations"), "0");

    r = await op.post(`/w/${T}/connections/bluesky`, { identifier: "@Acme.bsky.social", app_password: GOOD }, page.body);
    assert.match(r.location!, /m=connected/);
    page = await op.get(r.location!);
    assert.match(page.body, /@acme\.bsky\.social/);
    assert.doesNotMatch(page.body, new RegExp(GOOD));
    // Stored encrypted (AES-GCM envelope), never in plaintext.
    const cred = pg.admin("SELECT ciphertext || wrapped_dek FROM credentials");
    assert.ok(cred.length > 20);
    assert.doesNotMatch(cred, /abcd|acme/);

    // WordPress: the signing secret is shown once (not in a URL), then the connection check verifies it.
    r = await op.post(`/w/${T}/connections/wordpress`, { site_url: "https://acme.example/blog/", username: "jat-bot", app_password: "abcd efgh ijkl mnop qrst uvwx" }, page.body);
    assert.equal(r.status, 200);
    const secret = /<code class="secret">([A-Za-z0-9_-]{43})<\/code>/.exec(r.body)?.[1];
    assert.ok(secret, "secret shown");
    assert.equal((await op.post(`/w/${T}/connections/wordpress`, { site_url: "http://acme.example", username: "x", app_password: "abcd efgh ijkl mnop qrst uvwx" }, page.body)).status, 400, "https only");
    page = await op.get(`/w/${T}/connections`);
    assert.doesNotMatch(page.body, new RegExp(secret!));
    const wpId = /action="\/w\/[^/]+\/connections\/([0-9a-f-]{36})\/check"/g;
    const ids = [...page.body.matchAll(wpId)].map((m) => m[1]!);
    const wordpressId = pg.admin("SELECT id FROM integrations WHERE channel = 'wordpress'");
    assert.ok(ids.includes(wordpressId));
    process.env.__WP_SECRET = "signing_secret=wrong";
    r = await op.post(`/w/${T}/connections/${wordpressId}/check`, {}, page.body);
    assert.equal(r.status, 422);
    assert.match(r.body, /Connection check failed/);
    process.env.__WP_SECRET = `signing_secret=${secret}`;
    r = await op.post(`/w/${T}/connections/${wordpressId}/check`, {}, page.body);
    assert.match(r.location!, /m=check_ok/);
    assert.equal(pg.admin(`SELECT status FROM integrations WHERE id = '${wordpressId}'`), "connected");
    assert.equal(wpCalls.at(-1)!.url.searchParams.get("rest_route"), "/jat/v1/health");

    // Web-only process (no credential access): the check is queued for the publisher worker.
    const inProcess = publishing.publisher;
    publishing.publisher = null;
    r = await op.post(`/w/${T}/connections/${wordpressId}/check`, {}, page.body);
    assert.match(r.location!, /m=check_requested/);
    assert.notEqual(pg.admin(`SELECT check_requested_at FROM integrations WHERE id = '${wordpressId}'`), "");
    publishing.publisher = inProcess;
    const callsBefore = wpCalls.length;
    assert.equal(await runRequestedChecks(deps), 1);
    assert.equal(wpCalls.length, callsBefore + 1);
    assert.equal(pg.admin(`SELECT check_requested_at IS NULL FROM integrations WHERE id = '${wordpressId}'`), "t");
    assert.equal(pg.admin(`SELECT actor_type FROM audit_log WHERE action = 'integration.checked' ORDER BY created_at DESC LIMIT 1`), "system");
    delete process.env.__WP_SECRET;
  });

  it("Facebook: OAuth bound to this browser and user; tokens stay server-side", async () => {
    const op = await signIn("ops@jat.example");
    const owner = await signIn("owner@acme.example");
    const page = await op.get(`/w/${T}/connections`);
    const r = await op.post(`/w/${T}/connections/facebook/start`, {}, page.body);
    assert.equal(r.status, 303);
    const dialog = new URL(r.location!);
    assert.equal(dialog.origin, "https://www.facebook.com");
    const state = dialog.searchParams.get("state")!;
    assert.equal(op.jar.get("jat_oauth_facebook"), state);

    // Another signed-in person (or a forged link) can't complete someone else's flow.
    assert.equal((await owner.get(`/oauth/facebook/callback?code=abc&state=${state}`)).status, 400);
    assert.equal((await op.get(`/oauth/facebook/callback?code=abc&state=forged`)).status, 400);

    const cb = await op.get(`/oauth/facebook/callback?code=abc&state=${state}`);
    assert.equal(cb.status, 303, cb.body.slice(0, 300));
    assert.equal(op.jar.has("jat_oauth_facebook"), false, "state cookie cleared");
    // Replaying the callback fails (state is single-use).
    assert.equal((await op.get(`/oauth/facebook/callback?code=abc&state=${state}`)).status, 400);
    const pick = await op.get(cb.location!);
    assert.match(pick.body, /Acme Plumbing Page/);
    assert.match(pick.body, /Not available[\s\S]*Fan club[\s\S]*can&#39;t create posts/);
    assert.doesNotMatch(pick.body, /PAGE-TOKEN-SECRET|LONG|SHORT/);
    // The pick key is bound to the user.
    const key = new URL(cb.location!, base).searchParams.get("k")!;
    assert.equal((await owner.get(`/w/${T}/connections/facebook/pick?k=${encodeURIComponent(key)}`)).status, 400);
    assert.equal((await op.post(`/w/${T}/connections/facebook/pick`, { k: key, account_id: "222" }, pick.body)).status, 400, "can't pick a Page without posting rights");
    const done = await op.post(`/w/${T}/connections/facebook/pick`, { k: key, account_id: "111" }, pick.body);
    assert.match(done.location!, /m=connected/);
    assert.match((await op.get(done.location!)).body, /Acme Plumbing Page/);
    assert.equal(pg.admin("SELECT count(*) FROM credentials c JOIN integrations i ON i.id = c.integration_id WHERE i.channel = 'facebook'"), "1");
  });

  it("dry run → paused → live: every check is re-run at send time", async () => {
    const op = await signIn("ops@jat.example");
    const editor = await signIn("editor@acme.example");
    const item = seedApproved();

    // Editors can see but not schedule.
    const ep = await editor.get(`/w/${T}/content/${item}`);
    assert.doesNotMatch(ep.body, />Schedule</);
    assert.equal((await editor.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: fingerprint(ep.body) }, ep.body)).status, 403);
    // A stale fingerprint (content changed since the page loaded) is refused.
    let page = await op.get(`/w/${T}/content/${item}`);
    assert.match(page.body, /Publishes to <strong>@acme\.bsky\.social<\/strong>/);
    assert.match((await op.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: "0".repeat(64) }, page.body)).location!, /m=stale/);

    await scheduleNow(op, item);
    assert.equal(state(item), "scheduled");
    // Double-scheduling is refused (one live publication per post).
    assert.match((await op.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: fingerprint(page.body) }, page.body)).location!, /m=stale/);

    // 1. Dry run: nothing sent; post goes back to approved.
    assert.deepEqual(await dispatch(), ["dry_run"]);
    assert.equal(bsky.sent.length, 0);
    assert.equal(state(item), "approved");
    assert.equal(pubs(item), "dry_run");
    page = await op.get(`/w/${T}/content/${item}`);
    assert.match(page.body, /Dry run \(not sent\)/);

    // 2. PUBLISH_MODE=live but the client isn't enabled by a platform admin → still a dry run.
    deps.mode = "live";
    await scheduleNow(op, item);
    assert.deepEqual(await dispatch(), ["dry_run"]);
    assert.match(pg.admin(`SELECT last_error FROM publications WHERE content_item_id = '${item}' ORDER BY created_at DESC LIMIT 1`), /Publishing not enabled for this client/);
    pg.admin(`UPDATE tenants SET publishing_enabled = true WHERE id = '${T}'`);

    // 3. Client paused: stays queued and is re-checked later.
    await scheduleNow(op, item);
    let conn = await op.get(`/w/${T}/connections`);
    await op.post(`/w/${T}/connections/pause`, { paused: "1", reason: "Checking a complaint" }, conn.body);
    assert.deepEqual(await dispatch(), ["paused"]);
    assert.deepEqual(await dispatch(), [], "not retried until the recheck time");
    assert.equal(state(item), "scheduled");
    conn = await op.get(`/w/${T}/connections`);
    assert.match(conn.body, /Publishing is paused for this client/);
    await op.post(`/w/${T}/connections/pause`, { paused: "0" }, conn.body);

    // 4. Live.
    clockOffsetMs = 6 * 60_000;
    assert.deepEqual(await dispatch(), ["published"]);
    clockOffsetMs = 1_000;
    assert.equal(bsky.sent.length, 1);
    const sent = bsky.sent[0]!;
    assert.equal(sent.post.text, composeCaption(postFixture({ channel: "bluesky", format: "text", creative_brief: null, alt_text: null })), "exactly the approved caption");
    assert.match(sent.post.link!.url, /utm_source=bluesky/);
    assert.deepEqual(sent.cred, { identifier: "acme.bsky.social", appPassword: GOOD }, "credential decrypted in the publisher");
    assert.equal(state(item), "published");
    page = await op.get(`/w/${T}/content/${item}`);
    assert.match(page.body, /href="https:\/\/bsky\.app\/profile\/acme\.bsky\.social\/post\/p1"/);

    // Idempotency: the published row is never sent again.
    const pubId = pg.admin(`SELECT id FROM publications WHERE content_item_id = '${item}' AND status = 'published'`);
    assert.equal(await processPublication(deps, { tenantId: T, publicationId: pubId }), "not_queued");
    assert.equal(bsky.sent.length, 1);
  });

  it("retries only what's safe to retry; stops on auth, ambiguous and stranded sends", async () => {
    const op = await signIn("ops@jat.example");

    // Rate limited → retried later with backoff, then succeeds.
    const a = seedApproved({ hook: "Retry me." });
    await scheduleNow(op, a);
    bsky.script.push(() => {
      throw new PublishError("transient", "Bluesky 429 RateLimitExceeded", 120_000);
    });
    assert.deepEqual(await dispatch(), ["retrying"]);
    assert.equal(state(a), "scheduled");
    assert.deepEqual(await dispatch(), [], "waits for the backoff");
    clockOffsetMs = 3 * 60_000;
    assert.deepEqual(await dispatch(), ["published"]);
    clockOffsetMs = 1_000;
    assert.equal(pg.admin(`SELECT attempts FROM publications WHERE content_item_id = '${a}'`), "2");

    // Too many transient failures → a person decides.
    const b = seedApproved({ hook: "Keep failing." });
    await scheduleNow(op, b);
    pg.admin(`UPDATE publications SET attempts = 4 WHERE content_item_id = '${b}'`);
    bsky.script.push(() => {
      throw new PublishError("transient", "Bluesky 503");
    });
    assert.deepEqual(await dispatch(), ["failed_transient"]);
    assert.equal(state(b), "failed");

    // Auth failure → account marked for reconnection; retry refused until reconnected.
    const c = seedApproved({ hook: "Auth trouble." });
    await scheduleNow(op, c);
    bsky.script.push(() => {
      throw new PublishError("auth", "Bluesky 401 ExpiredToken");
    });
    assert.deepEqual(await dispatch(), ["failed_auth"]);
    assert.equal(state(c), "failed");
    assert.equal(pg.admin("SELECT status FROM integrations WHERE channel = 'bluesky' AND status <> 'revoked'"), "needs_reauth");
    let page = await op.get(`/w/${T}/content/${c}`);
    assert.match(page.body, /Reconnect the account/);
    assert.equal((await op.post(`/w/${T}/content/${c}/retry`, {}, page.body)).status, 400);
    const conn = await op.get(`/w/${T}/connections`);
    assert.match(conn.body, /Reconnect needed/);
    await op.post(`/w/${T}/connections/bluesky`, { identifier: "acme.bsky.social", app_password: GOOD }, conn.body);
    assert.equal(pg.admin("SELECT count(*) || ':' || min(status) FROM integrations WHERE channel = 'bluesky'"), "1:connected", "same account revived, not duplicated");
    page = await op.get(`/w/${T}/content/${c}`);
    assert.match((await op.post(`/w/${T}/content/${c}/retry`, {}, page.body)).location!, /m=retrying/);
    assert.deepEqual(await dispatch(), ["published"]);

    // Ambiguous (e.g. timeout after sending) → never auto-retried; person checks and marks as posted.
    const d = seedApproved({ hook: "Did it post?" });
    await scheduleNow(op, d);
    bsky.script.push(() => {
      throw new PublishError("ambiguous", "No response within 30s");
    });
    const before = bsky.sent.length;
    assert.deepEqual(await dispatch(), ["failed_ambiguous"]);
    assert.deepEqual(await dispatch(), []);
    assert.equal(bsky.sent.length, before + 1);
    page = await op.get(`/w/${T}/content/${d}`);
    assert.match(page.body, /may have posted/);
    assert.match((await op.post(`/w/${T}/content/${d}/exported`, {}, page.body)).location!, /m=exported/);
    assert.equal(state(d), "exported");

    // Stranded (worker died mid-send) → needs attention, not resent.
    const e = seedApproved({ hook: "Stranded." });
    await scheduleNow(op, e);
    pg.admin(`UPDATE publications SET status = 'publishing', updated_at = now() - interval '20 minutes' WHERE content_item_id = '${e}'; UPDATE content_items SET state = 'publishing' WHERE id = '${e}';`);
    const sentBefore = bsky.sent.length;
    assert.deepEqual(await dispatch(), ["stranded"]);
    assert.equal(bsky.sent.length, sentBefore);
    assert.equal(state(e), "failed");
    assert.equal(pubs(e), "needs_attention");
  });

  it("blocks sends whose content, approval or post state changed after scheduling", async () => {
    const op = await signIn("ops@jat.example");
    const owner = await signIn("owner@acme.example");
    const sentBefore = bsky.sent.length;

    // Content tampered with in the database after approval → the hash no longer matches.
    const a = seedApproved({ hook: "Original words." });
    await scheduleNow(op, a);
    const tampered = JSON.stringify(postFixture({ channel: "bluesky", format: "text", creative_brief: null, alt_text: null, hook: "Tampered words.", link: null })).replace(/'/g, "''");
    pg.admin(`UPDATE content_revisions SET body = '${tampered}' WHERE content_item_id = '${a}'`);
    assert.deepEqual(await dispatch(), ["blocked"]);
    assert.match(pg.admin(`SELECT last_error FROM publications WHERE content_item_id = '${a}'`), /Content changed after approval/);
    assert.equal(state(a), "approved");

    // A reviewer sends a scheduled post back → the queued publication is cancelled.
    const b = seedApproved({ hook: "Sent back." });
    await scheduleNow(op, b);
    const page = await owner.get(`/w/${T}/content/${b}`);
    await owner.post(`/w/${T}/content/${b}/changes`, { comment: "Not this week" }, page.body);
    assert.equal(pubs(b), "cancelled", "cancelled immediately, so the post can be rescheduled after revision");
    assert.deepEqual(await dispatch(), []);
    // Defence in depth: if a queued send ever outlives its post's scheduled state, the publisher cancels it.
    const b2 = seedApproved({ hook: "Edge case." });
    await scheduleNow(op, b2);
    pg.admin(`UPDATE content_items SET state = 'approved' WHERE id = '${b2}'`);
    assert.deepEqual(await dispatch(), ["cancelled"]);

    // Unschedule.
    const c = seedApproved({ hook: "Unschedule me." });
    await scheduleNow(op, c);
    let p = await op.get(`/w/${T}/content/${c}`);
    assert.match(p.body, /Scheduled for/);
    assert.match((await op.post(`/w/${T}/content/${c}/unschedule`, {}, p.body)).location!, /m=unscheduled/);
    assert.equal(state(c), "approved");
    assert.equal(pubs(c), "cancelled");

    // Channel paused.
    await scheduleNow(op, c);
    const integration = pg.admin("SELECT id FROM integrations WHERE channel = 'bluesky' AND status = 'connected'");
    let conn = await op.get(`/w/${T}/connections`);
    await op.post(`/w/${T}/connections/${integration}/pause`, {}, conn.body);
    assert.deepEqual(await dispatch(), ["paused"]);
    // Reconnecting the same account doesn't silently lift the pause.
    conn = await op.get(`/w/${T}/connections`);
    await op.post(`/w/${T}/connections/bluesky`, { identifier: "acme.bsky.social", app_password: GOOD }, conn.body);
    assert.equal(pg.admin(`SELECT channel_paused FROM integrations WHERE id = '${integration}'`), "t");
    conn = await op.get(`/w/${T}/connections`);
    await op.post(`/w/${T}/connections/${integration}/resume`, {}, conn.body);

    // Paused for more than a day → not sent late; a person decides.
    pg.admin(`UPDATE platform_settings SET global_paused = true; UPDATE publications SET scheduled_for = now() - interval '2 days', next_attempt_at = NULL WHERE content_item_id = '${c}' AND status = 'queued'`);
    assert.deepEqual(await dispatch(), ["blocked"]);
    assert.match(pg.admin(`SELECT last_error FROM publications WHERE content_item_id = '${c}' ORDER BY created_at DESC LIMIT 1`), /more than a day/);
    pg.admin(`UPDATE platform_settings SET global_paused = false`);

    // A post that already went out (e.g. a stranded send that succeeded late) is never sent again.
    const twice = seedApproved({ hook: "Only once." });
    await scheduleNow(op, twice);
    pg.admin(`INSERT INTO publications (tenant_id, content_item_id, revision_id, integration_id, idempotency_key, status, external_id, published_at)
      SELECT tenant_id, content_item_id, revision_id, integration_id, 'earlier-attempt', 'published', 'at://x/app.bsky.feed.post/1', now() FROM publications WHERE content_item_id = '${twice}'`);
    assert.deepEqual(await dispatch(), ["blocked"]);
    assert.match(pg.admin(`SELECT last_error FROM publications WHERE content_item_id = '${twice}' AND status = 'needs_attention'`), /already published/);

    // Image posts need their image attached (and approved) before they can be scheduled; non-social channels export only.
    const img = seedApproved({ hook: "Picture this.", format: "image", creative_brief: { template: "tip-card", headline: "x" }, alt_text: "A pipe" });
    p = await op.get(`/w/${T}/content/${img}`);
    assert.match(p.body, /Add the image in the Media section first/);
    assert.equal((await op.post(`/w/${T}/content/${img}/schedule`, { now: "1", fingerprint: fingerprint(p.body) }, p.body)).status, 400);
    const wp = seedApproved({ hook: "Blog.", channel: "wordpress", format: "article", link: null });
    p = await op.get(`/w/${T}/content/${wp}`);
    assert.match(p.body, /isn&#39;t available for this channel yet/);
    const li = seedApproved({ hook: "LinkedIn.", channel: "linkedin", link: { url: "https://acme.example/?utm_source=linkedin&utm_medium=social&utm_campaign=w" } });
    p = await op.get(`/w/${T}/content/${li}`);
    assert.match(p.body, /Connect the account on the Connections page first/);

    assert.equal(bsky.sent.length, sentBefore, "nothing in this test reached the platform");
  });

  it("publishes to Facebook through the real adapter, then disconnects cleanly", async () => {
    const op = await signIn("ops@jat.example");
    const item = seedApproved({ hook: "Facebook time.", channel: "facebook", link: { url: "https://acme.example/w?utm_source=facebook&utm_medium=social&utm_campaign=w" } });
    await scheduleNow(op, item);
    assert.deepEqual(await dispatch(), ["published"]);
    const feed = fbCalls.find((c) => c.url.pathname === "/v26.0/111/feed")!;
    const form = new URLSearchParams(feed.body);
    assert.match(form.get("message")!, /^Facebook time\./);
    assert.equal(form.get("appsecret_proof"), appSecretProof("app-secret", "PAGE-TOKEN-SECRET"));
    assert.equal(pg.admin(`SELECT permalink FROM publications WHERE content_item_id = '${item}'`), "https://www.facebook.com/111/posts/999");

    const conn = await op.get(`/w/${T}/connections`);
    assert.match(conn.body, /Facebook time\./, "recent publishing list");
    const fb = pg.admin("SELECT id FROM integrations WHERE channel = 'facebook'");
    assert.match((await op.post(`/w/${T}/connections/${fb}/disconnect`, {}, conn.body)).location!, /m=disconnected/);
    assert.equal(pg.admin(`SELECT count(*) FROM credentials WHERE integration_id = '${fb}'`), "0");
    assert.equal(pg.admin(`SELECT status FROM integrations WHERE id = '${fb}'`), "revoked");

    // Everything is in the audit log.
    const audit = pg.admin(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log`);
    for (const x of ["integration.connected", "integration.disconnected", "integration.checked", "tenant.paused", "tenant.resumed", "channel.paused", "publish.scheduled", "publish.dry_run", "publish.started", "publish.succeeded", "publish.retry_scheduled", "publish.failed", "publish.blocked", "publish.cancelled", "publish.stranded", "publish.retried", "content.schedule", "content.unschedule", "content.start_publish", "content.publish_succeeded"]) {
      assert.ok(audit.includes(x), `audit has ${x}`);
    }
    // No other tenant was touched.
    assert.equal(pg.admin(`SELECT count(*) FROM audit_log WHERE tenant_id = '${T2}'`), "0");
    assert.deepEqual(errors, []);
  });
});
