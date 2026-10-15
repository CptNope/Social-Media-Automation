import type { BrandDna, Claim, PostDraft, Provenanced } from "../src/index.ts";

const p = <T>(value: T | null, sources: string[] = ["web:/about"], status: Provenanced<T>["status"] = "extracted", extra: Partial<Provenanced<T>> = {}): Provenanced<T> => ({
  value,
  sources,
  confidence: "high",
  status,
  ...extra,
});

export function brandFixture(): BrandDna {
  return {
    schema_version: 1,
    identity: {
      display_name: p("Acme Plumbing"),
      legal_name: p("Acme Plumbing LLC", ["doc:brandbook.pdf#p1"]),
      tagline: p("Warm homes, dry basements", ["doc:brandbook.pdf#p2"]),
      industry: p("Residential plumbing & heating"),
      founded_year: p(null, [], "missing", { confidence: "low" }),
      locations: p([{ label: "Shop", address: "1 Main St, Worcester, MA", service_area: ["Worcester", "Shrewsbury"] }]),
    },
    visual: {
      colors: p([{ name: "Acme Blue", hex: "#1A4C8B", role: "primary" }], ["doc:brandbook.pdf#p5"]),
      typography: p([{ family: "Inter", role: "body", weights: [400, 600] }], ["doc:brandbook.pdf#p6"]),
      logo_rules: p("Clear space equal to the height of the A.", ["doc:brandbook.pdf#p7"]),
      photography_style: p("Real technicians, natural light", ["web:/"], "inferred", { confidence: "medium", confirmed_by: "user-1" }),
      illustration_style: p(null, [], "missing", { confidence: "low" }),
      layout_notes: p(null, [], "missing", { confidence: "low" }),
    },
    voice: {
      personality: p(["friendly", "practical", "trustworthy"], ["web:/"], "inferred", { confidence: "medium", confirmed_by: "user-1" }),
      tone_by_context: p({ educational: "plain and helpful" }, ["doc:brandbook.pdf#p9"]),
      vocabulary_preferred: p(["technician"], ["doc:brandbook.pdf#p9"]),
      vocabulary_avoid: p(["plumber dude"], ["doc:brandbook.pdf#p9"]),
      forbidden_phrases: p(["lowest prices in town", "act now"], ["doc:brandbook.pdf#p10"]),
      preferred_ctas: p(["Book a visit"], ["doc:brandbook.pdf#p10"]),
      reading_level: p(7, ["doc:brandbook.pdf#p9"]),
      emoji_policy: p("sparing", ["doc:brandbook.pdf#p9"]),
      hashtag_policy: p({ max_per_post: 3, branded: ["#AcmeWarmHomes"] }, ["doc:brandbook.pdf#p10"]),
    },
    strategy: {
      pillars: p([{ id: "home-care-tips", name: "Home care tips", description: "Seasonal maintenance advice", proof_claim_ids: [] }], ["note:operator"], "operator"),
      personas: p([{ id: "new-homeowner", name: "New homeowner", description: "First home, unsure what to maintain", goals: [], objections: [], channels: [] }], ["note:operator"], "operator"),
      offerings: p([{ name: "Furnace tune-up", description: "Annual furnace check" }]),
      differentiators: p([]),
      seasonality: p(["Winter freeze prep"], ["note:operator"], "operator"),
      geo_targets: p(["Worcester County, MA"], ["note:operator"], "operator"),
    },
    compliance: {
      industry_restrictions: p([]),
      required_disclosures: p([]),
    },
  };
}

export function claimsFixture(): Claim[] {
  return [
    { id: "c-licensed", text: "Licensed in Massachusetts", category: "credential", status: "verified", verified_by: "user-1", evidence: [{ kind: "license_lookup", reference: "MA license #12345", captured_at: "2026-09-01T00:00:00Z" }] },
    { id: "c-pending", text: "Serving Worcester since 1998", category: "history", status: "pending", evidence: [] },
    { id: "c-expired", text: "Fall special: 10% off", category: "offer", status: "verified", verified_by: "user-1", expires_at: "2026-09-30T00:00:00Z", evidence: [{ kind: "operator_attestation", reference: "promo sheet", captured_at: "2026-09-01T00:00:00Z" }] },
  ];
}

export function postFixture(overrides: Partial<PostDraft> = {}): PostDraft {
  return {
    channel: "facebook",
    format: "image",
    persona_id: "new-homeowner",
    objective: "traffic",
    pillar_id: "home-care-tips",
    hook: "A frozen pipe can turn into a flooded basement overnight.",
    body: "Three quick checks before the first hard freeze: insulate exposed pipes, know where your main shut-off is, and keep garage doors closed.",
    cta: "Book a visit",
    hashtags: [],
    creative_brief: { template: "tip-card", headline: "3 freeze-proof checks", image_subject: "technician wrapping pipe insulation" },
    alt_text: "Technician wrapping foam insulation around a copper pipe in a basement",
    publish_window: { start: "2026-11-02T14:00:00-05:00", end: "2026-11-02T17:00:00-05:00" },
    link: { url: "https://acmeplumbing.example/winter?utm_source=facebook&utm_medium=social&utm_campaign=winter-prep&utm_content=slot-1" },
    expected_kpi: { metric: "link_clicks", target: "20" },
    claim_ids_used: [],
    external_sources: [],
    verification_status: "no_factual_claims",
    disclosure: null,
    ...overrides,
  };
}
