import { z } from "zod/v4";
import { BRAND_FIELDS } from "@jat/ai";
import { activationIssues, provenanceFields, type BrandDna, type Finding, type Provenanced } from "@jat/core";

/** How a Brand DNA field is edited in the UI. */
export type EditorKind = { kind: "text" } | { kind: "number" } | { kind: "select"; options: string[] } | { kind: "lines" } | { kind: "json" };

export const FIELD_LABELS: Record<string, string> = {
  "identity.display_name": "Business name",
  "identity.legal_name": "Legal name",
  "identity.tagline": "Tagline",
  "identity.industry": "Industry",
  "identity.founded_year": "Year founded",
  "identity.locations": "Locations & service areas",
  "visual.colors": "Colors",
  "visual.typography": "Typography",
  "visual.logo_rules": "Logo rules",
  "visual.photography_style": "Photography style",
  "visual.illustration_style": "Illustration style",
  "visual.layout_notes": "Layout notes",
  "voice.personality": "Personality",
  "voice.tone_by_context": "Tone by context",
  "voice.vocabulary_preferred": "Preferred vocabulary",
  "voice.vocabulary_avoid": "Words to avoid",
  "voice.forbidden_phrases": "Forbidden phrases",
  "voice.preferred_ctas": "Preferred calls to action",
  "voice.reading_level": "Reading level (grade)",
  "voice.emoji_policy": "Emoji use",
  "voice.hashtag_policy": "Hashtag policy",
  "strategy.pillars": "Messaging pillars",
  "strategy.personas": "Customer personas",
  "strategy.offerings": "Products & services",
  "strategy.differentiators": "Differentiators",
  "strategy.seasonality": "Seasonal opportunities",
  "strategy.geo_targets": "Geographic targets",
  "compliance.industry_restrictions": "Industry restrictions",
  "compliance.required_disclosures": "Required disclosures",
};

export const SECTION_LABELS: Record<string, string> = {
  identity: "Identity",
  visual: "Visual identity",
  voice: "Voice & tone",
  strategy: "Strategy",
  compliance: "Compliance",
};

const specByPath = new Map(BRAND_FIELDS.map((f) => [f.path, f]));

export function fieldSpec(path: string) {
  return specByPath.get(path);
}

export function editorKind(path: string): EditorKind {
  const s = fieldSpec(path)?.valueSchema;
  if (s instanceof z.ZodString) return { kind: "text" };
  if (s instanceof z.ZodNumber) return { kind: "number" };
  if (s instanceof z.ZodEnum) return { kind: "select", options: s.options.map(String) };
  if (s instanceof z.ZodArray && s.element instanceof z.ZodString) return { kind: "lines" };
  return { kind: "json" };
}

/** Value shown in the editor for the current field value. */
export function editorValue(path: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  const k = editorKind(path).kind;
  if (k === "text" || k === "number" || k === "select") return String(value);
  if (k === "lines" && Array.isArray(value)) return value.join("\n");
  return JSON.stringify(value, null, 2);
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse the submitted editor text into a validated value (null = mark missing). */
export function parseEditorInput(path: string, raw: string): ParseResult {
  const spec = fieldSpec(path);
  if (!spec) return { ok: false, error: "Unknown field" };
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  const k = editorKind(path).kind;
  let candidate: unknown;
  if (k === "text" || k === "select") candidate = t;
  else if (k === "number") candidate = Number(t);
  else if (k === "lines") candidate = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  else {
    try {
      candidate = JSON.parse(t);
    } catch {
      return { ok: false, error: "Not valid JSON" };
    }
  }
  const v = spec.valueSchema.safeParse(candidate);
  if (!v.success) return { ok: false, error: v.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ") };
  return { ok: true, value: v.data };
}

export function getField(dna: BrandDna, path: string): Provenanced<unknown> {
  const [section, key] = path.split(".") as [string, string];
  return (dna as unknown as Record<string, Record<string, Provenanced<unknown>>>)[section]![key]!;
}

/**
 * Apply a human action to one field. Returns a new Brand DNA object.
 * - "confirm": keep the value, record who confirmed it.
 * - "edit": replace the value; status becomes "operator" (human-entered), sources keep the
 *   original evidence plus the editor, and the edit counts as confirmation.
 */
export function applyFieldAction(dna: BrandDna, path: string, action: { type: "confirm" } | { type: "edit"; value: unknown }, userId: string): BrandDna {
  const copy = structuredClone(dna) as BrandDna;
  const [section, key] = path.split(".") as [string, string];
  const sectionObj = (copy as unknown as Record<string, Record<string, Provenanced<unknown>>>)[section]!;
  const current = sectionObj[key]!;
  if (action.type === "confirm") {
    sectionObj[key] = { ...current, confirmed_by: userId };
  } else if (action.value === null) {
    sectionObj[key] = { value: null, sources: [], confidence: "low", status: "missing" };
  } else {
    const sources = [...new Set([...current.sources.filter((s) => !s.startsWith("user:")), `user:${userId}`])];
    sectionObj[key] = { value: action.value, sources, confidence: "high", status: "operator", confirmed_by: userId };
  }
  return copy;
}

/**
 * Everything that blocks activation of a version:
 * - the core rules (sourced or confirmed values, confirmed inferences, empty "missing" fields)
 * - every cited source must be evidence collected for this version, except "user:<id>",
 *   which is only valid on a field that same person confirmed (i.e. their own edit).
 */
export function versionIssues(dna: BrandDna, evidenceIds: ReadonlySet<string>): Finding[] {
  const issues = activationIssues(dna);
  for (const { path, field } of provenanceFields(dna)) {
    for (const src of field.sources) {
      const ok = src.startsWith("user:") ? field.confirmed_by === src.slice(5) : evidenceIds.has(src);
      if (!ok) issues.push({ code: "brand.unknown_source", severity: "blocker", field: path, message: `${FIELD_LABELS[path] ?? path} cites a source that isn't part of this version's evidence ("${src}"). Edit or confirm the value.` });
    }
  }
  return issues;
}
