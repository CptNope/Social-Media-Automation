import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { contentHash, type PostDraft } from "@jat/core";
import { PsqlDatabase } from "@jat/db/testing/psql-client";
import { BlueskyAdapter, InstagramAdapter, TikTokAdapter } from "@jat/integrations";
import { LocalMediaStore, type GraphicRenderer } from "@jat/media";
import { LocalKekProvider } from "@jat/vault";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "../../../packages/db/test/pg-harness.ts";
import { brandFixture, postFixture } from "../../../packages/core/test/fixtures.ts";
import { createApp, type Mailer } from "../src/app.ts";
import { InProcessJobs } from "../src/jobs.ts";
import { dispatchDue, type PublisherDeps } from "../src/publisher.ts";

const bin = findPgBin();
const T = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const BRAND = "b1111111-1111-4111-8111-111111111111";
const DNA = "d1111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const fx = (n: string) => readFileSync(new URL(`../../../packages/media/test/fixtures/${n}`, import.meta.url));

class Browser {
  jar = new Map<string, string>();
  constructor(private readonly base: string) {}
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  #store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";");
      const [k, v] = kv!.split("=") as [string, string];
      if (!v || attrs.some((a) => /max-age=0/i.test(a.trim()))) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async get(path: string) {
    const res = await fetch(this.base + path, { headers: { cookie: this.cookie }, redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
  }
  async page(path: string) {
    const r = await this.get(path);
    return { ...r, html: r.body.toString("utf8") };
  }
  async post(path: string, fields: Record<string, string>, csrfFrom: string) {
    const form = new URLSearchParams(fields);
    form.set("_csrf", /name="_csrf" value="([^"]+)"/.exec(csrfFrom)![1]!);
    const res = await fetch(this.base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: this.base, cookie: this.cookie }, body: form.toString(), redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  /** A real multipart/form-data upload, as a browser form with enctype=multipart/form-data sends it. */
  async upload(path: string, fields: Record<string, string>, file: { name: string; type: string; data: Buffer } | null, csrfFrom: string | null) {
    const form = new FormData();
    if (csrfFrom) form.append("_csrf", /name="_csrf" value="([^"]+)"/.exec(csrfFrom)![1]!);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (file) form.append("file", new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
    const res = await fetch(this.base + path, { method: "POST", headers: { origin: this.base, cookie: this.cookie }, body: form, redirect: "manual" });
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
}

/** Renders nothing: returns a fixed real JPEG (Chromium rendering is covered in @jat/media). */
const stubRenderer: GraphicRenderer & { calls: Array<{ html: string; size: { width: number; height: number } }> } = {
  calls: [],
  async renderJpeg(html, size) {
    this.calls.push({ html, size });
    return fx("portrait.jpg");
  },
};

describe("media: upload, generated graphics, approval and publishing with files (real Postgres)", { skip: bin ? false : "Postgres binaries not found" }, () => {
  let pg: TempPg;
  let db: PsqlDatabase;
  let publisherDb: PsqlDatabase;
  let server: Server;
  let base: string;
  let deps: PublisherDeps;
  let mediaDir: string;
  const mailer: Mailer & { sent: Array<{ email: string; url: string }> } = { sent: [], async sendLoginLink(email, url) { this.sent.push({ email, url }); } };
  const jobs = new InProcessJobs(1);
  const errors: unknown[] = [];
  const platformCalls: Array<{ url: URL; init: RequestInit }> = [];
  const igFetchedImages: Buffer[] = [];

  async function signIn(email: string) {
    const b = new Browser(base);
    await b.post("/login", { email }, 'name="_csrf" value="x"');
    await jobs.idle();
    const token = new URL(mailer.sent.at(-1)!.url).searchParams.get("token")!;
    const res = await fetch(`${base}/login/verify`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams({ token }).toString(), redirect: "manual" });
    b.jar.set(res.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[0]!, res.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[1]!);
    return b;
  }
  const one = (sql: string) => pg.admin(sql).split("\n")[0]!;
  function seedApproved(over: Partial<PostDraft>): string {
    const post = postFixture({ link: null, ...over });
    const json = JSON.stringify(post).replace(/'/g, "''");
    const item = one(`INSERT INTO content_items (tenant_id, brand_id, channel, kind, state, risk_class) VALUES ('${T}', '${BRAND}', '${post.channel}', 'social_post', 'approved', 'low') RETURNING id`);
    const rev = one(`INSERT INTO content_revisions (tenant_id, content_item_id, revision, body, content_hash, created_by) VALUES ('${T}', '${item}', 1, '${json}', '${contentHash(post)}', 'test') RETURNING id`);
    pg.admin(`UPDATE content_items SET current_revision_id = '${rev}' WHERE id = '${item}';
      INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision, decided_by) VALUES ('${T}', '${item}', '${rev}', '${contentHash(post)}', 'approved', '${OWNER}');`);
    return item;
  }
  const hashOf = (html: string) => /name="base_hash" value="([0-9a-f]{64})"/.exec(html)![1]!;
  const fingerprint = (html: string) => /name="fingerprint" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
  const body = (item: string) => JSON.parse(pg.admin(`SELECT r.body FROM content_items ci JOIN content_revisions r ON r.id = ci.current_revision_id WHERE ci.id = '${item}'`)) as PostDraft;

  async function approve(owner: Browser, item: string) {
    let p = await owner.page(`/w/${T}/content/${item}`);
    const r = await owner.post(`/w/${T}/content/${item}/submit`, {}, p.html);
    assert.match(r.location!, /m=submitted/, r.body.slice(0, 200));
    p = await owner.page(`/w/${T}/content/${item}`);
    assert.match((await owner.post(`/w/${T}/content/${item}/approve`, { fingerprint: fingerprint(p.html) }, p.html)).location!, /m=approved/);
  }

  before(async () => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    const dna = JSON.stringify(brandFixture()).replace(/'/g, "''");
    pg.admin(`
      INSERT INTO tenants (id, name, slug, publishing_enabled) VALUES ('${T}', 'Acme Plumbing', 'acme', true), ('${T2}', 'Bravo', 'bravo', false);
      INSERT INTO users (id, email, name) VALUES ('${OWNER}', 'owner@acme.example', 'Olive'), ('${OP}', 'ops@jat.example', 'Oscar'), ('${OTHER}', 'owner@bravo.example', 'Bo');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${T}', '${OWNER}', 'client_owner'), ('${T}', '${OP}', 'agency_operator'), ('${T2}', '${OTHER}', 'client_owner');
      INSERT INTO brands (id, tenant_id, name) VALUES ('${BRAND}', '${T}', 'Acme');
      INSERT INTO brand_dna_versions (id, tenant_id, brand_id, version, status, data, created_by, approved_by, approved_at) VALUES ('${DNA}', '${T}', '${BRAND}', 1, 'active', '${dna}', 'test', '${OWNER}', now());
      UPDATE brands SET active_dna_version_id = '${DNA}' WHERE id = '${BRAND}';`);
    db = new PsqlDatabase(pg.conn);
    publisherDb = new PsqlDatabase(pg.conn, "publisher_user");
    const kek = new LocalKekProvider(randomBytes(32), "test-kek");
    const mediaSecret = randomBytes(32);
    mediaDir = mkdtempSync(join(tmpdir(), "jat-media-e2e-"));
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const store = new LocalMediaStore(mediaDir, { secret: mediaSecret, baseUrl: base });

    // Fake Instagram + TikTok. Instagram's "fetcher" really downloads the signed URL from our app.
    const platforms = (async (u: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(u));
      platformCalls.push({ url, init });
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
      if (url.hostname === "graph.facebook.com") {
        if (url.pathname.endsWith("/1784/media")) {
          const imageUrl = new URLSearchParams(String(init.body)).get("image_url")!;
          const got = await fetch(imageUrl);
          if (!got.ok) return json({ error: { message: "Media download has failed", code: 9004, error_subcode: 2207052 } }, 400);
          igFetchedImages.push(Buffer.from(await got.arrayBuffer()));
          return json({ id: "C1" });
        }
        if (url.pathname.endsWith("/C1")) return json({ status_code: "FINISHED" });
        if (url.pathname.endsWith("/media_publish")) return json({ id: "M1" });
        return json({ permalink: "https://www.instagram.com/p/abc/" });
      }
      if (url.hostname === "open.tiktokapis.com") {
        if (url.pathname.endsWith("/inbox/video/init/")) return json({ data: { publish_id: "v_inbox_9", upload_url: "https://open-upload.tiktokapis.com/upload/?x=1" }, error: { code: "ok" } });
        return json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } });
      }
      if (url.hostname === "open-upload.tiktokapis.com") return new Response(null, { status: 201 });
      return json({ error: { message: "unexpected" } }, 404);
    }) as typeof fetch;
    const instagram = new InstagramAdapter({ appId: "a", appSecret: "s", version: "v26.0", redirectUri: `${base}/oauth/instagram/callback` }, platforms, async () => {});
    const tiktok = new TikTokAdapter({ clientKey: "k", clientSecret: "s", redirectUri: `${base}/oauth/tiktok/callback` }, platforms, async () => {});
    deps = { publisherDb, keks: kek, activeKek: kek, media: store, mode: "live", adapters: { bluesky: new BlueskyAdapter(platforms), instagram, tiktok }, safeFetch: platforms, log: (m, e) => errors.push([m, e]) };
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
      media: { store, maxUploadBytes: 2 * 1024 * 1024, renderer: stubRenderer, localSigningSecret: mediaSecret },
      publishing: { mode: "live", activeKek: kek, bluesky: deps.adapters.bluesky!, oauth: { instagram, tiktok }, publisher: deps },
    });
    server.on("request", (req, res) => void handler(req, res));
    // Connected accounts (encrypted credentials, as the connect flow would store them).
    const { encryptSecret } = await import("@jat/vault");
    for (const [channel, ext, cred] of [
      ["instagram", "1784", { igUserId: "1784", username: "acme", pageId: "111", pageAccessToken: "PAGE", userAccessToken: "USER" }],
      ["tiktok", "open-1", { openId: "open-1", displayName: "Acme", accessToken: "AT", refreshToken: "RT" }],
    ] as const) {
      const id = one(`INSERT INTO integrations (tenant_id, channel, external_account_id, display_name) VALUES ('${T}', '${channel}', '${ext}', '${channel}') RETURNING id`);
      const rec = await encryptSecret(JSON.stringify(cred), { tenantId: T, integrationId: id }, kek);
      pg.admin(`INSERT INTO credentials (integration_id, tenant_id, version, kek_id, wrapped_dek, iv, auth_tag, ciphertext) VALUES ('${id}', '${T}', 1, '${rec.kekId}', '${rec.wrappedDek}', '${rec.iv}', '${rec.authTag}', '${rec.ciphertext}')`);
    }
  });

  after(async () => {
    await new Promise((r) => server?.close(r));
    await db?.close();
    await publisherDb?.close();
    pg?.stop();
  });

  it("uploads are checked by content, tenant-scoped, size-limited and CSRF-protected; attaching drops approval", async () => {
    const op = await signIn("ops@jat.example");
    const item = seedApproved({ channel: "instagram", format: "image", hook: "Three checks before the first hard freeze.", alt_text: null });
    let p = await op.page(`/w/${T}/content/${item}`);
    assert.match(p.html, /needs an image before it can be published/);
    assert.match(p.html, /enctype="multipart\/form-data"/);
    const path = `/w/${T}/content/${item}/media/upload`;

    // No CSRF token → refused before anything is stored.
    assert.equal((await op.upload(path, { base_hash: hashOf(p.html) }, { name: "a.jpg", type: "image/jpeg", data: fx("portrait.jpg") }, null)).status, 403);
    // A text file named .jpg is refused (content, not the name, decides).
    assert.equal((await op.upload(path, { base_hash: hashOf(p.html) }, { name: "a.jpg", type: "image/jpeg", data: fx("fake.jpg") }, p.html)).status, 415);
    // Over the size limit → 413, and the temp file is gone.
    assert.equal((await op.upload(path, { base_hash: hashOf(p.html) }, { name: "big.jpg", type: "image/jpeg", data: Buffer.concat([fx("portrait.jpg"), randomBytes(3 * 1024 * 1024)]) }, p.html)).status, 413);
    // Multipart is refused anywhere except the upload route.
    assert.equal((await op.upload(`/w/${T}/content/${item}/edit`, {}, null, p.html)).status, 415);
    assert.equal(readdirSync(mediaDir).length, 0, "nothing stored yet");

    const r = await op.upload(path, { base_hash: hashOf(p.html), alt_text: "Technician wrapping a pipe in foam" }, { name: "photo.jpg", type: "image/jpeg", data: fx("portrait.jpg") }, p.html);
    assert.match(r.location ?? "", /m=media_added/, r.body.slice(0, 300));
    const b = body(item);
    assert.equal(b.media![0]!.kind, "image");
    assert.equal(b.media![0]!.width, 1080);
    assert.equal(b.alt_text, "Technician wrapping a pipe in foam");
    assert.equal(pg.admin(`SELECT state FROM content_items WHERE id = '${item}'`), "draft", "a new file needs approving again");
    assert.equal(b.media![0]!.sha256, pg.admin(`SELECT sha256 FROM assets WHERE id = '${b.media![0]!.asset_id}'`));

    p = await op.page(`/w/${T}/content/${item}`);
    const preview = await op.get(`/w/${T}/media/${b.media![0]!.asset_id}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/jpeg");
    assert.ok(preview.body.equals(fx("portrait.jpg")));
    // Another client's owner can't see it.
    const other = await signIn("owner@bravo.example");
    assert.equal((await other.get(`/w/${T}/media/${b.media![0]!.asset_id}`)).status, 404);
    assert.equal((await other.get(`/w/${T2}/media/${b.media![0]!.asset_id}`)).status, 404);
    // A stale page can't overwrite newer media.
    assert.match((await op.upload(path, { base_hash: "0".repeat(64) }, { name: "p.jpg", type: "image/jpeg", data: fx("portrait.jpg") }, p.html)).location!, /m=stale/);

    // PNG on Instagram is a "Must fix" (JPEG only), so it can't be sent for approval.
    const png = await op.upload(path, { base_hash: hashOf(p.html), alt_text: "Wide" }, { name: "w.png", type: "image/png", data: fx("wide.png") }, p.html);
    assert.match(png.location!, /m=media_added/);
    p = await op.page(`/w/${T}/content/${item}`);
    assert.match(p.html, /instagram accepts jpeg; this file is png/);
    assert.match((await op.post(`/w/${T}/content/${item}/submit`, {}, p.html)).location!, /m=blocked/);
  });

  it("generates a branded graphic from the brief, then publishes it to Instagram via a signed URL", async () => {
    const op = await signIn("ops@jat.example");
    const owner = await signIn("owner@acme.example");
    const item = seedApproved({ channel: "instagram", format: "image", hook: "Winter checks.", creative_brief: { template: "tip-card", headline: "3 freeze-proof checks", supporting_text: "Insulate & seal" }, alt_text: "Checklist graphic" });
    let p = await op.page(`/w/${T}/content/${item}`);
    const r = await op.post(`/w/${T}/content/${item}/media/generate`, { base_hash: hashOf(p.html) }, p.html);
    assert.match(r.location!, /m=graphic_added/, r.body.slice(0, 300));
    const call = stubRenderer.calls.at(-1)!;
    assert.deepEqual(call.size, { width: 1080, height: 1350 }, "Instagram's 4:5 size");
    assert.match(call.html, /3 freeze-proof checks/);
    assert.match(call.html, /Insulate &amp; seal/);
    assert.equal(body(item).media![0]!.origin, "rendered");

    await approve(owner, item);
    p = await op.page(`/w/${T}/content/${item}`);
    assert.match((await op.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: fingerprint(p.html) }, p.html)).location!, /m=scheduled/);
    assert.deepEqual((await dispatchDue(deps)).map((x) => x.outcome), ["published"]);
    // Instagram fetched exactly the approved file from a short-lived signed URL.
    assert.ok(igFetchedImages.at(-1)!.equals(fx("portrait.jpg")));
    const container = new URLSearchParams(String(platformCalls.find((c) => c.url.pathname.endsWith("/1784/media"))!.init.body));
    const signed = new URL(container.get("image_url")!);
    assert.match(signed.pathname, /^\/media\/signed\/t\//);
    assert.equal(container.get("alt_text"), "Checklist graphic");
    // The signed URL is useless once tampered with, and the preview route needs a session.
    signed.searchParams.set("sig", "x".repeat(43));
    assert.equal((await fetch(signed)).status, 404);
    assert.equal((await fetch(`${base}/w/${T}/media/${body(item).media![0]!.asset_id}`, { redirect: "manual" })).status, 303);
    p = await op.page(`/w/${T}/content/${item}`);
    assert.match(p.html, /href="https:\/\/www\.instagram\.com\/p\/abc\/"/);
  });

  it("never sends a file that changed after approval", async () => {
    const op = await signIn("ops@jat.example");
    const owner = await signIn("owner@acme.example");
    const item = seedApproved({ channel: "instagram", format: "image", hook: "Swapped file.", alt_text: "Photo" });
    let p = await op.page(`/w/${T}/content/${item}`);
    await op.upload(`/w/${T}/content/${item}/media/upload`, { base_hash: hashOf(p.html), alt_text: "Photo" }, { name: "p.jpg", type: "image/jpeg", data: fx("portrait.jpg") }, p.html);
    await approve(owner, item);
    p = await op.page(`/w/${T}/content/${item}`);
    await op.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: fingerprint(p.html) }, p.html);
    // Someone overwrites the stored file behind the app's back.
    const key = pg.admin(`SELECT storage_key FROM assets WHERE id = '${body(item).media![0]!.asset_id}'`);
    writeFileSync(join(mediaDir, key), Buffer.from("tampered"));
    const before = igFetchedImages.length;
    assert.deepEqual((await dispatchDue(deps)).map((x) => x.outcome), ["failed_permanent"]);
    assert.equal(igFetchedImages.length, before, "the URL was never even handed to Instagram");
    assert.equal(platformCalls.filter((c) => c.url.pathname.endsWith("/media_publish")).length, 1, "only the earlier, genuine post");
    assert.match(pg.admin(`SELECT last_error FROM publications WHERE content_item_id = '${item}'`), /no longer matches the approved one/);
  });

  it("TikTok: an uploaded video goes to the creator's drafts, with a note saying so", async () => {
    const op = await signIn("ops@jat.example");
    const owner = await signIn("owner@acme.example");
    const item = seedApproved({ channel: "tiktok", format: "video", hook: "Find your shut-off in 20 seconds.", creative_brief: { template: "talking-head", headline: "Find your shut-off" }, alt_text: "Technician pointing at a valve" });
    let p = await op.page(`/w/${T}/content/${item}`);
    assert.doesNotMatch(p.html, /Generate graphic from the brief/, "no graphics for video-only channels");
    const r = await op.upload(`/w/${T}/content/${item}/media/upload`, { base_hash: hashOf(p.html) }, { name: "clip.mp4", type: "video/mp4", data: fx("vertical.mp4") }, p.html);
    assert.match(r.location!, /m=media_added/);
    const m = body(item).media![0]!;
    assert.deepEqual([m.kind, m.width, m.height], ["video", 360, 640]);
    assert.ok(m.duration_ms! >= 2400);
    p = await op.page(`/w/${T}/content/${item}`);
    assert.match(p.html, /<video src="\/w\/[^"]+\/media\/[0-9a-f-]{36}" controls/);
    await approve(owner, item);
    p = await op.page(`/w/${T}/content/${item}`);
    await op.post(`/w/${T}/content/${item}/schedule`, { now: "1", fingerprint: fingerprint(p.html) }, p.html);
    assert.deepEqual((await dispatchDue(deps)).map((x) => x.outcome), ["published"]);
    const put = platformCalls.find((c) => c.url.hostname === "open-upload.tiktokapis.com")!;
    assert.ok(Buffer.from(put.init.body as Uint8Array).equals(fx("vertical.mp4")));
    p = await op.page(`/w/${T}/content/${item}`);
    assert.match(p.html, /Sent to the creator&#39;s TikTok drafts/);

    // Removing media is a new version too.
    const text = seedApproved({ channel: "instagram", format: "image", hook: "Remove me.", alt_text: "Photo" });
    p = await op.page(`/w/${T}/content/${text}`);
    await op.upload(`/w/${T}/content/${text}/media/upload`, { base_hash: hashOf(p.html), alt_text: "Photo" }, { name: "p.jpg", type: "image/jpeg", data: fx("portrait.jpg") }, p.html);
    p = await op.page(`/w/${T}/content/${text}`);
    assert.match((await op.post(`/w/${T}/content/${text}/media/remove`, { base_hash: hashOf(p.html) }, p.html)).location!, /m=media_removed/);
    assert.equal(body(text).media, undefined);
    assert.deepEqual(errors.filter((e) => !String((e as unknown[])[0]).includes("[publisher]")), []);
  });
});
