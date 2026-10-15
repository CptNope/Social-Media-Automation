import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { runBrandExtraction, type ClaudeClient } from "@jat/ai";
import { DbSpendLedger } from "@jat/db";
import type { CrawlResult } from "@jat/ingest";
import { PsqlDatabase } from "@jat/db/testing/psql-client";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "../../../packages/db/test/pg-harness.ts";
import { clientIp, createApp, isRealDate, type Mailer } from "../src/app.ts";
import { InProcessJobs } from "../src/jobs.ts";

const bin = findPgBin();
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EDITOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OUTSIDER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const HOME_TEXT = "Acme Plumbing. Warm homes, dry basements. Licensed in Massachusetts. Serving Worcester and Shrewsbury.";

const row = (path: string, value: unknown, sources: string[], status: "extracted" | "inferred" | "missing" = "extracted") => ({ path, value_json: JSON.stringify(value), sources, confidence: "high", status });
const wire = {
  fields: [
    row("identity.display_name", "Acme Plumbing", ["web:/"]),
    row("identity.tagline", "Warm homes, dry basements", ["web:/"]),
    row("visual.colors", [{ name: "Primary", hex: "#1A4C8B", role: "primary" }], ["css:site"], "inferred"),
    row("voice.personality", ["friendly", "<script>alert(1)</script>"], ["web:/"], "inferred"),
    row("strategy.geo_targets", ["Worcester", "Shrewsbury"], ["web:/"]),
  ],
  candidate_claims: [{ text: "Licensed in Massachusetts", category: "credential", quote: "Licensed in Massachusetts", source_id: "web:/" }],
  conflicts: [],
  missing_information: ["Year founded"],
};

const fakeClaude: ClaudeClient = {
  async createMessage(req) {
    return { id: "msg", model: req.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(wire) }], usage: { input_tokens: 10_000, output_tokens: 2_000 } };
  },
};

const fakeCrawl = async (): Promise<CrawlResult> => ({
  pages: [{ url: "https://acme.example/", status: 200, page: { title: "Acme", metaDescription: "", canonical: null, robotsMeta: null, h1: [], h2: [], text: HOME_TEXT, links: [], stylesheets: [], colors: ["#1A4C8B"], fonts: [], imagesMissingAlt: 0 } }],
  skipped: [],
  robots: { status: "ok", sitemaps: [] },
  requests: 2,
  siteColors: ["#1A4C8B"],
  siteFonts: ["Inter"],
  evidence: [
    { id: "web:/", kind: "web", text: HOME_TEXT },
    { id: "css:site", kind: "css", text: "Colors used on the website: #1A4C8B" },
  ],
});

class MemoryMailer implements Mailer {
  sent: Array<{ email: string; url: string }> = [];
  async sendLoginLink(email: string, url: string) {
    this.sent.push({ email, url });
  }
}

/** Minimal browser: cookie jar, same-origin headers, CSRF extraction, no auto-redirect. */
class Browser {
  cookie = "";
  constructor(private readonly base: string) {}
  async get(path: string) {
    const res = await fetch(this.base + path, { headers: this.cookie ? { cookie: this.cookie } : {}, redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), headers: res.headers, body: await res.text() };
  }
  async post(path: string, fields: Record<string, string>, opts: { origin?: string | null; csrfFrom?: string } = {}) {
    const form = new URLSearchParams(fields);
    if (opts.csrfFrom !== undefined) {
      const m = /name="_csrf" value="([^"]+)"/.exec(opts.csrfFrom);
      if (m) form.set("_csrf", m[1]!);
      const fp = /name="fingerprint" value="([^"]+)"/.exec(opts.csrfFrom);
      if (fp && !form.has("fingerprint")) form.set("fingerprint", fp[1]!);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (opts.origin !== null) headers.origin = opts.origin ?? this.base;
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(this.base + path, { method: "POST", headers, body: form.toString(), redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  #store(res: Response) {
    const set = res.headers.get("set-cookie");
    if (!set) return;
    const [pair] = set.split(";");
    this.cookie = pair!.endsWith("=") ? "" : pair!;
  }
}

describe("web app end to end (real Postgres)", { skip: bin ? false : "Postgres binaries not found" }, () => {
  let pg: TempPg;
  let db: PsqlDatabase;
  let server: Server;
  let base: string;
  const mailer = new MemoryMailer();
  const jobs = new InProcessJobs(1);
  const errors: unknown[] = [];

  async function signIn(email: string): Promise<Browser> {
    const b = new Browser(base);
    const before = mailer.sent.length;
    const r = await b.post("/login", { email });
    assert.equal(r.status, 200);
    assert.equal(mailer.sent.length, before + 1, `mail sent to ${email}`);
    const link = new URL(mailer.sent.at(-1)!.url);
    const verify = await b.get(link.pathname + link.search);
    assert.match(verify.body, /Finish signing in/);
    const done = await b.post("/login/verify", { token: link.searchParams.get("token")! });
    assert.equal(done.status, 303);
    assert.ok(b.cookie.startsWith("jat_session="));
    return b;
  }

  before(async () => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    pg.admin(`
      INSERT INTO tenants (id, name, slug) VALUES ('${A}', 'Acme Plumbing', 'acme'), ('${B}', 'Bravo Bakery', 'bravo');
      INSERT INTO users (id, email, name) VALUES
        ('${OWNER}', 'owner@acme.example', 'Olive Owner'), ('${OP}', 'ops@jat.example', 'Oscar Operator'),
        ('${EDITOR}', 'editor@acme.example', 'Edie Editor'), ('${OUTSIDER}', 'owner@bravo.example', 'Bo Bravo');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES
        ('${A}', '${OWNER}', 'client_owner'), ('${A}', '${OP}', 'agency_operator'), ('${B}', '${OP}', 'agency_operator'),
        ('${A}', '${EDITOR}', 'client_editor'), ('${B}', '${OUTSIDER}', 'client_owner');`);
    db = new PsqlDatabase(pg.conn);
    const ledger = new DbSpendLedger(db);
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const handler = createApp({
      db,
      sessionSecret: randomBytes(32),
      baseUrl: base,
      mailer,
      jobs,
      log: (m, e) => { errors.push(e); if (process.env.DEBUG_WEB) console.error(m, e); },
      onboarding: { crawl: fakeCrawl, extract: (input) => runBrandExtraction({ client: fakeClaude, ledger }, input) },
    });
    server.on("request", (req, res) => void handler(req, res));
  });

  after(async () => {
    await new Promise((r) => server?.close(r));
    await db?.close();
    pg?.stop();
  });

  it("requires sign-in and sends security headers", async () => {
    const b = new Browser(base);
    const r = await b.get("/");
    assert.equal(r.status, 303);
    assert.equal(r.location, "/login");
    const login = await b.get("/login");
    assert.match(login.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(login.headers.get("x-frame-options"), "DENY");
    assert.equal(login.headers.get("cache-control"), "no-store");
  });

  it("does not reveal whether an email has an account, and blocks cross-site posts", async () => {
    const b = new Browser(base);
    const before = mailer.sent.length;
    const unknown = await b.post("/login", { email: "stranger@example.com" });
    assert.equal(unknown.status, 200);
    assert.match(unknown.body, /If <strong>stranger@example.com<\/strong> has an account/);
    assert.equal(mailer.sent.length, before);
    assert.equal((await b.post("/login", { email: "owner@acme.example" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await b.post("/login", { email: "owner@acme.example" }, { origin: null })).status, 403);
  });

  it("magic links work once", async () => {
    const b = new Browser(base);
    await b.post("/login", { email: "ops@jat.example" });
    const link = new URL(mailer.sent.at(-1)!.url);
    const token = link.searchParams.get("token")!;
    assert.equal((await b.post("/login/verify", { token })).status, 303);
    const again = await new Browser(base).post("/login/verify", { token });
    assert.equal(again.status, 400);
    assert.match(again.body, /expired or was already used/);
  });

  it("full flow: operator drafts Brand DNA, owner approves, claims verified", async () => {
    const op = await signIn("ops@jat.example");
    const list = await op.get("/");
    assert.match(list.body, /Acme Plumbing/);
    assert.match(list.body, /Bravo Bakery/);

    // Without a CSRF token, state changes are refused.
    assert.equal((await op.post(`/w/${A}/brands`, { name: "Acme" })).status, 403);

    const overview = await op.get(`/w/${A}`);
    assert.equal(overview.status, 200);
    const created = await op.post(`/w/${A}/brands`, { name: "Acme Plumbing" }, { csrfFrom: overview.body });
    assert.equal(created.status, 303);

    const brandPage = await op.get(`/w/${A}/brand`);
    assert.match(brandPage.body, /Draft Brand DNA/);
    const started = await op.post(`/w/${A}/brand/onboarding`, { website_url: "https://acme.example/", business_name: "Acme Plumbing", notes: "Owner prefers 'technician' over 'plumber'. <b>bold</b>" }, { csrfFrom: brandPage.body });
    assert.equal(started.status, 303);
    await jobs.idle();
    const run = await op.get(started.location!);
    assert.match(run.body, /Ready for review/, run.body.slice(0, 3000));
    const versionPath = /href="(\/w\/[^"]+\/brand\/versions\/[^"]+)"/.exec(run.body)![1]!;

    let version = await op.get(versionPath);
    assert.match(version.body, /Inferred — needs confirmation/);
    assert.match(version.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "model output is escaped");
    assert.doesNotMatch(version.body, /<script>alert/);
    assert.match(version.body, /2 inferred fields need confirmation/);

    // Operators can't approve Brand DNA.
    assert.equal((await op.post(`${versionPath}/activate`, {}, { csrfFrom: version.body })).status, 403);

    // The owner can't approve while inferred fields are unconfirmed.
    const owner = await signIn("owner@acme.example");
    let ownerView = await owner.get(versionPath);
    const blocked = await owner.post(`${versionPath}/activate`, {}, { csrfFrom: ownerView.body });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body, /must be resolved/);

    // Invalid edits are rejected with a reason; valid edits and confirmations stick.
    const bad = await op.post(`${versionPath}/field`, { path: "identity.founded_year", action: "edit", value: "nineteen" }, { csrfFrom: version.body });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /Couldn&#39;t save/);
    assert.equal((await op.post(`${versionPath}/field`, { path: "voice.personality", action: "edit", value: "friendly\npractical" }, { csrfFrom: version.body })).status, 303);
    assert.equal((await op.post(`${versionPath}/field`, { path: "visual.colors", action: "confirm" }, { csrfFrom: version.body })).status, 303);
    assert.equal((await op.post(`${versionPath}/field`, { path: "identity.founded_year", action: "edit", value: "2004" }, { csrfFrom: version.body })).status, 303);
    version = await op.get(versionPath);
    assert.match(version.body, /Entered by a person/);
    assert.doesNotMatch(version.body, /needs confirmation before this can be approved/);

    ownerView = await owner.get(versionPath);
    // If anything changes after the owner loaded the page, approval is refused.
    assert.equal((await op.post(`${versionPath}/field`, { path: "identity.tagline", action: "edit", value: "Warm homes. Dry basements." }, { csrfFrom: version.body })).status, 303);
    const changed = await owner.post(`${versionPath}/activate`, {}, { csrfFrom: ownerView.body });
    assert.equal(changed.status, 409);
    assert.match(changed.body, /changed while you were reviewing/);
    ownerView = await owner.get(versionPath);
    assert.match(ownerView.body, /Warm homes. Dry basements./);
    const approved = await owner.post(`${versionPath}/activate`, {}, { csrfFrom: ownerView.body });
    assert.equal(approved.status, 303);
    ownerView = await owner.get(approved.location!);
    assert.match(ownerView.body, /Brand DNA approved/);
    assert.match(ownerView.body, /Approved versions can&#39;t change/);
    // Approved versions are frozen.
    const frozen = await op.post(`${versionPath}/field`, { path: "identity.tagline", action: "edit", value: "Changed" }, { csrfFrom: version.body });
    assert.match(frozen.location ?? "", /m=stale/);

    // Claims: the onboarding suggestion waits for the owner; editors can't verify.
    const editor = await signIn("editor@acme.example");
    let claims = await editor.get(`/w/${A}/claims`);
    assert.match(claims.body, /Licensed in Massachusetts/);
    assert.match(claims.body, /Quote: &quot;Licensed in Massachusetts&quot;/);
    const claimId = /\/claims\/([0-9a-f-]{36})\/(?:verify|reject)/.exec((await owner.get(`/w/${A}/claims`)).body)![1]!;
    assert.equal((await editor.post(`/w/${A}/claims/${claimId}/verify`, {}, { csrfFrom: claims.body })).status, 403);
    claims = await owner.get(`/w/${A}/claims`);
    const verified = await owner.post(`/w/${A}/claims/${claimId}/verify`, {}, { csrfFrom: claims.body });
    assert.equal(verified.status, 303);
    assert.match((await owner.get(verified.location!)).body, /Claim verified/);

    const editorClaims = await editor.get(`/w/${A}/claims`);
    const badDate = await editor.post(`/w/${A}/claims`, { text: "10% off in November", category: "offer", evidence_kind: "document", evidence_reference: "Promo sheet", expires_on: "11/30/2026" }, { csrfFrom: editorClaims.body });
    // Another user's CSRF token is not accepted.
    assert.equal((await editor.post(`/w/${A}/claims`, { text: "x", category: "other", evidence_kind: "document", evidence_reference: "y" }, { csrfFrom: claims.body })).status, 403);
    assert.equal(badDate.status, 400);
    assert.match(badDate.body, /YYYY-MM-DD/);

    // Activity is recorded.
    const ov = await owner.get(`/w/${A}`);
    for (const label of ["Brand DNA approved and activated", "Claim verified", "Brand DNA field edited", "Brand onboarding started"]) assert.match(ov.body, new RegExp(label));
    assert.deepEqual(errors, [], "no server errors");
  });

  it("other clients' workspaces and records are invisible", async () => {
    const outsider = await signIn("owner@bravo.example");
    assert.equal((await outsider.get(`/w/${A}`)).status, 404);
    assert.equal((await outsider.get(`/w/${A}/claims`)).status, 404);
    // Even through their own workspace URL, another tenant's record ids resolve to nothing.
    const versionId = pg.admin(`SELECT id FROM brand_dna_versions LIMIT 1`);
    assert.equal((await outsider.get(`/w/${B}/brand/versions/${versionId}`)).status, 404);
    assert.equal((await outsider.get(`/w/not-a-uuid`)).status, 404);
  });

  it("onboarding failures are shown plainly", async () => {
    const op = await signIn("ops@jat.example");
    const brandPage = await op.get(`/w/${A}/brand`);
    const bad = await op.post(`/w/${A}/brand/onboarding`, { website_url: "ftp://acme.example", business_name: "Acme" }, { csrfFrom: brandPage.body });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /starting with https/);
    const none = await op.post(`/w/${A}/brand/onboarding`, { website_url: "", business_name: "Acme", notes: "" }, { csrfFrom: brandPage.body });
    assert.equal(none.status, 400);
  });

  it("signing out revokes the session on every device", async () => {
    const laptop = await signIn("ops@jat.example");
    const phone = await signIn("ops@jat.example");
    const stolenCookie = laptop.cookie;
    const page = await laptop.get("/");
    const out = await laptop.post("/logout", {}, { csrfFrom: page.body });
    assert.equal(out.location, "/login");
    assert.equal((await laptop.get("/")).location, "/login");
    assert.equal((await phone.get("/")).location, "/login", "other devices are signed out too");
    const replay = new Browser(base);
    replay.cookie = stolenCookie;
    assert.equal((await replay.get("/")).location, "/login", "a copied cookie stops working");
  });

  it("a model can't fake a person's citation to skip confirmation", async () => {
    const { assembleBrandProposal } = await import("@jat/ai");
    const p = assembleBrandProposal({ fields: [{ path: "identity.founded_year", value_json: "1998", sources: ["user:" + OWNER], confidence: "high", status: "extracted" }], candidate_claims: [], conflicts: [], missing_information: [] });
    assert.deepEqual(p.dna.identity.founded_year.sources, []);
  });
});

describe("helpers", () => {
  it("accepts only real calendar dates", () => {
    assert.equal(isRealDate("2026-11-30"), true);
    assert.equal(isRealDate("2026-02-31"), false);
    assert.equal(isRealDate("11/30/2026"), false);
  });
  it("reads the client IP only through the configured number of proxies", () => {
    const req = { socket: { remoteAddress: "10.0.0.2" }, headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } } as never;
    assert.equal(clientIp(req, 0), "10.0.0.2");
    assert.equal(clientIp(req, 1), "203.0.113.9", "the spoofable left-most entry is ignored");
  });
});
