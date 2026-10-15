import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TransitionError,
  approvalRequirement,
  buildUtmUrl,
  canApprove,
  canonicalJson,
  contentHash,
  evaluatePublishGate,
  transition,
  validateTrackedUrl,
  type ContentItemState,
  type PublishGateInput,
} from "../src/index.ts";

const user = { type: "user" as const, id: "u1" };
const agent = { type: "agent" as const, id: "run-1" };

describe("approval policy", () => {
  it("manual mode requires approval for every publish", () => {
    assert.equal(approvalRequirement({ mode: "manual", action: "publish_post", risk: "low", preapprovedPattern: true }).required, true);
  });

  it("assisted mode auto-schedules only pre-approved low-risk patterns, with a veto window", () => {
    const r = approvalRequirement({ mode: "assisted", action: "publish_post", risk: "low", preapprovedPattern: true });
    assert.equal(r.required, false);
    assert.equal(r.vetoWindowHours, 24);
    assert.equal(approvalRequirement({ mode: "assisted", action: "publish_post", risk: "low" }).required, true);
    assert.equal(approvalRequirement({ mode: "assisted", action: "publish_post", risk: "medium", preapprovedPattern: true }).required, true);
  });

  it("autonomous mode falls back to assisted when the tenant is not eligible", () => {
    assert.equal(approvalRequirement({ mode: "autonomous", action: "publish_post", risk: "low", preapprovedPattern: true }).vetoWindowHours, 24);
    assert.equal(approvalRequirement({ mode: "autonomous", autonomousEligible: true, action: "publish_post", risk: "low", preapprovedPattern: true }).vetoWindowHours, 0);
  });

  it("missing risk class is treated as high", () => {
    assert.equal(approvalRequirement({ mode: "autonomous", autonomousEligible: true, action: "publish_post", preapprovedPattern: true }).required, true);
  });

  it("paid ads, financial commitments, deletes and major brand changes always need the owner", () => {
    for (const action of ["paid_ads", "financial_commitment", "irreversible_delete", "major_brand_change"] as const) {
      const r = approvalRequirement({ mode: "autonomous", autonomousEligible: true, action, risk: "low", preapprovedPattern: true });
      assert.equal(r.required, true, action);
      assert.deepEqual(r.approverRoles, ["client_owner"]);
    }
  });

  it("sensitive or regulated claims need the owner in every mode", () => {
    const r = approvalRequirement({ mode: "autonomous", autonomousEligible: true, action: "publish_post", risk: "low", preapprovedPattern: true, sensitiveClaims: true });
    assert.equal(r.required, true);
    assert.deepEqual(r.approverRoles, ["client_owner"]);
    assert.deepEqual(approvalRequirement({ mode: "manual", action: "verify_claim" }).approverRoles, ["client_owner"]);
  });

  it("live website changes require approval; drafts do not", () => {
    assert.equal(approvalRequirement({ mode: "autonomous", autonomousEligible: true, action: "wp_update_seo_live" }).required, true);
    assert.equal(approvalRequirement({ mode: "manual", action: "wp_create_draft" }).required, false);
  });

  it("role checks: editors and platform admins cannot approve client content", () => {
    const r = approvalRequirement({ mode: "manual", action: "publish_post", risk: "low" });
    assert.equal(canApprove("client_owner", r), true);
    assert.equal(canApprove("reviewer", r), true);
    assert.equal(canApprove("client_editor", r), false);
    assert.equal(canApprove("platform_admin", r), false);
  });
});

describe("publish gate", () => {
  const base = (over: Partial<PublishGateInput> = {}): PublishGateInput => ({
    globalPaused: false,
    tenantPaused: false,
    channelPaused: false,
    publishModeEnv: "live",
    tenantPublishingEnabled: true,
    approvalRequired: true,
    approvedHash: "h1",
    currentContentHash: "h1",
    finalLintFindings: [],
    integrationStatus: "connected",
    capabilityPresent: true,
    tokenExpiresAt: null,
    idempotencyKeyUsed: false,
    now: new Date("2026-10-15T12:00:00Z"),
    ...over,
  });

  it("allows a fully valid live publish", () => {
    assert.deepEqual(evaluatePublishGate(base()), { decision: "live", reasons: [] });
  });

  it("defaults to dry run unless env AND tenant enable live publishing", () => {
    assert.equal(evaluatePublishGate(base({ publishModeEnv: "dry_run" })).decision, "dry_run");
    assert.equal(evaluatePublishGate(base({ tenantPublishingEnabled: false })).decision, "dry_run");
  });

  const blocked: Array<[string, Partial<PublishGateInput>]> = [
    ["global pause", { globalPaused: true }],
    ["tenant pause", { tenantPaused: true }],
    ["channel pause", { channelPaused: true }],
    ["missing approval", { approvedHash: null }],
    ["edited after approval", { currentContentHash: "h2" }],
    ["lint blocker", { finalLintFindings: [{ code: "x", severity: "blocker", message: "" }] }],
    ["revoked integration", { integrationStatus: "revoked" }],
    ["missing capability", { capabilityPresent: false }],
    ["expired token", { tokenExpiresAt: new Date("2026-10-15T11:59:00Z") }],
    ["token expiring within 10 minutes", { tokenExpiresAt: new Date("2026-10-15T12:05:00Z") }],
    ["duplicate send", { idempotencyKeyUsed: true }],
  ];
  for (const [name, over] of blocked) {
    it(`blocks: ${name}`, () => assert.equal(evaluatePublishGate(base(over)).decision, "blocked"));
  }

  it("a token with more than 10 minutes left is fine", () => {
    assert.equal(evaluatePublishGate(base({ tokenExpiresAt: new Date("2026-10-15T13:00:00Z") })).decision, "live");
  });

  it("pause blocks even in dry-run", () => {
    assert.equal(evaluatePublishGate(base({ publishModeEnv: "dry_run", globalPaused: true })).decision, "blocked");
  });
});

describe("content state machine", () => {
  const start = (over: Partial<ContentItemState> = {}): ContentItemState => ({ state: "draft", contentHash: "h1", approvedHash: null, pausedFrom: null, ...over });

  it("runs the happy path draft → published with audit events", () => {
    let s = start();
    s = transition(s, { type: "submit", findings: [] }, agent).next;
    const approved = transition(s, { type: "approve", contentHash: "h1" }, user);
    assert.equal(approved.audit.action, "content.approve");
    assert.deepEqual(approved.audit.after, { state: "approved", approvedHash: "h1" });
    s = transition(approved.next, { type: "schedule", at: "2026-11-02T19:00:00Z" }, { type: "system", id: "scheduler" }).next;
    s = transition(s, { type: "start_publish" }, { type: "system", id: "publisher" }).next;
    s = transition(s, { type: "publish_succeeded", externalId: "123_456" }, { type: "system", id: "publisher" }).next;
    assert.equal(s.state, "published");
  });

  it("cannot submit a draft with blockers", () => {
    assert.throws(() => transition(start(), { type: "submit", findings: [{ code: "x", severity: "blocker", message: "" }] }, agent), TransitionError);
  });

  it("agents cannot approve", () => {
    assert.throws(() => transition(start({ state: "in_review" }), { type: "approve", contentHash: "h1" }, agent), /only a human/);
  });

  it("approval must match the current revision", () => {
    assert.throws(() => transition(start({ state: "in_review" }), { type: "approve", contentHash: "stale" }, user), /different revision/);
  });

  it("editing after approval invalidates the approval and returns to draft", () => {
    const { next } = transition(start({ state: "scheduled", approvedHash: "h1" }), { type: "edit", newContentHash: "h2" }, user);
    assert.equal(next.state, "draft");
    assert.equal(next.approvedHash, null);
  });

  it("policy auto-approval is system-only, records the reason, and can be vetoed by a human", () => {
    const review = start({ state: "in_review" });
    assert.throws(() => transition(review, { type: "auto_approve", contentHash: "h1", policyReason: "x", vetoUntil: null }, user), /policy engine/);
    const auto = transition(review, { type: "auto_approve", contentHash: "h1", policyReason: "Assisted: pre-approved pattern", vetoUntil: "2026-11-01T19:00:00Z" }, { type: "system", id: "policy" });
    assert.equal(auto.next.state, "approved");
    assert.equal(auto.audit.detail?.vetoUntil, "2026-11-01T19:00:00Z");
    const scheduled = transition(auto.next, { type: "schedule", at: "2026-11-02T19:00:00Z" }, { type: "system", id: "scheduler" }).next;
    const vetoed = transition(scheduled, { type: "reject", reason: "Not this week" }, user).next;
    assert.equal(vetoed.state, "draft");
    assert.equal(vetoed.approvedHash, null);
  });

  it("export requires an approval of the current content", () => {
    assert.throws(() => transition(start({ state: "approved", approvedHash: "old" }), { type: "mark_exported" }, user), /approval does not match/);
    assert.equal(transition(start({ state: "approved", approvedHash: "h1" }), { type: "mark_exported" }, user).next.state, "exported");
  });

  it("cannot pause an item whose publish call is in flight", () => {
    assert.throws(() => transition(start({ state: "publishing", approvedHash: "h1" }), { type: "pause" }, user), /in flight/);
  });

  it("pause and resume restore the previous state", () => {
    const paused = transition(start({ state: "scheduled", approvedHash: "h1" }), { type: "pause" }, user).next;
    assert.equal(paused.state, "paused");
    assert.equal(transition(paused, { type: "resume" }, user).next.state, "scheduled");
  });

  it("transient failures go back to scheduled; permanent failures to failed", () => {
    const publishing = start({ state: "publishing", approvedHash: "h1" });
    assert.equal(transition(publishing, { type: "publish_failed", error: "429", permanent: false }, agent).next.state, "scheduled");
    assert.equal(transition(publishing, { type: "publish_failed", error: "403", permanent: true }, agent).next.state, "failed");
  });
});

describe("hashing & UTM", () => {
  it("canonical JSON is key-order independent", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, undefined] } }), '{"a":{"c":[3,null],"d":2},"b":1}');
    assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
    assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
    assert.match(contentHash({}), /^[0-9a-f]{64}$/);
  });

  it("builds UTM links, preserving other params and replacing old utm_*", () => {
    const url = buildUtmUrl("https://acme.example/winter?ref=nav&utm_source=old#faq", { source: "Facebook", medium: "social", campaign: "Winter Prep 2026", content: "Slot 7" });
    const u = new URL(url);
    assert.equal(u.searchParams.get("ref"), "nav");
    assert.equal(u.searchParams.get("utm_source"), "facebook");
    assert.equal(u.searchParams.get("utm_campaign"), "winter-prep-2026");
    assert.equal(u.searchParams.get("utm_content"), "slot-7");
    assert.equal(u.hash, "#faq");
    assert.equal(validateTrackedUrl(url).ok, true);
  });

  it("rejects non-http URLs and empty slugs", () => {
    assert.throws(() => buildUtmUrl("javascript:alert(1)", { source: "x", medium: "y", campaign: "z" }));
    assert.throws(() => buildUtmUrl("https://a.example", { source: "!!!", medium: "y", campaign: "z" }));
  });
});
