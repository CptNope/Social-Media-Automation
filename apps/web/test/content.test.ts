import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { runPlanning, runPostDraft, runPostReview } from "@jat/ai";
import { DEFAULT_TIMEZONE, addDays, localDate } from "@jat/core";
import { DbSpendLedger } from "@jat/db";
import { PsqlDatabase } from "@jat/db/testing/psql-client";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "../../../packages/db/test/pg-harness.ts";
import { brandFixture } from "../../../packages/core/test/fixtures.ts";
import { createApp, type Mailer } from "../src/app.ts";
import { InProcessJobs } from "../src/jobs.ts";
import { sampleClaude } from "../src/sample-ai.ts";

const bin = findPgBin();
const T = "11111111-1111-4111-8111-111111111111";
const BRAND = "b1111111-1111-4111-8111-111111111111";
const DNA = "d1111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EDITOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REVIEWER = "ffffffff-ffff-4fff-8fff-ffffffffffff";

class MemoryMailer implements Mailer {
  sent: Array<{ email: string; url: string }> = [];
  async sendLoginLink(email: string, url: string) {
    this.sent.push({ email, url });
  }
}

class Browser {
  cookie = "";
  constructor(private readonly base: string) {}
  async get(path: string) {
    const res = await fetch(this.base + path, { headers: this.cookie ? { cookie: this.cookie } : {}, redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), headers: res.headers, body: await res.text() };
  }
  async post(path: string, fields: Record<string, string | string[]>, csrfFrom?: string) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) form.append(k, x);
    const m = csrfFrom ? /name="_csrf" value="([^"]+)"/.exec(csrfFrom) : null;
    if (m) form.set("_csrf", m[1]!);
    const res = await fetch(this.base + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: this.base, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: form.toString(), redirect: "manual" });
    this.#store(res);
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  }
  #store(res: Response) {
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
  }
}

const attr = (html: string, re: RegExp): string => {
  const m = re.exec(html);
  assert.ok(m, `pattern not found: ${re}`);
  return m[1]!;
};

describe("planning, drafting, approvals and export (real Postgres)", { skip: bin ? false : "Postgres binaries not found" }, () => {
  let pg: TempPg;
  let db: PsqlDatabase;
  let server: Server;
  let base: string;
  const mailer = new MemoryMailer();
  const jobs = new InProcessJobs(1);
  const errors: unknown[] = [];

  async function signIn(email: string): Promise<Browser> {
    const b = new Browser(base);
    await b.post("/login", { email });
    await jobs.idle();
    const link = new URL(mailer.sent.at(-1)!.url);
    assert.equal(mailer.sent.at(-1)!.email, email);
    const r = await b.post("/login/verify", { token: link.searchParams.get("token")! });
    assert.equal(r.status, 303);
    return b;
  }

  before(async () => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    const dna = JSON.stringify(brandFixture()).replace(/'/g, "''");
    pg.admin(`
      INSERT INTO tenants (id, name, slug) VALUES ('${T}', 'Acme Plumbing', 'acme');
      INSERT INTO users (id, email, name) VALUES ('${OWNER}', 'owner@acme.example', 'Olive'), ('${OP}', 'ops@jat.example', 'Oscar'), ('${EDITOR}', 'editor@acme.example', 'Edie'), ('${REVIEWER}', 'reviewer@acme.example', 'Rae');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${T}', '${OWNER}', 'client_owner'), ('${T}', '${OP}', 'agency_operator'), ('${T}', '${EDITOR}', 'client_editor'), ('${T}', '${REVIEWER}', 'reviewer');
      INSERT INTO brands (id, tenant_id, name) VALUES ('${BRAND}', '${T}', 'Acme');
      INSERT INTO brand_dna_versions (id, tenant_id, brand_id, version, status, data, created_by, approved_by, approved_at) VALUES ('${DNA}', '${T}', '${BRAND}', 1, 'active', '${dna}', 'test', '${OWNER}', now());
      UPDATE brands SET active_dna_version_id = '${DNA}' WHERE id = '${BRAND}';
      INSERT INTO claims (tenant_id, brand_id, text, category, status, evidence, verified_by) VALUES ('${T}', '${BRAND}', 'Licensed in Massachusetts', 'credential', 'verified', '[{"kind":"license_lookup","reference":"#123","captured_at":"2026-10-01T00:00:00Z"}]', '${OWNER}');`);
    db = new PsqlDatabase(pg.conn);
    const ledger = new DbSpendLedger(db);
    const claude = sampleClaude({});
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const handler = createApp({
      db,
      sessionSecret: randomBytes(32),
      baseUrl: base,
      mailer,
      jobs,
      log: (m, e) => {
        errors.push(e);
        if (process.env.DEBUG_WEB) console.error(m, e);
      },
      onboarding: { crawl: async () => assert.fail("not used"), extract: null },
      contentAi: {
        plan: (r) => runPlanning({ client: claude, ledger }, r),
        draft: (r) => runPostDraft({ client: claude, ledger }, r),
        review: (r) => runPostReview({ client: claude, ledger }, r),
      },
    });
    server.on("request", (req, res) => void handler(req, res));
  });

  after(async () => {
    await new Promise((r) => server?.close(r));
    await db?.close();
    pg?.stop();
  });

  it("plans, drafts, approves, edits, exports — with every rule enforced", async () => {
    const op = await signIn("ops@jat.example");
    const owner = await signIn("owner@acme.example");
    const editor = await signIn("editor@acme.example");
    const reviewer = await signIn("reviewer@acme.example");

    // Channels + website
    let plan = await op.get(`/w/${T}/plan`);
    assert.equal(plan.status, 200);
    assert.match(plan.body, /Turn on at least one channel first/);
    let r = await op.post(`/w/${T}/plan/channels`, { website_url: "https://acme.example/", on_facebook: "on", ppw_facebook: "2", on_instagram: "on", ppw_instagram: "1", ppw_linkedin: "3" }, plan.body);
    assert.equal(r.location, `/w/${T}/plan?m=channels_saved`);
    plan = await op.get(`/w/${T}/plan`);
    assert.match(plan.body, /Draft a plan/);

    // Editors can't plan.
    assert.equal((await editor.post(`/w/${T}/plan/generate`, { start_date: "2030-01-07", days: "30" }, (await editor.get(`/w/${T}/plan`)).body)).status, 403);
    // Past start dates are refused.
    assert.equal((await op.post(`/w/${T}/plan/generate`, { start_date: "2020-01-06", days: "30" }, plan.body)).status, 400);

    // A job stranded by a restart (no heartbeat for 15+ minutes) doesn't block new work.
    pg.admin(`INSERT INTO work_runs (tenant_id, brand_id, kind, status, started_by, updated_at) VALUES ('${T}', '${BRAND}', 'plan', 'running', '${OP}', now() - interval '20 minutes')`);
    const start = addDays(localDate(new Date(), DEFAULT_TIMEZONE), 7);
    r = await op.post(`/w/${T}/plan/generate`, { start_date: start, days: "30", goals: "Book furnace tune-ups" }, plan.body);
    assert.equal(r.status, 303);
    await jobs.idle();
    const run = await op.get(r.location!);
    assert.match(run.body, /posts planned/, run.body.slice(0, 2000));
    const campaignPath = attr(run.body, /href="(\/w\/[^"]+\/campaigns\/[0-9a-f-]{36})"/);

    let campaign = await op.get(campaignPath);
    assert.match(campaign.body, /Proposed/);
    const slotCount = (campaign.body.match(/id="slot-/g) ?? []).length;
    assert.ok(slotCount >= 8, `${slotCount} slots`);
    assert.doesNotMatch(campaign.body, /linkedin/i, "disabled channels are never planned");

    // Drafting is refused until the plan is approved.
    assert.equal((await op.post(`${campaignPath}/draft`, {}, campaign.body)).status, 400);

    // Move one slot and remove another before approval.
    const slotIds = [...campaign.body.matchAll(/id="slot-([0-9a-f-]{36})"/g)].map((m) => m[1]!);
    r = await op.post(`/w/${T}/slots/${slotIds[0]}/move`, { date: start, time: "16:45", topic: "Moved: freeze-proof checklist" }, campaign.body);
    assert.match(r.location!, /m=slot_saved/);
    r = await op.post(`/w/${T}/slots/${slotIds[1]}/cancel`, {}, campaign.body);
    assert.match(r.location!, /m=slot_removed/);
    assert.equal((await op.post(`/w/${T}/slots/${slotIds[2]}/move`, { date: "2026-02-31", time: "10:00", topic: "x" }, campaign.body)).status, 400);
    assert.equal((await op.post(`/w/${T}/slots/${slotIds[2]}/move`, { date: "2020-01-06", time: "10:00", topic: "x" }, campaign.body)).status, 400, "no moving into the past");

    r = await op.post(`${campaignPath}/approve`, {}, campaign.body);
    campaign = await op.get(r.location!);
    assert.match(campaign.body, /Plan approved/);
    assert.match(campaign.body, /Moved: freeze-proof checklist/);

    // Calendar shows the moved post in the start month.
    const cal = await op.get(`/w/${T}/plan?month=${start.slice(0, 7)}`);
    assert.match(cal.body, /4:45 PM Facebook/);

    // Draft all posts.
    r = await op.post(`${campaignPath}/draft`, {}, campaign.body);
    await jobs.idle();
    const draftRun = await op.get(r.location!);
    assert.match(draftRun.body, new RegExp(`${slotCount - 1} drafted`), draftRun.body.slice(0, 3000));

    // Approvals: reviewer batch-approves everything except high risk.
    let approvals = await reviewer.get(`/w/${T}/approvals`);
    const picks = [...approvals.body.matchAll(/name="item" value="([^"]+)"/g)].map((m) => m[1]!);
    assert.equal(picks.length, slotCount - 1);
    // Make one post high risk behind the scenes: batch must skip it.
    const [highId] = picks[0]!.split(":");
    pg.admin(`UPDATE content_items SET risk_class = 'high' WHERE id = '${highId}'`);
    // A tampered fingerprint is skipped too.
    const tampered = picks[1]!.replace(/:.+$/, ":" + "0".repeat(64));
    r = await reviewer.post(`/w/${T}/approvals/batch`, { item: [picks[0]!, tampered, ...picks.slice(2)] }, approvals.body);
    approvals = await reviewer.get(r.location!);
    assert.match(approvals.body, new RegExp(`${picks.length - 2} approved. 2 skipped`));
    assert.match(approvals.body, /High risk/);
    assert.doesNotMatch(approvals.body, new RegExp(`value="${highId}:`), "high-risk posts have no batch checkbox");

    // Editors can't approve; reviewers can't edit.
    const pendingId = picks[1]!.split(":")[0]!;
    let item = await editor.get(`/w/${T}/content/${pendingId}`);
    assert.doesNotMatch(item.body, />Approve</);
    assert.equal((await editor.post(`/w/${T}/content/${pendingId}/approve`, { fingerprint: picks[1]!.split(":")[1]! }, item.body)).status, 403);
    item = await reviewer.get(`/w/${T}/content/${pendingId}`);
    assert.equal((await reviewer.post(`/w/${T}/content/${pendingId}/edit`, { hook: "x", base_hash: "y" }, item.body)).status, 403);

    // Editing an approved post creates a new version, drops the approval and re-runs the checks.
    const approvedId = picks[2]!.split(":")[0]!;
    item = await editor.get(`/w/${T}/content/${approvedId}`);
    assert.match(item.body, /Approved/);
    const baseHash = attr(item.body, /name="base_hash" value="([0-9a-f]{64})"/);
    r = await editor.post(`/w/${T}/content/${approvedId}/edit`, { base_hash: baseHash, hook: "=HYPERLINK(\"http://evil\") Act now before the freeze", body: "Insulate exposed pipes.", cta: "Book a visit", hashtags: "", alt_text: "Technician insulating a pipe" }, item.body);
    item = await editor.get(r.location!);
    assert.match(item.body, /Saved as a new version/);
    assert.match(item.body, /Draft/);
    assert.match(item.body, /Must fix/, "forbidden phrase 'act now' is a blocker");
    assert.match(item.body, /Send for approval<\/button>/);
    assert.match(item.body, /<button type="submit" disabled>Send for approval/);
    assert.match((await editor.post(`/w/${T}/content/${approvedId}/submit`, {}, item.body)).location!, /m=blocked/);
    // A stale edit (old base hash) is refused.
    assert.match((await editor.post(`/w/${T}/content/${approvedId}/edit`, { base_hash: baseHash, hook: "Other", body: "", cta: "", hashtags: "" }, item.body)).location!, /m=stale/);

    // Fix it, submit, approve with the fresh fingerprint.
    const hash2 = attr(item.body, /name="base_hash" value="([0-9a-f]{64})"/);
    r = await editor.post(`/w/${T}/content/${approvedId}/edit`, { base_hash: hash2, hook: "=HYPERLINK(\"http://evil\") Beat the freeze", body: "Insulate exposed pipes.", cta: "Book a visit", hashtags: "", alt_text: "Technician insulating a pipe" }, item.body);
    item = await editor.get(r.location!);
    assert.doesNotMatch(item.body, /Must fix/);
    r = await editor.post(`/w/${T}/content/${approvedId}/submit`, {}, item.body);
    assert.match(r.location!, /m=submitted/);
    item = await owner.get(`/w/${T}/content/${approvedId}`);
    const fp = attr(item.body, /name="fingerprint" value="([0-9a-f]{64})"/);
    assert.match((await owner.post(`/w/${T}/content/${approvedId}/approve`, { fingerprint: "f".repeat(64) }, item.body)).location!, /m=stale/);
    assert.match((await owner.post(`/w/${T}/content/${approvedId}/approve`, { fingerprint: fp }, item.body)).location!, /m=approved/);

    // Request changes sends a post back to draft with the comment recorded.
    item = await owner.get(`/w/${T}/content/${pendingId}`);
    r = await owner.post(`/w/${T}/content/${pendingId}/changes`, { comment: "Mention the Shrewsbury area" }, item.body);
    item = await owner.get(r.location!);
    assert.match(item.body, /Mention the Shrewsbury area/);
    assert.match(item.body, />Draft</);

    // CSV export: approved posts only, formulas neutralized.
    const csv = await op.get(`/w/${T}/export.csv`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(csv.body, /"'=HYPERLINK\(""http:\/\/evil""\) Beat the freeze/, "formula cell is prefixed with a quote");
    assert.doesNotMatch(csv.body, new RegExp(pendingId), "posts sent back aren't exported");
    assert.match(csv.body, /utm_source=facebook/);

    // An AI blocker survives a human edit until the AI re-checks the new version.
    const aiId = picks[3]!.split(":")[0]!;
    item = await editor.get(`/w/${T}/content/${aiId}`);
    r = await editor.post(`/w/${T}/content/${aiId}/edit`, { base_hash: attr(item.body, /name="base_hash" value="([0-9a-f]{64})"/), hook: "Our work is guaranteed for life", body: "Call us.", cta: "Book a visit", hashtags: "", alt_text: "Technician" }, item.body);
    item = await editor.get(r.location!);
    r = await editor.post(`/w/${T}/content/${aiId}/recheck`, {}, item.body);
    await jobs.idle();
    item = await editor.get(`/w/${T}/content/${aiId}`);
    assert.match(item.body, /A guarantee is a factual promise/);
    assert.match(item.body, /High risk/);
    r = await editor.post(`/w/${T}/content/${aiId}/edit`, { base_hash: attr(item.body, /name="base_hash" value="([0-9a-f]{64})"/), hook: "Our work, explained", body: "Call us.", cta: "Book a visit", hashtags: "", alt_text: "Technician" }, item.body);
    item = await editor.get(r.location!);
    assert.match(item.body, /A guarantee is a factual promise[^<]*\(earlier version\)/, "AI blocker carried over the human edit");
    assert.match(item.body, /High risk/, "a human edit never lowers the AI reviewer's risk");
    assert.match((await editor.post(`/w/${T}/content/${aiId}/submit`, {}, item.body)).location!, /m=blocked/);
    await editor.post(`/w/${T}/content/${aiId}/recheck`, {}, item.body);
    await jobs.idle();
    item = await editor.get(`/w/${T}/content/${aiId}`);
    assert.doesNotMatch(item.body, /guarantee is a factual promise/);
    assert.match((await editor.post(`/w/${T}/content/${aiId}/submit`, {}, item.body)).location!, /m=submitted/);

    // Posts that use a testimonial claim can only be approved by the owner.
    const tId = pg.admin(`INSERT INTO claims (tenant_id, brand_id, text, category, status, evidence, verified_by) VALUES ('${T}', '${BRAND}', 'They fixed it in an hour - Jane D.', 'testimonial', 'verified', '[{"kind":"customer_consent","reference":"form","captured_at":"2026-10-01T00:00:00Z"}]', '${OWNER}') RETURNING id`).split("\n")[0]!;
    pg.admin(`WITH cur AS (SELECT r.* FROM content_items ci JOIN content_revisions r ON r.id = ci.current_revision_id WHERE ci.id = '${aiId}'),
      nr AS (INSERT INTO content_revisions (tenant_id, content_item_id, revision, body, content_hash, findings, created_by)
        SELECT tenant_id, content_item_id, revision + 1, jsonb_set(body, '{claim_ids_used}', jsonb_build_array('${tId}')), repeat('7', 64), '[]', 'test' FROM cur RETURNING id)
      UPDATE content_items SET current_revision_id = (SELECT id FROM nr) WHERE id = '${aiId}'`);
    item = await reviewer.get(`/w/${T}/content/${aiId}`);
    assert.doesNotMatch(item.body, />Approve</);
    assert.match(item.body, /Waiting for the owner/);
    assert.equal((await reviewer.post(`/w/${T}/content/${aiId}/approve`, { fingerprint: "7".repeat(64) }, item.body)).status, 403);

    // Mark as posted.
    item = await op.get(`/w/${T}/content/${approvedId}`);
    r = await op.post(`/w/${T}/content/${approvedId}/exported`, {}, item.body);
    assert.match(r.location!, /m=exported/);

    // Audit trail covers the flow.
    const audit = pg.admin(`SELECT string_agg(DISTINCT action, ',' ORDER BY action) FROM audit_log`);
    for (const a of ["plan.created", "plan.approved", "content.drafted", "content.approve", "content.edited", "content.submit", "content.request_changes", "content.mark_exported", "slot.updated", "slot.cancelled"]) assert.ok(audit.includes(a), `audit has ${a}`);
    // Approvals are bound to exact versions.
    assert.equal(pg.admin(`SELECT count(*) FROM approvals a JOIN content_revisions r ON r.id = a.revision_id WHERE a.content_hash <> r.content_hash`), "0");
    // AI spend was recorded per call.
    assert.ok(Number(pg.admin(`SELECT count(*) FROM agent_runs WHERE agent IN ('campaign-planning','social-post-drafting','compliance-review')`)) >= 1 + 2 * (slotCount - 1));
    assert.match(pg.admin(`SELECT error FROM work_runs WHERE updated_at < now() - interval '19 minutes'`), /Interrupted/);
    assert.deepEqual(errors, []);
  });
});
