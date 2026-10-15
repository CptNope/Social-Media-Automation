import { z } from "zod/v4";
import {
  PLATFORM_LIMITS,
  PostDraftSchema,
  RISK_CLASSES,
  buildUtmUrl,
  composeCaption,
  utmSlug,
  type BrandDna,
  type Channel,
  type Finding,
  type Objective,
  type PostDraft,
  type RiskClass,
} from "@jat/core";
import { runStructured, type StructuredDeps } from "../structured.ts";
import { loadSkill, skillInstructions, REPO_SKILLS_ROOT } from "../skills.ts";
import { brandContext, type ClaimForPrompt } from "./context.ts";

// ---------------------------------------------------------------------------
// Social Content agent
// ---------------------------------------------------------------------------
export interface DraftSlot {
  id: string;
  channel: Channel;
  format: PostDraft["format"];
  pillarId: string;
  personaId: string;
  objective: Objective;
  publishAt: string;
  topic: string;
  notes: string;
  campaignName: string;
  offerClaimId?: string | null;
}

export interface DraftRequest {
  tenantId: string;
  budgetCents: number;
  dna: BrandDna;
  claims: readonly ClaimForPrompt[];
  slot: DraftSlot;
  websiteUrl: string | null;
  recentHooks: readonly string[];
  model?: string;
  instructions?: string;
}

/** What the model writes. Everything about where/when/who comes from the slot, not the model. */
export const DraftWireSchema = z.object({
  hook: z.string(),
  body: z.string(),
  cta: z.string(),
  hashtags: z.array(z.string()),
  creative_brief: z
    .object({ template: z.string(), headline: z.string(), supporting_text: z.string(), image_subject: z.string() })
    .nullable()
    .describe("null for text-only posts"),
  alt_text: z.string().nullable().describe("null for text-only posts"),
  claim_ids_used: z.array(z.string()),
  external_sources: z.array(z.object({ title: z.string(), url: z.string() })),
  verification_status: z.enum(["verified", "needs_verification", "no_factual_claims"]),
  expected_kpi: z.object({ metric: z.string(), target: z.string(), rationale: z.string() }),
  notes: z.string(),
});
export type DraftWire = z.infer<typeof DraftWireSchema>;

export function postLink(slot: DraftSlot, websiteUrl: string | null): { url: string } | null {
  if (!websiteUrl || !PLATFORM_LIMITS[slot.channel].linksClickable) return null;
  return {
    url: buildUtmUrl(websiteUrl, {
      source: slot.channel === "google_business_profile" ? "google" : slot.channel,
      medium: slot.channel === "google_business_profile" ? "organic_local" : "social",
      campaign: utmSlug(slot.campaignName) || "campaign",
      content: slot.id.slice(0, 8),
    }),
  };
}

export function assemblePost(wire: DraftWire, slot: DraftSlot, websiteUrl: string | null): PostDraft {
  const start = new Date(slot.publishAt);
  const end = new Date(start.getTime() + 3 * 3_600_000);
  const brief = wire.creative_brief;
  return PostDraftSchema.parse({
    channel: slot.channel,
    format: slot.format,
    persona_id: slot.personaId,
    objective: slot.objective,
    pillar_id: slot.pillarId,
    hook: wire.hook.trim(),
    body: wire.body.trim(),
    cta: wire.cta.trim(),
    hashtags: wire.hashtags.map((h) => h.trim().replace(/^#/, "")).filter(Boolean),
    creative_brief: brief
      ? { template: brief.template || "standard", headline: brief.headline.slice(0, 80), ...(brief.supporting_text ? { supporting_text: brief.supporting_text } : {}), ...(brief.image_subject ? { image_subject: brief.image_subject } : {}) }
      : null,
    alt_text: wire.alt_text?.trim() || null,
    publish_window: { start: start.toISOString(), end: end.toISOString() },
    link: postLink(slot, websiteUrl),
    expected_kpi: { metric: wire.expected_kpi.metric || "engagement", ...(wire.expected_kpi.target ? { target: wire.expected_kpi.target } : {}), ...(wire.expected_kpi.rationale ? { rationale: wire.expected_kpi.rationale } : {}) },
    claim_ids_used: [...new Set(wire.claim_ids_used)],
    external_sources: wire.external_sources.filter((s) => /^https?:\/\//.test(s.url)),
    verification_status: wire.verification_status,
    disclosure: null,
    ...(wire.notes ? { notes: wire.notes } : {}),
  });
}

export async function runPostDraft(deps: StructuredDeps, req: DraftRequest): Promise<{ post: PostDraft; costMicros: number }> {
  const instructions = req.instructions ?? skillInstructions(await loadSkill(REPO_SKILLS_ROOT, "social-post-drafting"));
  const s = req.slot;
  const limits = PLATFORM_LIMITS[s.channel];
  const res = await runStructured(deps, {
    agent: "social-post-drafting",
    tenantId: req.tenantId,
    budgetCents: req.budgetCents,
    model: req.model ?? "claude-sonnet-5-5",
    maxTokens: 4_000,
    instructions,
    stableContext: brandContext(req.dna, req.claims),
    userContent: [
      `Write one ${s.channel} post (format: ${s.format}) for the campaign "${s.campaignName}".`,
      `Topic: ${s.topic || "(choose one that fits the pillar)"}`,
      `Pillar: ${s.pillarId}. Persona: ${s.personaId}. Objective: ${s.objective}.`,
      s.notes ? `Planner notes: ${s.notes}` : "",
      s.offerClaimId ? `This is a promotional slot for registered offer claim ${s.offerClaimId}; cite it in claim_ids_used.` : "This is not a promotional post: no offers, prices or discounts.",
      `The full caption (hook + body + CTA + hashtags) must stay under ${Math.min(limits.maxChars, 2200)} ${limits.countBy}.`,
      limits.linksClickable ? "A tracked link is added automatically; don't paste URLs into the text." : `Links aren't clickable on ${s.channel}; don't paste URLs. Point people to the profile link instead.`,
      req.recentHooks.length ? `Don't reuse or closely paraphrase these recent hooks:\n${req.recentHooks.slice(0, 30).map((h) => `- ${h}`).join("\n")}` : "",
      "Return only the fields in the schema. Channel, format, persona, pillar, objective, timing and link are fixed by the plan.",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: PostDraftSchema,
    wire: { schema: DraftWireSchema, fromWire: (w) => assemblePost(w as DraftWire, s, req.websiteUrl) },
  });
  return { post: res.output, costMicros: res.costMicros };
}

// ---------------------------------------------------------------------------
// Compliance & QA agent
// ---------------------------------------------------------------------------
export const ReviewSchema = z.object({
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["blocker", "warning", "info"]),
      span: z.string().describe("Exact text the finding refers to, or empty"),
      explanation: z.string(),
      suggested_fix: z.string(),
    }),
  ),
  risk_class: z.enum(RISK_CLASSES),
  summary: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

export interface ReviewRequest {
  tenantId: string;
  budgetCents: number;
  dna: BrandDna;
  claims: readonly ClaimForPrompt[];
  post: PostDraft;
  lintFindings: readonly Finding[];
  model?: string;
  instructions?: string;
}

export async function runPostReview(deps: StructuredDeps, req: ReviewRequest): Promise<{ review: Review; costMicros: number }> {
  const instructions = req.instructions ?? skillInstructions(await loadSkill(REPO_SKILLS_ROOT, "compliance-review"));
  const res = await runStructured(deps, {
    agent: "compliance-review",
    tenantId: req.tenantId,
    budgetCents: req.budgetCents,
    model: req.model ?? "claude-haiku-5-5",
    maxTokens: 3_000,
    instructions,
    stableContext: brandContext(req.dna, req.claims),
    userContent: [
      "Review this draft before a human sees it.",
      "<draft>",
      JSON.stringify({ ...req.post, caption_as_published: composeCaption(req.post) }, null, 1),
      "</draft>",
      `Deterministic linter findings already reported (don't repeat them): ${req.lintFindings.length ? req.lintFindings.map((f) => `${f.code}: ${f.message}`).join("; ") : "none"}`,
    ].join("\n"),
    schema: ReviewSchema,
  });
  return { review: res.output, costMicros: res.costMicros };
}

/** Combine deterministic and AI risk: the higher one wins. */
export function combinedRisk(a: RiskClass, b: RiskClass): RiskClass {
  const order: RiskClass[] = ["low", "medium", "high"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
}
