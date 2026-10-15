import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BrandDnaSchema, activationIssues, brandForbiddenPhrases, isClaimUsable, usableClaimIds } from "../src/index.ts";
import { brandFixture, claimsFixture } from "./fixtures.ts";

describe("Brand DNA", () => {
  it("fixture parses against the schema", () => {
    assert.doesNotThrow(() => BrandDnaSchema.parse(brandFixture()));
  });

  it("rejects non-hex colors", () => {
    const dna = brandFixture();
    dna.visual.colors.value = [{ name: "Bad", hex: "blue", role: "primary" }];
    assert.equal(BrandDnaSchema.safeParse(dna).success, false);
  });

  it("is activatable when every value is sourced or confirmed", () => {
    assert.deepEqual(activationIssues(brandFixture()), []);
  });

  it("blocks unconfirmed inferred values", () => {
    const dna = brandFixture();
    delete dna.voice.personality.confirmed_by;
    const issues = activationIssues(dna);
    assert.ok(issues.some((i) => i.code === "brand.inferred_unconfirmed" && i.field === "voice.personality"));
  });

  it("blocks values with no source and no human confirmation", () => {
    const dna = brandFixture();
    dna.identity.tagline = { value: "Invented tagline", sources: [], confidence: "low", status: "extracted" };
    assert.ok(activationIssues(dna).some((i) => i.code === "brand.unsourced_value" && i.field === "identity.tagline"));
  });

  it("blocks a 'missing' field that carries a value (sneaked-in fact)", () => {
    const dna = brandFixture();
    dna.identity.founded_year = { value: 1998, sources: [], confidence: "low", status: "missing" };
    assert.ok(activationIssues(dna).some((i) => i.code === "brand.missing_has_value"));
  });

  it("flags sources that are not in the evidence set", () => {
    const known = new Set(["web:/about", "web:/", "note:operator"]);
    const issues = activationIssues(brandFixture(), known);
    assert.ok(issues.some((i) => i.code === "brand.unknown_source" && i.message.includes("doc:brandbook.pdf#p1")));
  });

  it("exposes forbidden phrases for the linter", () => {
    assert.deepEqual(brandForbiddenPhrases(brandFixture()), ["lowest prices in town", "act now"]);
  });
});

describe("Claim registry", () => {
  const now = new Date("2026-10-15T12:00:00Z");

  it("only verified, evidenced, unexpired claims are usable", () => {
    assert.deepEqual([...usableClaimIds(claimsFixture(), now)], ["c-licensed"]);
  });

  it("expired claims are not usable", () => {
    const expired = claimsFixture().find((c) => c.id === "c-expired")!;
    assert.equal(isClaimUsable(expired, new Date("2026-09-15T00:00:00Z")), true);
    assert.equal(isClaimUsable(expired, now), false);
  });

  it("testimonials require recorded customer consent", () => {
    const t = { id: "t1", text: "They fixed it in an hour — Jane D.", category: "testimonial" as const, status: "verified" as const, verified_by: "u1", evidence: [{ kind: "document" as const, reference: "review screenshot", captured_at: "2026-09-01T00:00:00Z" }] };
    assert.equal(isClaimUsable(t, now), false);
    assert.equal(isClaimUsable({ ...t, evidence: [...t.evidence, { kind: "customer_consent" as const, reference: "signed form", captured_at: "2026-09-02T00:00:00Z" }] }, now), true);
  });
});
