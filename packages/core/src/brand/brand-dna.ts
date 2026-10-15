import { z } from "zod/v4";
import type { Finding } from "../types.ts";

/**
 * Brand DNA — the versioned, structured brand profile every module reads.
 *
 * Every leaf value is wrapped in a provenance envelope so we can enforce
 * "never silently invent brand facts": a value must cite evidence or be
 * confirmed by a human before the profile can become active.
 */

export const PROVENANCE_STATUSES = ["extracted", "inferred", "missing", "operator"] as const;
export type ProvenanceStatus = (typeof PROVENANCE_STATUSES)[number];

export interface Provenanced<T> {
  value: T | null;
  /** Evidence ids, e.g. "doc:brandbook.pdf#p4", "web:/about". */
  sources: string[];
  confidence: "high" | "medium" | "low";
  status: ProvenanceStatus;
  /** User id of the human who confirmed this value, if any. */
  confirmed_by?: string | undefined;
}

export const provenanced = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    value: inner.nullable(),
    sources: z.array(z.string().min(1)),
    confidence: z.enum(["high", "medium", "low"]),
    status: z.enum(PROVENANCE_STATUSES),
    confirmed_by: z.string().optional(),
  });

export const HexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Color must be #RRGGBB");

export const ColorSchema = z.object({
  name: z.string().min(1),
  hex: HexColorSchema,
  role: z.enum(["primary", "secondary", "accent", "neutral", "background", "text"]),
  usage_notes: z.string().optional(),
});

export const TypefaceSchema = z.object({
  family: z.string().min(1),
  role: z.enum(["heading", "body", "accent"]),
  weights: z.array(z.number().int().min(100).max(900)).default([]),
  fallback: z.string().optional(),
});

export const LocationSchema = z.object({
  label: z.string().min(1),
  address: z.string().optional(),
  service_area: z.array(z.string()).default([]),
  hours: z.string().optional(),
});

export const PillarSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  proof_claim_ids: z.array(z.string()).default([]),
});

export const PersonaSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(1),
  goals: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  channels: z.array(z.string()).default([]),
});

export const OfferingSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.string().url().optional(),
  price_note: z.string().optional(),
});

export const BrandDnaSchema = z.object({
  schema_version: z.literal(1),
  identity: z.object({
    display_name: provenanced(z.string().min(1)),
    legal_name: provenanced(z.string()),
    tagline: provenanced(z.string()),
    industry: provenanced(z.string()),
    founded_year: provenanced(z.number().int().min(1800).max(2100)),
    locations: provenanced(z.array(LocationSchema)),
  }),
  visual: z.object({
    colors: provenanced(z.array(ColorSchema)),
    typography: provenanced(z.array(TypefaceSchema)),
    logo_rules: provenanced(z.string()),
    photography_style: provenanced(z.string()),
    illustration_style: provenanced(z.string()),
    layout_notes: provenanced(z.string()),
  }),
  voice: z.object({
    personality: provenanced(z.array(z.string()).max(7)),
    tone_by_context: provenanced(z.record(z.string(), z.string())),
    vocabulary_preferred: provenanced(z.array(z.string())),
    vocabulary_avoid: provenanced(z.array(z.string())),
    forbidden_phrases: provenanced(z.array(z.string())),
    preferred_ctas: provenanced(z.array(z.string())),
    reading_level: provenanced(z.number().int().min(1).max(16)),
    emoji_policy: provenanced(z.enum(["none", "sparing", "liberal"])),
    hashtag_policy: provenanced(
      z.object({ max_per_post: z.number().int().min(0).max(30), branded: z.array(z.string()).default([]) }),
    ),
  }),
  strategy: z.object({
    pillars: provenanced(z.array(PillarSchema)),
    personas: provenanced(z.array(PersonaSchema)),
    offerings: provenanced(z.array(OfferingSchema)),
    differentiators: provenanced(z.array(z.string())),
    seasonality: provenanced(z.array(z.string())),
    geo_targets: provenanced(z.array(z.string())),
  }),
  compliance: z.object({
    industry_restrictions: provenanced(z.array(z.string())),
    required_disclosures: provenanced(z.array(z.string())),
  }),
});
export type BrandDna = z.infer<typeof BrandDnaSchema>;

const isProvenanced = (v: unknown): v is Provenanced<unknown> =>
  typeof v === "object" &&
  v !== null &&
  "value" in v &&
  "sources" in v &&
  "status" in v &&
  "confidence" in v;

/** Walk every provenance envelope in a Brand DNA document. */
export function* provenanceFields(
  node: unknown,
  path: string[] = [],
): Generator<{ path: string; field: Provenanced<unknown> }> {
  if (isProvenanced(node)) {
    yield { path: path.join("."), field: node };
    return;
  }
  if (node && typeof node === "object" && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) yield* provenanceFields(v, [...path, k]);
  }
}

/**
 * Rules for activating a proposed Brand DNA version.
 * Returns blocker findings that must be resolved by a human; an empty array means activatable.
 *
 * 1. Every non-null value cites at least one source OR was confirmed by a human.
 * 2. Every `inferred` value must be confirmed by a human (style judgments need sign-off).
 * 3. `missing` fields must have a null value (no sneaking in invented facts).
 * 4. Every source id must exist in the known evidence set (when supplied).
 */
export function activationIssues(dna: BrandDna, knownEvidenceIds?: ReadonlySet<string>): Finding[] {
  const issues: Finding[] = [];
  for (const { path, field } of provenanceFields(dna)) {
    const hasValue = field.value !== null && !(Array.isArray(field.value) && field.value.length === 0);
    if (field.status === "missing" && field.value !== null) {
      issues.push({ code: "brand.missing_has_value", severity: "blocker", field: path, message: `${path} is marked missing but has a value.` });
    }
    if (hasValue && field.sources.length === 0 && !field.confirmed_by) {
      issues.push({ code: "brand.unsourced_value", severity: "blocker", field: path, message: `${path} has a value with no source and no human confirmation.` });
    }
    if (field.status === "inferred" && hasValue && !field.confirmed_by) {
      issues.push({ code: "brand.inferred_unconfirmed", severity: "blocker", field: path, message: `${path} is inferred and must be confirmed by a human before activation.` });
    }
    if (knownEvidenceIds) {
      for (const s of field.sources) {
        if (!knownEvidenceIds.has(s)) {
          issues.push({ code: "brand.unknown_source", severity: "blocker", field: path, message: `${path} cites unknown source "${s}".` });
        }
      }
    }
  }
  return issues;
}

/** Convenience accessors used by generators and the linter (null-safe). */
export const brandForbiddenPhrases = (dna: BrandDna): string[] => dna.voice.forbidden_phrases.value ?? [];
export const brandMaxHashtags = (dna: BrandDna): number | undefined => dna.voice.hashtag_policy.value?.max_per_post;
export const brandRequiredDisclosures = (dna: BrandDna): string[] => dna.compliance.required_disclosures.value ?? [];
export const brandPillarIds = (dna: BrandDna): Set<string> => new Set((dna.strategy.pillars.value ?? []).map((p) => p.id));
export const brandPersonaIds = (dna: BrandDna): Set<string> => new Set((dna.strategy.personas.value ?? []).map((p) => p.id));
