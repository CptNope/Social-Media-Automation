import type { BrandExtractionInput, BrandExtractionResult, EvidenceChunk } from "@jat/ai";
import type { CrawlOptions, CrawlResult } from "@jat/ingest";
import {
  appendAudit,
  getCurrentTenant,
  getOnboardingRun,
  inTenant,
  insertClaim,
  insertProposedDna,
  updateOnboardingRun,
  insertSources,
  type Database,
  type SourceInput,
} from "@jat/db";

export interface OnboardingDeps {
  db: Database;
  crawl: (opts: CrawlOptions) => Promise<CrawlResult>;
  /** null when no ANTHROPIC_API_KEY is configured. */
  extract: ((input: BrandExtractionInput) => Promise<BrandExtractionResult>) | null;
  maxPages?: number;
}

const SAFE_ERROR = /^(Host |Only http|URLs with|Non-standard port|AI budget exceeded|Output |Model declined|Response had|At least one|Claude API \d{3})/;

/** Errors whose message is safe and useful to show operators. */
export class UserFacingError extends Error {}

function publicError(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  return SAFE_ERROR.test(msg) ? msg.slice(0, 500) : "The onboarding job failed unexpectedly. Details are in the server log.";
}

/** Crawl → evidence → Brand DNA proposal → stored for human review. Never activates anything. */
export async function runOnboarding(deps: OnboardingDeps, args: { tenantId: string; runId: string }): Promise<void> {
  const { db } = deps;
  const { tenantId, runId } = args;
  const run = await inTenant(db, { tenantId }, (tx) => getOnboardingRun(tx, runId));
  if (!run) throw new Error(`Onboarding run ${runId} not found`);
  const business = run.business as { name?: string; industry?: string; locations?: string[]; notes?: string };

  try {
    const evidence: EvidenceChunk[] = [];
    const sources: SourceInput[] = [];
    let crawlSummary: Record<string, unknown> = {};

    if (run.websiteUrl) {
      await inTenant(db, { tenantId }, (tx) => updateOnboardingRun(tx, runId, { status: "crawling" }));
      const crawl = await deps.crawl({ startUrl: run.websiteUrl, maxPages: deps.maxPages ?? 25 });
      crawlSummary = { pages: crawl.pages.length, skipped: crawl.skipped.length, robots: crawl.robots.status, requests: crawl.requests, colors: crawl.siteColors, fonts: crawl.siteFonts };
      for (const e of crawl.evidence) {
        evidence.push(e);
        const page = crawl.pages.find((p) => `web:${new URL(p.url).pathname}${new URL(p.url).search}` === e.id);
        sources.push({ evidenceId: e.id, kind: "url", uri: page?.url ?? run.websiteUrl, text: e.text });
      }
    }
    if (business.notes?.trim()) {
      evidence.push({ id: "note:operator", kind: "note", text: business.notes });
      sources.push({ evidenceId: "note:operator", kind: "note", uri: `user:${run.startedBy}`, text: business.notes });
    }
    await inTenant(db, { tenantId }, (tx) => insertSources(tx, tenantId, run.brandId, runId, sources));
    if (evidence.length === 0) throw new UserFacingError("No evidence collected: the website could not be crawled and there are no operator notes. Check the URL or add notes, then retry.");

    if (!deps.extract) throw new UserFacingError("AI is not configured on this server (ANTHROPIC_API_KEY is not set). The website evidence was saved; retry once a key is configured.");
    await inTenant(db, { tenantId }, (tx) => updateOnboardingRun(tx, runId, { status: "extracting", crawlSummary }));
    const tenant = await inTenant(db, { tenantId }, (tx) => getCurrentTenant(tx));
    const result = await deps.extract({
      tenantId,
      budgetCents: tenant?.monthlyAiBudgetCents ?? 1500,
      business: { name: business.name ?? tenant?.name ?? "Business", ...(business.industry ? { industry: business.industry } : {}), ...(business.locations?.length ? { locations: business.locations } : {}), ...(business.notes ? { notes: business.notes } : {}) },
      evidence,
    });

    await inTenant(db, { tenantId }, async (tx) => {
      const version = await insertProposedDna(tx, { tenantId, brandId: run.brandId, data: result.proposal.dna, createdBy: `onboarding_run:${runId}` });
      const sourceUri = new Map(sources.map((s) => [s.evidenceId, s.uri]));
      const rejectedClaims = new Set(result.findings.filter((f) => f.code.startsWith("claims.") && f.severity === "blocker").map((f) => f.span));
      for (const c of result.proposal.candidate_claims) {
        // Only claims whose quote was found verbatim in collected evidence are kept, as pending;
        // the owner still has to verify each one.
        const uri = sourceUri.get(c.source_id);
        if (!uri || rejectedClaims.has(c.text) || rejectedClaims.has(c.quote)) continue;
        await insertClaim(tx, {
          tenantId,
          brandId: run.brandId,
          text: c.text,
          category: c.category,
          evidence: [{ kind: c.source_id.startsWith("note:") ? "operator_attestation" : "url", reference: uri, captured_at: new Date().toISOString(), note: `Quote: "${c.quote}"` }],
        });
      }
      await updateOnboardingRun(tx, runId, {
        status: "ready",
        dnaVersionId: version.id,
        findings: result.findings,
        conflicts: result.proposal.conflicts,
        missingInfo: result.proposal.missing_information,
        crawlSummary,
        costMicros: result.costMicros,
        finished: true,
      });
      await appendAudit(tx, tenantId, { actorType: "agent", actorId: `onboarding_run:${runId}`, action: "brand_dna.proposed", entityType: "brand_dna_version", entityId: version.id, after: { version: version.version, findings: result.findings.length } });
    });
  } catch (err) {
    console.error(`[onboarding ${runId}]`, err);
    await inTenant(db, { tenantId }, (tx) => updateOnboardingRun(tx, runId, { status: "failed", error: publicError(err), finished: true }));
  }
}
