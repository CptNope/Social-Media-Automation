import type { DraftRequest, PlanRequest, Plan, Review, ReviewRequest, ClaimForPrompt } from "@jat/ai";
import { combinedRisk } from "@jat/ai";
import {
  BrandDnaSchema,
  DEFAULT_TIMEZONE,
  brandForbiddenPhrases,
  brandMaxHashtags,
  contentHash,
  deriveRiskClass,
  hasBlockers,
  isClaimUsable,
  lintPost,
  brandPersonaIds,
  brandPillarIds,
  type BrandDna,
  type Channel,
  type Claim,
  type Finding,
  type PostDraft,
} from "@jat/core";
import {
  addRevision,
  claimSlotForDraft,
  getContentItem,
  appendAudit,
  createContentItem,
  getBrand,
  getBrandWebsite,
  getCampaign,
  getCurrentTenant,
  getDnaVersion,
  getWorkRun,
  inTenant,
  insertCampaign,
  insertSlot,
  listCampaignSlots,
  listChannelSettings,
  listClaims,
  recentHooks,
  setContentState,
  updateSlot,
  updateWorkRun,
  type ClaimRow,
  type Database,
  type QueryClient,
} from "@jat/db";
import { UserFacingError } from "./onboarding.ts";

/** AI functions the jobs need (bound to a Claude client + ledger in main.ts / demo / tests). */
export interface ContentAi {
  plan: (req: PlanRequest) => Promise<{ plan: Plan; warnings: Finding[]; costMicros: number }>;
  draft: (req: DraftRequest) => Promise<{ post: PostDraft; costMicros: number }>;
  review: (req: ReviewRequest) => Promise<{ review: Review; costMicros: number }>;
}

export interface ContentJobDeps {
  db: Database;
  ai: ContentAi | null;
  timezone?: string;
}

const AI_MISSING = "AI is not configured on this server (ANTHROPIC_API_KEY is not set).";

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------
export function toCoreClaim(c: ClaimRow): Claim {
  return {
    id: c.id,
    text: c.text,
    category: c.category as Claim["category"],
    status: c.status,
    evidence: c.evidence.map((e) => ({ kind: e.kind, reference: e.reference, captured_at: e.captured_at, ...(e.note ? { note: e.note } : {}) })),
    ...(c.verifiedBy ? { verified_by: c.verifiedBy } : {}),
    ...(c.expiresAt ? { expires_at: c.expiresAt } : {}),
  };
}

export interface BrandContext {
  brandId: string;
  dna: BrandDna;
  dnaVersionId: string;
  claims: ClaimForPrompt[];
  usableClaimIds: Set<string>;
  website: string | null;
  budgetCents: number;
}

/** Active Brand DNA + verified claims, or a user-facing reason why work can't start. */
export async function loadBrandContext(tx: QueryClient, brandId: string, now = new Date()): Promise<BrandContext> {
  const brand = await getBrand(tx, brandId);
  if (!brand?.activeDnaVersionId) throw new UserFacingError("Approve the brand's Brand DNA before planning or drafting content.");
  const version = await getDnaVersion(tx, brand.activeDnaVersionId);
  const dna = BrandDnaSchema.parse(version!.data);
  const usable = (await listClaims(tx, brandId)).filter((c) => isClaimUsable(toCoreClaim(c), now));
  const tenant = await getCurrentTenant(tx);
  return {
    brandId,
    dna,
    dnaVersionId: brand.activeDnaVersionId,
    claims: usable.map((c) => ({ id: c.id, text: c.text, category: c.category })),
    usableClaimIds: new Set(usable.map((c) => c.id)),
    website: await getBrandWebsite(tx, brandId),
    budgetCents: tenant?.monthlyAiBudgetCents ?? 1500,
  };
}

/** Deterministic checks for a post against this brand. */
export function lintForBrand(post: PostDraft, ctx: Pick<BrandContext, "dna" | "usableClaimIds">, hooks: readonly string[] = []): Finding[] {
  return lintPost(post, { forbiddenPhrases: brandForbiddenPhrases(ctx.dna), usableClaimIds: ctx.usableClaimIds, brandMaxHashtags: brandMaxHashtags(ctx.dna), recentHooks: hooks });
}

export function reviewFindings(review: Review | null): Finding[] {
  return (review?.findings ?? []).map((f) => ({ code: `ai.${f.code}`, severity: f.severity, message: `${f.explanation}${f.suggested_fix ? ` Suggested fix: ${f.suggested_fix}` : ""}`, ...(f.span ? { span: f.span } : {}) }));
}

function publicError(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  if (/^(AI budget exceeded|Brand DNA needs|Turn on at least one channel|Output |Model declined|Claude API \d{3})/.test(msg)) return msg.slice(0, 500);
  return "The job failed unexpectedly. Details are in the server log.";
}

// ---------------------------------------------------------------------------
// Planning job
// ---------------------------------------------------------------------------
export async function runPlanJob(deps: ContentJobDeps, args: { tenantId: string; runId: string }): Promise<void> {
  const { db } = deps;
  const tz = deps.timezone ?? DEFAULT_TIMEZONE;
  const tx = <T>(fn: (q: QueryClient) => Promise<T>) => inTenant(db, { tenantId: args.tenantId }, fn);
  const run = await tx((q) => getWorkRun(q, args.runId));
  if (!run) throw new Error(`work run ${args.runId} not found`);
  try {
    await tx((q) => updateWorkRun(q, run.id, { status: "running", progress: { message: "Planning…" } }));
    if (!deps.ai) throw new UserFacingError(AI_MISSING);
    const ctx = await tx((q) => loadBrandContext(q, run.brandId));
    const channels = (await tx((q) => listChannelSettings(q, run.brandId))).filter((c) => c.enabled && c.postsPerWeek > 0).map((c) => ({ channel: c.channel as Channel, postsPerWeek: c.postsPerWeek }));
    const input = run.input as { startDate: string; days: 30 | 60 | 90; goals: string; events?: string };
    const res = await deps.ai.plan({ tenantId: args.tenantId, budgetCents: ctx.budgetCents, dna: ctx.dna, claims: ctx.claims, channels, startDate: input.startDate, days: input.days, timezone: tz, goals: input.goals, ...(input.events ? { events: input.events } : {}) });

    await tx(async (q) => {
      const ids = new Map<string, string>();
      for (const c of res.plan.campaigns) {
        ids.set(c.key, await insertCampaign(q, { tenantId: args.tenantId, brandId: run.brandId, name: c.name, objective: c.objective, description: c.description, startsOn: c.startsOn, endsOn: c.endsOn, dnaVersionId: ctx.dnaVersionId, planNotes: { assumptions: res.plan.assumptions, risks: res.plan.risks, goals: input.goals } }));
      }
      for (const s of res.plan.slots) {
        await insertSlot(q, { tenantId: args.tenantId, brandId: run.brandId, campaignId: ids.get(s.campaignKey)!, channel: s.channel, format: s.format, pillarId: s.pillarId, personaId: s.personaId, objective: s.objective, publishAt: s.publishAt, topic: s.topic, notes: s.notes, offerClaimId: s.offerClaimId });
      }
      const firstCampaign = ids.values().next().value as string;
      await updateWorkRun(q, run.id, { status: "done", campaignId: firstCampaign, progress: { done: res.plan.slots.length, total: res.plan.slots.length, message: `${res.plan.campaigns.length} campaign(s), ${res.plan.slots.length} posts planned.${res.warnings.length ? " " + res.warnings.map((w) => w.message).join(" ") : ""}` }, finished: true });
      await appendAudit(q, args.tenantId, { actorType: "agent", actorId: `work_run:${run.id}`, action: "plan.created", entityType: "campaign", entityId: firstCampaign, after: { campaigns: res.plan.campaigns.length, slots: res.plan.slots.length, costMicros: res.costMicros } });
    });
  } catch (err) {
    console.error(`[plan ${run.id}]`, err);
    await tx((q) => updateWorkRun(q, run.id, { status: "failed", error: publicError(err), finished: true }));
  }
}

// ---------------------------------------------------------------------------
// Drafting job
// ---------------------------------------------------------------------------
export async function runDraftJob(deps: ContentJobDeps, args: { tenantId: string; runId: string }): Promise<void> {
  const { db } = deps;
  const tx = <T>(fn: (q: QueryClient) => Promise<T>) => inTenant(db, { tenantId: args.tenantId }, fn);
  const run = await tx((q) => getWorkRun(q, args.runId));
  if (!run?.campaignId) throw new Error(`draft run ${args.runId} not found`);
  try {
    if (!deps.ai) throw new UserFacingError(AI_MISSING);
    const ai = deps.ai;
    const { ctx, campaign, slots, hooks } = await tx(async (q) => ({
      ctx: await loadBrandContext(q, run.brandId),
      campaign: (await getCampaign(q, run.campaignId!))!,
      slots: (await listCampaignSlots(q, run.campaignId!)).filter((s) => s.status === "planned" && !s.contentItemId),
      hooks: await recentHooks(q, run.brandId),
    }));
    if (campaign.status !== "approved" && campaign.status !== "active") throw new UserFacingError("Approve the plan before drafting posts.");
    // Brand DNA may have changed since planning; every slot must still match a current pillar and persona.
    const pillars = brandPillarIds(ctx.dna);
    const personas = brandPersonaIds(ctx.dna);
    const orphaned = slots.filter((s) => !pillars.has(s.pillarId) || !personas.has(s.personaId));
    if (orphaned.length) throw new UserFacingError(`${orphaned.length} planned post(s) use pillars or personas that are no longer in the approved Brand DNA. Draft a new plan.`);
    let done = 0;
    let failed = 0;
    await tx((q) => updateWorkRun(q, run.id, { status: "running", progress: { done, total: slots.length, failed } }));

    for (const s of slots) {
      try {
        const { post } = await ai.draft({
          tenantId: args.tenantId,
          budgetCents: ctx.budgetCents,
          dna: ctx.dna,
          claims: ctx.claims,
          slot: { id: s.id, channel: s.channel as Channel, format: s.format as PostDraft["format"], pillarId: s.pillarId, personaId: s.personaId, objective: s.objective as PostDraft["objective"], publishAt: s.publishAt, topic: s.topic, notes: s.notes, campaignName: campaign.name, offerClaimId: s.offerClaimId && ctx.usableClaimIds.has(s.offerClaimId) ? s.offerClaimId : null },
          websiteUrl: ctx.website,
          recentHooks: hooks,
        });
        const lint = lintForBrand(post, ctx, hooks);
        const { review } = await ai.review({ tenantId: args.tenantId, budgetCents: ctx.budgetCents, dna: ctx.dna, claims: ctx.claims, post, lintFindings: lint });
        const findings = [...lint, ...reviewFindings(review)];
        const risk = combinedRisk(deriveRiskClass(post, lint), review.risk_class);
        hooks.push(post.hook);
        const saved = await tx(async (q) => {
          // The slot may have been moved or removed while this job ran: skip it if so.
          if (!(await claimSlotForDraft(q, s.id, s.publishAt))) return false;
          const itemId = await createContentItem(q, { tenantId: args.tenantId, brandId: run.brandId, slotId: s.id, channel: s.channel, kind: s.channel === "google_business_profile" ? "gbp_post" : "social_post" });
          await addRevision(q, { tenantId: args.tenantId, itemId, body: post, contentHash: contentHash(post), findings, review, createdBy: `work_run:${run.id}`, riskClass: risk });
          // Clean drafts go straight to review; drafts with blockers wait for an editor.
          if (!hasBlockers(findings)) await setContentState(q, itemId, "in_review", null);
          await updateSlot(q, s.id, { status: "drafted" });
          await appendAudit(q, args.tenantId, { actorType: "agent", actorId: `work_run:${run.id}`, action: "content.drafted", entityType: "content_item", entityId: itemId, after: { channel: s.channel, risk, blockers: findings.filter((f) => f.severity === "blocker").length } });
          return true;
        });
        if (saved) done++;
      } catch (err) {
        if (err instanceof Error && /^AI budget exceeded/.test(err.message)) throw err;
        console.error(`[draft ${run.id}] slot ${s.id}`, err);
        failed++;
      }
      await tx((q) => updateWorkRun(q, run.id, { progress: { done, total: slots.length, failed } }));
    }
    await tx((q) => updateWorkRun(q, run.id, { status: failed && !done ? "failed" : "done", progress: { done, total: slots.length, failed, message: `${done} drafted${failed ? `, ${failed} failed (retry to draft the rest)` : ""}.` }, ...(failed && !done ? { error: "No posts could be drafted. Details are in the server log." } : {}), finished: true }));
  } catch (err) {
    console.error(`[draft ${run.id}]`, err);
    await tx((q) => updateWorkRun(q, run.id, { status: "failed", error: publicError(err), finished: true }));
  }
}

// ---------------------------------------------------------------------------
// Re-check one post with the AI reviewer (after human edits)
// ---------------------------------------------------------------------------
export async function runRecheckJob(deps: ContentJobDeps, args: { tenantId: string; itemId: string; expectedHash: string; userId: string }): Promise<void> {
  const tx = <T>(fn: (q: QueryClient) => Promise<T>) => inTenant(deps.db, { tenantId: args.tenantId }, fn);
  if (!deps.ai) return;
  const { item, ctx, hooks } = await tx(async (q) => {
    const it = await getContentItem(q, args.itemId);
    return { item: it, ctx: it ? await loadBrandContext(q, it.brandId) : null, hooks: it ? await recentHooks(q, it.brandId) : [] };
  });
  if (!item?.body || !ctx || item.contentHash !== args.expectedHash) return;
  const post = item.body as PostDraft;
  const lint = lintForBrand(post, ctx, hooks.filter((h) => h !== post.hook));
  const { review } = await deps.ai.review({ tenantId: args.tenantId, budgetCents: ctx.budgetCents, dna: ctx.dna, claims: ctx.claims, post, lintFindings: lint });
  const findings = [...lint, ...reviewFindings(review)];
  const risk = combinedRisk(deriveRiskClass(post, lint), review.risk_class);
  await tx(async (q) => {
    const { lockContentItem } = await import("@jat/db");
    const current = await lockContentItem(q, args.itemId);
    if (!current || current.contentHash !== args.expectedHash || current.state !== "draft") return; // changed meanwhile
    await addRevision(q, { tenantId: args.tenantId, itemId: args.itemId, body: post, contentHash: args.expectedHash, findings, review, createdBy: `ai_recheck:${args.userId}`, riskClass: risk });
    await appendAudit(q, args.tenantId, { actorType: "agent", actorId: `ai_recheck:${args.userId}`, action: "content.rechecked", entityType: "content_item", entityId: args.itemId, after: { risk, blockers: findings.filter((f) => f.severity === "blocker").length } });
  });
}

/**
 * AI findings from an earlier version stay attached after a human edit until the AI
 * reviewer runs again, so an edit can't silently clear an AI blocker.
 */
export function carriedAiFindings(previous: readonly Finding[]): Finding[] {
  return previous.filter((f) => f.code.startsWith("ai.")).map((f) => (f.message.endsWith("(earlier version)") ? f : { ...f, message: `${f.message} (earlier version)` }));
}
