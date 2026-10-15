import { z } from "zod/v4";

/**
 * Claim & evidence registry. A claim is a factual statement the business is
 * allowed to make publicly ("Licensed in Massachusetts", "Family-owned since 2004").
 * Generated content may only assert claims that are verified and unexpired.
 */
export const ClaimEvidenceSchema = z.object({
  kind: z.enum(["document", "url", "license_lookup", "operator_attestation", "customer_consent"]),
  reference: z.string().min(1),
  captured_at: z.string().datetime(),
  note: z.string().optional(),
});

export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(500),
  category: z.enum(["credential", "history", "offer", "statistic", "testimonial", "award", "service", "other"]),
  status: z.enum(["pending", "verified", "expired", "rejected"]),
  evidence: z.array(ClaimEvidenceSchema),
  verified_by: z.string().optional(),
  expires_at: z.string().datetime().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export function isClaimUsable(claim: Claim, now: Date = new Date()): boolean {
  if (claim.status !== "verified") return false;
  if (claim.evidence.length === 0) return false;
  if (!claim.verified_by) return false;
  if (claim.expires_at && new Date(claim.expires_at).getTime() <= now.getTime()) return false;
  // Testimonials additionally require recorded customer consent.
  if (claim.category === "testimonial" && !claim.evidence.some((e) => e.kind === "customer_consent")) return false;
  return true;
}

export const usableClaims = (claims: readonly Claim[], now: Date = new Date()): Claim[] =>
  claims.filter((c) => isClaimUsable(c, now));

export const usableClaimIds = (claims: readonly Claim[], now: Date = new Date()): Set<string> =>
  new Set(usableClaims(claims, now).map((c) => c.id));
