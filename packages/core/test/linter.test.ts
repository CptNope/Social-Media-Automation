import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PostDraftSchema, composeCaption, xWeightedLength, deriveRiskClass, findPhrase, lintPost, trigramSimilarity, type LintContext } from "../src/index.ts";
import { postFixture } from "./fixtures.ts";

const ctx = (over: Partial<LintContext> = {}): LintContext => ({
  forbiddenPhrases: ["lowest prices in town", "act now"],
  usableClaimIds: new Set(["c-licensed"]),
  brandMaxHashtags: 3,
  ...over,
});
const codes = (post = postFixture(), c = ctx()) => lintPost(post, c).map((f) => `${f.severity}:${f.code}`);

describe("lintPost", () => {
  it("clean fixture passes schema and lint with no findings", () => {
    assert.doesNotThrow(() => PostDraftSchema.parse(postFixture()));
    assert.deepEqual(lintPost(postFixture(), ctx()), []);
    assert.equal(deriveRiskClass(postFixture(), []), "low");
  });

  it("blocks forbidden brand phrases case-insensitively", () => {
    const f = lintPost(postFixture({ cta: "ACT NOW and book a visit" }), ctx());
    assert.ok(f.some((x) => x.code === "brand.forbidden_phrase" && x.severity === "blocker" && x.span === "ACT NOW"));
  });

  it("does not match forbidden phrases inside other words", () => {
    assert.equal(findPhrase("We react nowhere", "act now"), undefined);
  });

  it("blocks unregistered or unverified claims", () => {
    assert.ok(codes(postFixture({ claim_ids_used: ["c-pending"] })).includes("blocker:claims.unregistered"));
    assert.ok(!codes(postFixture({ claim_ids_used: ["c-licensed"] })).includes("blocker:claims.unregistered"));
  });

  it("warns on superlatives when no claim backs them", () => {
    assert.ok(codes(postFixture({ hook: "The best furnace tune-up in Worcester." })).includes("warning:claims.unsupported_superlative"));
  });

  it("requires alt text and a creative brief for visual posts", () => {
    const c = codes(postFixture({ alt_text: "  ", creative_brief: null }));
    assert.ok(c.includes("blocker:a11y.alt_text_missing"));
    assert.ok(c.includes("blocker:creative.brief_missing"));
  });

  it("enforces platform length limits (Bluesky counts graphemes)", () => {
    const longBody = "👍🏽".repeat(290); // 290 graphemes, 1160 UTF-16 units
    const post = postFixture({ channel: "bluesky", format: "text", hook: "Hi", body: longBody, cta: "", link: null });
    assert.ok(!codes(post).includes("blocker:length.exceeded"), "290 graphemes + hook fits in 300");
    const tooLong = postFixture({ channel: "bluesky", format: "text", hook: "Hi", body: "a".repeat(300), cta: "", link: null });
    assert.ok(codes(tooLong).includes("blocker:length.exceeded"));
  });

  it("blocks formats a channel cannot publish", () => {
    assert.ok(codes(postFixture({ channel: "linkedin", format: "carousel" })).includes("blocker:format.unsupported"));
  });

  it("applies brand hashtag policy (warning) and platform caps (blocker)", () => {
    assert.ok(codes(postFixture({ hashtags: ["a", "b", "c", "d"] })).includes("warning:hashtags.too_many"));
    assert.ok(codes(postFixture({ channel: "google_business_profile", format: "text", hashtags: ["local"] })).includes("blocker:hashtags.too_many"));
  });

  it("requires a disclosure when the brief marks sponsored content", () => {
    assert.ok(codes(postFixture(), ctx({ requiresDisclosure: true })).includes("blocker:compliance.disclosure_missing"));
    const disclosed = postFixture({ disclosure: { type: "sponsored", text: "#ad Paid partnership with Acme Supply" } });
    assert.ok(!codes(disclosed, ctx({ requiresDisclosure: true })).includes("blocker:compliance.disclosure_missing"));
    assert.ok(composeCaption(disclosed).startsWith("#ad Paid partnership"), "disclosure is first");
    assert.equal(deriveRiskClass(disclosed, []), "high");
  });

  it("validates tracked links", () => {
    const c = codes(postFixture({ link: { url: "http://acmeplumbing.example/winter" } }));
    assert.ok(c.includes("blocker:links.utm_invalid"));
  });

  it("warns about raw links in Instagram captions", () => {
    const c = codes(postFixture({ channel: "instagram", body: "Details at https://acmeplumbing.example/winter" }));
    assert.ok(c.includes("warning:links.not_clickable"));
  });

  it("flags engagement bait", () => {
    assert.ok(codes(postFixture({ cta: "Comment YES if you want the checklist" })).includes("warning:quality.engagement_bait"));
    assert.ok(codes(postFixture({ cta: "Tag a friend who just bought a house" })).includes("warning:quality.engagement_bait"));
  });

  it("flags hooks that repeat recent ones", () => {
    const c = codes(postFixture(), ctx({ recentHooks: ["A frozen pipe can turn into a flooded basement overnight!"] }));
    assert.ok(c.includes("warning:quality.repeated_hook"));
    assert.ok(trigramSimilarity("totally different words here", "a frozen pipe can burst") < 0.2);
  });

  it("derives risk: warnings or offers → medium; blockers → high", () => {
    const offer = postFixture({ body: "Get 15% off a furnace tune-up this week." });
    assert.equal(deriveRiskClass(offer, lintPost(offer, ctx())), "medium");
    assert.equal(deriveRiskClass(postFixture(), [{ code: "x", severity: "blocker", message: "" }]), "high");
    assert.equal(deriveRiskClass(postFixture(), [], { industryRestricted: true }), "high");
  });
});

describe("X weighted length (docs.x.com counting characters)", () => {
  it("counts URLs as 23, emoji and CJK as 2, Latin as 1", () => {
    assert.equal(xWeightedLength("hello"), 5);
    assert.equal(xWeightedLength("see https://example.com/a/very/long/path?utm_source=x&utm_medium=social"), 4 + 23);
    assert.equal(xWeightedLength("👍🏽"), 2, "emoji with a skin-tone modifier is one emoji");
    assert.equal(xWeightedLength("👨‍👩‍👧"), 2, "ZWJ sequence counts once");
    assert.equal(xWeightedLength("日本語"), 6);
    assert.equal(xWeightedLength("é"), 1, "NFC-normalized");
    assert.equal(xWeightedLength("visit example.com today"), 6 + 23 + 6, "bare domains count as links");
    assert.equal(xWeightedLength("(https://a.co/x)."), 1 + 23 + 2, "trailing punctuation isn't part of the URL");
    assert.equal(xWeightedLength("see https://en.wikipedia.org/wiki/Pipe_(fluid)"), 4 + 23, "balanced parentheses stay in the URL");
    assert.equal(xWeightedLength("v1.2 and e.g. ok"), 16, "version numbers and abbreviations aren't domains");
  });

  it("the X linter counts the link that travels inside the text", () => {
    const link = { url: "https://acme.example/?utm_source=x&utm_medium=social&utm_campaign=w" };
    const x = (hook: string) => lintPost(postFixture({ channel: "x", format: "text", creative_brief: null, alt_text: null, hook, body: "", cta: "", link }), { forbiddenPhrases: [], usableClaimIds: new Set(), recentHooks: [] });
    assert.ok(!x("a".repeat(255)).some((f) => f.code === "length.exceeded"), "255 + 2 + 23 = 280 fits");
    const over = x("a".repeat(256)).find((f) => f.code === "length.exceeded");
    assert.ok(over, "256 + 2 + 23 = 281 doesn't");
    assert.match(over!.message, /Text with link is 281 characters/);
  });
});
