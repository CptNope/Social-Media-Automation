import { provenanceFields, type BrandDna } from "@jat/core";

export interface ClaimForPrompt {
  id: string;
  text: string;
  category: string;
}

/** Approved Brand DNA values only (no provenance noise), grouped by section. */
export function brandValues(dna: BrandDna): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const { path, field } of provenanceFields(dna)) {
    if (field.value === null || (Array.isArray(field.value) && field.value.length === 0)) continue;
    const [section, key] = path.split(".") as [string, string];
    (out[section] ??= {})[key] = field.value;
  }
  return out;
}

/**
 * Stable, cacheable context shared by the planning, drafting and review agents.
 * Only verified, unexpired claims are listed — the only facts content may state.
 */
export function brandContext(dna: BrandDna, claims: readonly ClaimForPrompt[]): string {
  return [
    "<approved_brand_dna>",
    JSON.stringify(brandValues(dna), null, 1),
    "</approved_brand_dna>",
    "",
    "<registered_claims note=\"The ONLY factual statements about the business that content may make. Cite their ids.\">",
    claims.length ? claims.map((c) => `- [${c.id}] (${c.category}) ${c.text}`).join("\n") : "(none yet — make no factual claims about the business)",
    "</registered_claims>",
  ].join("\n");
}
