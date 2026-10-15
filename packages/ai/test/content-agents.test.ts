import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintPost } from "@jat/core";
import { brandFixture } from "../../core/test/fixtures.ts";
import {
  MemoryLedger,
  PlanValidationError,
  assemblePost,
  brandContext,
  combinedRisk,
  postLink,
  runPlanning,
  runPostDraft,
  runPostReview,
  validatePlan,
  type ClaimForPrompt,
  type ClaudeClient,
  type DraftSlot,
  type DraftWire,
  type MessageRequest,
} from "../src/index.ts";


const dna = brandFixture(); // pillars: home-care-tips; personas: new-homeowner
const claims: ClaimForPrompt[] = [
  { id: "c-licensed", text: "Licensed in Massachusetts", category: "credential" },
  { id: "c-offer", text: "10% off furnace tune-ups through Nov 30", category: "offer" },
];
const base = { dna, claims, channels: [{ channel: "facebook" as const, postsPerWeek: 2 }, { channel: "instagram" as const, postsPerWeek: 1 }], startDate: "2026-11-02", days: 30 as const, timezone: "America/New_York" };

const slot = (over: Partial<Record<string, string>> = {}) => ({
  campaign_key: "winter",
  date: "2026-11-03",
  time: "09:30",
  channel: "facebook" as const,
  format: "image" as const,
  pillar_id: "home-care-tips",
  persona_id: "new-homeowner",
  objective: "traffic" as const,
  topic: "Freeze-proof your pipes",
  notes: "",
  offer_claim_id: "",
  ...over,
});
const goodPlan = () => ({
  campaigns: [{ key: "winter", name: "Winter prep", objective: "traffic" as const, description: "Get homes ready for the freeze", starts_on: "2026-11-02", ends_on: "2026-12-01" }],
  slots: [slot(), slot({ date: "2026-11-05", channel: "instagram", format: "carousel" }), slot({ date: "2026-11-10", offer_claim_id: "c-offer", objective: "leads" })],
  assumptions: ["Owner can supply photos"],
  risks: [],
});

describe("planning validation", () => {
  it("accepts a valid plan and converts local times to UTC", () => {
    const { plan, warnings } = validatePlan(goodPlan(), base);
    assert.equal(plan.slots.length, 3);
    assert.equal(plan.slots[0]!.publishAt, "2026-11-03T14:30:00.000Z", "09:30 EST");
    assert.equal(plan.slots[2]!.offerClaimId, "c-offer");
    assert.ok(warnings.some((w) => w.code === "plan.promo_heavy"), "1 of 3 promotional is above 25%");
  });

  const bad: Array<[string, () => ReturnType<typeof goodPlan>, RegExp]> = [
    ["unknown pillar", () => ({ ...goodPlan(), slots: [slot({ pillar_id: "made-up" })] }), /unknown pillar_id/],
    ["unknown persona", () => ({ ...goodPlan(), slots: [slot({ persona_id: "ghost" })] }), /unknown persona_id/],
    ["outside the period", () => ({ ...goodPlan(), slots: [slot({ date: "2026-12-05" })] }), /date must be within/],
    ["format the channel can't publish", () => ({ ...goodPlan(), slots: [slot({ channel: "instagram", format: "text" })] }), /can't publish format/],
    ["invented offer", () => ({ ...goodPlan(), slots: [slot({ offer_claim_id: "c-licensed" })] }), /not a registered offer/],
    ["cadence exceeded", () => ({ ...goodPlan(), slots: [slot(), slot({ date: "2026-11-04" }), slot({ date: "2026-11-06" })] }), /facebook has 3 posts in week 1; the cap is 2/],
    ["bad time", () => ({ ...goodPlan(), slots: [slot({ time: "9am" })] }), /HH:MM/],
  ];
  for (const [name, mk, re] of bad) {
    it(`rejects: ${name}`, () => assert.throws(() => validatePlan(mk(), base), (e: unknown) => e instanceof PlanValidationError && re.test(e.message)));
  }

  it("runPlanning repairs once, then succeeds", async () => {
    const replies = [{ ...goodPlan(), slots: [slot({ pillar_id: "nope" })] }, goodPlan()];
    const reqs: MessageRequest[] = [];
    const client: ClaudeClient = {
      async createMessage(req) {
        reqs.push(structuredClone(req));
        return { id: "m", model: req.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(replies.shift()) }], usage: { input_tokens: 5000, output_tokens: 3000 } };
      },
    };
    const res = await runPlanning({ client, ledger: new MemoryLedger() }, { ...base, tenantId: "t", budgetCents: 1500, goals: "More furnace tune-up bookings" });
    assert.equal(res.plan.slots.length, 3);
    assert.match(String(reqs[1]!.messages.at(-1)!.content), /unknown pillar_id "nope"/);
    assert.match(reqs[0]!.system![1]!.text, /\[c-licensed\] \(credential\) Licensed in Massachusetts/);
  });

  it("refuses to plan without pillars or channels", async () => {
    const noPillars = structuredClone(dna);
    noPillars.strategy.pillars.value = [];
    const client: ClaudeClient = { createMessage: async () => assert.fail("should not call the model") };
    await assert.rejects(runPlanning({ client, ledger: new MemoryLedger() }, { ...base, dna: noPillars, tenantId: "t", budgetCents: 1500, goals: "" }), /pillar/);
    await assert.rejects(runPlanning({ client, ledger: new MemoryLedger() }, { ...base, channels: [], tenantId: "t", budgetCents: 1500, goals: "" }), /channel/);
  });
});

describe("post drafting", () => {
  const ds: DraftSlot = { id: "0f0e0d0c-aaaa-4bbb-8ccc-123456789abc", channel: "facebook", format: "image", pillarId: "home-care-tips", personaId: "new-homeowner", objective: "traffic", publishAt: "2026-11-03T14:30:00.000Z", topic: "Freeze-proof pipes", notes: "", campaignName: "Winter Prep 2026" };
  const wire: DraftWire = {
    hook: "A frozen pipe can flood a basement overnight.",
    body: "Three checks before the first hard freeze: insulate exposed pipes, find your main shut-off, keep the garage door closed.",
    cta: "Book a visit",
    hashtags: ["#WinterReady"],
    creative_brief: { template: "tip-card", headline: "3 freeze-proof checks", supporting_text: "", image_subject: "technician insulating a pipe" },
    alt_text: "Technician wrapping foam insulation around a copper pipe",
    claim_ids_used: [],
    external_sources: [{ title: "bad", url: "javascript:alert(1)" }],
    verification_status: "no_factual_claims",
    expected_kpi: { metric: "link_clicks", target: "20", rationale: "" },
    notes: "",
  };

  it("fills slot fields, adds a UTM link and drops unsafe source URLs", () => {
    const post = assemblePost(wire, ds, "https://acme.example/winter");
    assert.equal(post.channel, "facebook");
    assert.equal(post.publish_window.start, ds.publishAt);
    const u = new URL(post.link!.url);
    assert.equal(u.searchParams.get("utm_source"), "facebook");
    assert.equal(u.searchParams.get("utm_campaign"), "winter-prep-2026");
    assert.equal(u.searchParams.get("utm_content"), "0f0e0d0c");
    assert.deepEqual(post.external_sources, []);
    assert.deepEqual(post.hashtags, ["WinterReady"]);
    assert.deepEqual(lintPost(post, { forbiddenPhrases: [], usableClaimIds: new Set(), brandMaxHashtags: 3 }), []);
  });

  it("no link where links aren't clickable or no website is set", () => {
    assert.equal(postLink({ ...ds, channel: "instagram" }, "https://acme.example"), null);
    assert.equal(postLink(ds, null), null);
    assert.equal(postLink({ ...ds, channel: "google_business_profile" }, "https://acme.example") !== null, true);
  });

  it("runPostDraft uses the real skill and the cached brand context", async () => {
    let req: MessageRequest | undefined;
    const client: ClaudeClient = {
      async createMessage(r) {
        req = r;
        return { id: "m", model: r.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(wire) }], usage: { input_tokens: 3000, output_tokens: 600 } };
      },
    };
    const res = await runPostDraft({ client, ledger: new MemoryLedger() }, { tenantId: "t", budgetCents: 1500, dna, claims, slot: ds, websiteUrl: "https://acme.example", recentHooks: ["Old hook"] });
    assert.equal(res.post.hook, wire.hook);
    assert.equal(req!.model, "claude-sonnet-5-5");
    assert.match(req!.system![0]!.text, /Social Post Drafting/);
    assert.match(String((req!.messages[0]!.content as Array<{ text: string }>)[0]!.text), /Don't reuse or closely paraphrase these recent hooks:\n- Old hook/);
  });

  it("review agent returns structured findings; risk takes the higher class", async () => {
    const review = { findings: [{ code: "claims.unsupported", severity: "warning", span: "flood", explanation: "x", suggested_fix: "y" }], risk_class: "medium", summary: "ok" };
    const client: ClaudeClient = { createMessage: async (r) => ({ id: "m", model: r.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(review) }], usage: { input_tokens: 2000, output_tokens: 200 } }) };
    const post = assemblePost(wire, ds, null);
    const res = await runPostReview({ client, ledger: new MemoryLedger() }, { tenantId: "t", budgetCents: 1500, dna, claims, post, lintFindings: [] });
    assert.equal(res.review.risk_class, "medium");
    assert.equal(combinedRisk("low", "medium"), "medium");
    assert.equal(combinedRisk("high", "low"), "high");
  });

  it("brand context lists only the supplied (verified) claims", () => {
    assert.match(brandContext(dna, []), /make no factual claims/);
  });
});
