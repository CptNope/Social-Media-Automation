import { CHANNELS, DEFAULT_TIMEZONE, PostDraftSchema, composeCaption, addDays, approvalRequirement, contentHash, zonedToUtc, deriveRiskClass, hasBlockers, isCalendarDate, localDate, transition, type ContentItemState, type PostDraft, type Role, TransitionError } from "@jat/core";
import {
  activeWorkRun,
  addRevision,
  appendAudit,
  createWorkRun,
  getBrand,
  getCampaign,
  getContentItem,
  getCurrentTenant,
  getSlot,
  getWorkRun,
  insertApproval,
  listApprovals,
  listCampaignSlots,
  listCampaigns,
  listChannelSettings,
  listContentItems,
  listSlots,
  listWorkRuns,
  lockContentItem,
  recentHooks,
  setBrandWebsite,
  setCampaignStatus,
  setContentState,
  updateSlot,
  upsertChannelSetting,
  getBrandWebsite,
  globalPause,
  integrationForChannel,
  listItemPublications,
  lockLiveItemPublication,
  updatePublication,
  type ContentItemRow,
  type ContentStateName,
  type MemberRole,
  type QueryClient,
} from "@jat/db";
import { combinedRisk } from "@jat/ai";
import { carriedAiFindings, runDraftJob, runPlanJob, runRecheckJob, lintForBrand, loadBrandContext, type ContentJobDeps } from "./content-jobs.ts";
import { HttpError, htmlResponse, redirect, type Req, type Res, type Router } from "./http.ts";
import type { JobRunner } from "./jobs.ts";
import type { Shell } from "./views/layout.ts";
import * as C from "./views/content.ts";
import { publishBlocker } from "./publisher.ts";

export interface RouteCtx {
  s: { userId: string };
  tenantId: string;
  role: MemberRole;
  tenantName: string;
  shell: (active: Shell["active"], title?: string) => Promise<Shell>;
  tx: <T>(fn: (tx: QueryClient) => Promise<T>) => Promise<T>;
}

export interface RouteKit {
  router: Router;
  workspace: (req: Req) => Promise<RouteCtx>;
  idParam: (req: Req, name: string) => string;
  jobs: JobRunner;
  content: ContentJobDeps;
  /** Publishing status for the post page (null: publishing not configured on this server). */
  publishing: { mode: "live" | "dry_run" } | null;
  /** Media features for the post page (null: no media storage). */
  media: { canGenerate: boolean; maxUploadMb: number } | null;
}

const TZ = DEFAULT_TIMEZONE;
const MANAGE: MemberRole[] = ["agency_operator", "client_owner"];
const EDIT: MemberRole[] = ["agency_operator", "client_owner", "client_editor"];

const FLASH: Record<string, { kind: "ok" | "error"; message: string }> = {
  channels_saved: { kind: "ok", message: "Channels saved." },
  plan_approved: { kind: "ok", message: "Plan approved. You can draft its posts now." },
  slot_saved: { kind: "ok", message: "Saved." },
  slot_removed: { kind: "ok", message: "Removed from the plan." },
  edited: { kind: "ok", message: "Saved as a new version. Send it for approval when it's ready." },
  unchanged: { kind: "ok", message: "Nothing changed." },
  rechecking: { kind: "ok", message: "The AI reviewer is checking this version. Reload in a few seconds." },
  draft_running: { kind: "error", message: "Posts are being drafted for this plan right now. Change slots after drafting finishes." },
  submitted: { kind: "ok", message: "Sent for approval." },
  approved: { kind: "ok", message: "Approved." },
  changes: { kind: "ok", message: "Sent back with your comment." },
  exported: { kind: "ok", message: "Marked as posted." },
  stale: { kind: "error", message: "This post changed since you opened it. Review the current version and try again." },
  blocked: { kind: "error", message: "Fix the issues marked \"Must fix\" first." },
  scheduled: { kind: "ok", message: "Scheduled. It goes through the final checks again at its time." },
  unscheduled: { kind: "ok", message: "Unscheduled. The post is approved and can be scheduled again." },
  sending: { kind: "error", message: "This post is being sent right now and can't be unscheduled." },
  retrying: { kind: "ok", message: "Queued to publish again now." },
};
const flash = (req: Req) => {
  const k = req.url.searchParams.get("m") ?? "";
  return Object.hasOwn(FLASH, k) ? FLASH[k] : undefined;
};

const forbid = (msg = "Your role doesn't allow this action."): never => {
  throw new HttpError(403, msg);
};

/** Content item → state machine input. The approved hash is the latest approval of the current version. */
export async function machineState(tx: QueryClient, item: ContentItemRow): Promise<ContentItemState> {
  const approvals = await listApprovals(tx, item.id);
  const latest = approvals.find((a) => a.revisionId === item.currentRevisionId);
  return {
    state: item.state,
    contentHash: item.contentHash ?? "",
    approvedHash: latest?.decision === "approved" && ["approved", "scheduled", "publishing", "failed"].includes(item.state) ? latest.contentHash : null,
    pausedFrom: item.pausedFrom,
  };
}

/**
 * Save a changed post as a new version: validate, re-run the checks, keep the AI reviewer's risk
 * (an edit never lowers it), drop any approval (back to draft) and audit — all in the caller's
 * transaction with the item already locked. Used by text edits and by media changes.
 */
export async function reviseItem(q: QueryClient, ctx: Pick<RouteCtx, "tenantId" | "s">, item: ContentItemRow, candidate: unknown, action: string, detail: Record<string, unknown> = {}): Promise<"ok" | "unchanged"> {
  const parsed = PostDraftSchema.safeParse(candidate);
  if (!parsed.success) throw new HttpError(400, `Couldn't save: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const prev = item.body as PostDraft;
  const post = parsed.data;
  const hash = contentHash(post);
  if (hash === item.contentHash) return "unchanged";
  const ctxBrand = await loadBrandContext(q, item.brandId);
  const lint = [...lintForBrand(post, ctxBrand, (await recentHooks(q, item.brandId)).filter((h) => h !== prev.hook && h !== post.hook)), ...carriedAiFindings(item.findings as never)];
  const risk = deriveRiskClass(post, lint);
  const { next, audit } = transition(await machineState(q, item), { type: "edit", newContentHash: hash }, { type: "user", id: ctx.s.userId });
  await addRevision(q, { tenantId: ctx.tenantId, itemId: item.id, body: post, contentHash: hash, findings: lint, review: item.review, createdBy: `user:${ctx.s.userId}`, riskClass: combinedRisk(risk, item.riskClass ?? "low") });
  await setContentState(q, item.id, next.state, next.pausedFrom);
  await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action, entityType: "content_item", entityId: item.id, before: { hash: item.contentHash, state: item.state }, after: { ...audit.after, hash, ...detail } });
  return "ok";
}

const SENSITIVE_CLAIM_CATEGORIES = new Set(["testimonial", "statistic", "award"]);

/** Who may approve this post. Sensitive claims (testimonials, statistics, awards) are owner-only. */
function approverRoles(mode: "manual" | "assisted" | "autonomous", risk: string | null, sensitiveClaims = false): Role[] {
  // Every publish needs an explicit approval in this release (no pre-approved patterns yet).
  return approvalRequirement({ mode: mode === "autonomous" ? "assisted" : mode, action: "publish_post", risk: (risk as "low" | "medium" | "high") ?? "high", preapprovedPattern: false, sensitiveClaims }).approverRoles;
}

async function usesSensitiveClaims(q: QueryClient, item: ContentItemRow): Promise<boolean> {
  const ids = ((item.body as PostDraft | null)?.claim_ids_used ?? []).filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (!ids.length) return false;
  const { rows } = await q.query<{ category: string }>(`SELECT category FROM claims WHERE id = ANY(string_to_array($1, ',')::uuid[])`, [ids.join(",")]);
  return rows.some((r) => SENSITIVE_CLAIM_CATEGORIES.has(r.category));
}

function csvCell(v: string): string {
  // Neutralize spreadsheet formulas (CSV injection) and quote everything.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function registerContentRoutes(kit: RouteKit): void {
  const { router, workspace, idParam } = kit;
  const db = kit.content.db;

  async function brandOf(ctx: RouteCtx) {
    const brands = await ctx.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(`SELECT id FROM brands ORDER BY created_at LIMIT 1`);
      return rows;
    });
    const id = brands[0]?.id;
    if (!id) throw new HttpError(400, "Create the brand first (Overview page).");
    return id;
  }

  // ------------------------------------------------------------------ plan
  router.get("/w/:tenantId/plan", async (req) => {
    const ctx = await workspace(req);
    const brandId = await brandOf(ctx);
    const monthParam = req.url.searchParams.get("month") ?? "";
    const today = localDate(new Date(), TZ);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : today.slice(0, 7);
    const from = zonedToUtc(`${month}-01`, "00:00", TZ).toISOString();
    const to = zonedToUtc(addDays(`${month}-28`, 7).slice(0, 7) + "-01", "00:00", TZ).toISOString();
    const d = await ctx.tx(async (q) => {
      const brand = await getBrand(q, brandId);
      const campaigns = await listCampaigns(q, brandId, 12);
      const withCounts = [];
      for (const c of campaigns) {
        const slots = await listCampaignSlots(q, c.id);
        withCounts.push({ ...c, slotCount: slots.length, undrafted: slots.filter((s) => !s.contentItemId).length });
      }
      return {
        website: await getBrandWebsite(q, brandId),
        channels: await listChannelSettings(q, brandId),
        campaigns: withCounts,
        runs: await listWorkRuns(q, brandId, 5),
        slots: await listSlots(q, { brandId, from, to }),
        hasActiveDna: !!brand?.activeDnaVersionId,
      };
    });
    // Default start: next Monday.
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const defaultStart = addDays(today, ((8 - dow) % 7) || 7);
    return htmlResponse(C.planPage(await ctx.shell("plan", "Plan"), { ...d, month, canManage: MANAGE.includes(ctx.role), defaultStart, flash: flash(req) }));
  });

  router.post("/w/:tenantId/plan/channels", async (req) => {
    const ctx = await workspace(req);
    if (!MANAGE.includes(ctx.role)) forbid();
    const brandId = await brandOf(ctx);
    const site = (req.form.get("website_url") ?? "").trim();
    let website: string | null = null;
    if (site) {
      try {
        const u = new URL(site);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
        website = u.toString();
      } catch {
        throw new HttpError(400, "Enter the website as a full address starting with https://");
      }
    }
    await ctx.tx(async (q) => {
      await setBrandWebsite(q, brandId, website);
      for (const c of CHANNELS) {
        if (c === "wordpress") continue;
        const ppw = Math.max(0, Math.min(21, Number.parseInt(req.form.get(`ppw_${c}`) ?? "0", 10) || 0));
        const on = req.form.get(`on_${c}`) === "on";
        await upsertChannelSetting(q, { tenantId: ctx.tenantId, brandId, channel: c, enabled: on && ppw > 0, postsPerWeek: ppw });
      }
      await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "channels.updated", entityType: "brand", entityId: brandId });
    });
    return redirect(`/w/${ctx.tenantId}/plan?m=channels_saved`);
  });

  router.post("/w/:tenantId/plan/generate", async (req) => {
    const ctx = await workspace(req);
    if (!MANAGE.includes(ctx.role)) forbid();
    const brandId = await brandOf(ctx);
    const startDate = (req.form.get("start_date") ?? "").trim();
    const days = Number(req.form.get("days"));
    if (!isCalendarDate(startDate)) throw new HttpError(400, "Use a real start date in YYYY-MM-DD format.");
    if (![30, 60, 90].includes(days)) throw new HttpError(400, "Choose 30, 60 or 90 days.");
    if (startDate < localDate(new Date(), TZ)) throw new HttpError(400, "The start date can't be in the past.");
    const input = { startDate, days, goals: (req.form.get("goals") ?? "").trim().slice(0, 2000), events: (req.form.get("events") ?? "").trim().slice(0, 2000) };
    const existing = await ctx.tx((q) => activeWorkRun(q, brandId, "plan"));
    if (existing) return redirect(`/w/${ctx.tenantId}/runs/${existing.id}`);
    const runId = await ctx
      .tx(async (q) => {
        await loadBrandContext(q, brandId).catch((e: Error) => {
          throw new HttpError(400, e.message);
        });
        const id = await createWorkRun(q, { tenantId: ctx.tenantId, brandId, kind: "plan", input, startedBy: ctx.s.userId });
        await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "plan.requested", entityType: "work_run", entityId: id, after: input });
        return { id: id as string | null, created: true };
      })
      .catch(async (err: Error) => {
        if (!/work_runs_one_active/.test(err.message)) throw err;
        // A parallel request created the run (and enqueued it); just show it.
        return { id: (await ctx.tx((q) => activeWorkRun(q, brandId, "plan")))?.id ?? null, created: false };
      });
    if (!runId.id) return redirect(`/w/${ctx.tenantId}/plan`);
    if (!runId.created) return redirect(`/w/${ctx.tenantId}/runs/${runId.id}`);
    const planRunId = runId.id;
    enqueueOrFail(kit, ctx, planRunId, () => runPlanJob(kit.content, { tenantId: ctx.tenantId, runId: planRunId }));
    return redirect(`/w/${ctx.tenantId}/runs/${planRunId}`);
  });

  router.get("/w/:tenantId/runs/:runId", async (req) => {
    const ctx = await workspace(req);
    const run = await ctx.tx((q) => getWorkRun(q, idParam(req, "runId")));
    if (!run) throw new HttpError(404, "Not found");
    return htmlResponse(C.workRunPage(await ctx.shell("plan", "Job"), run));
  });

  // ------------------------------------------------------------------ campaigns & slots
  router.get("/w/:tenantId/campaigns/:campaignId", async (req) => {
    const ctx = await workspace(req);
    const id = idParam(req, "campaignId");
    const d = await ctx.tx(async (q) => ({ campaign: await getCampaign(q, id), slots: await listCampaignSlots(q, id) }));
    if (!d.campaign) throw new HttpError(404, "Not found");
    return htmlResponse(C.campaignPage(await ctx.shell("plan", d.campaign.name), { campaign: d.campaign, slots: d.slots, canManage: MANAGE.includes(ctx.role), flash: flash(req) }));
  });

  router.post("/w/:tenantId/campaigns/:campaignId/approve", async (req) => {
    const ctx = await workspace(req);
    if (!MANAGE.includes(ctx.role)) forbid();
    const id = idParam(req, "campaignId");
    const ok = await ctx.tx(async (q) => {
      if (!(await setCampaignStatus(q, id, ["proposed"], "approved"))) return false;
      await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "plan.approved", entityType: "campaign", entityId: id });
      return true;
    });
    return redirect(`/w/${ctx.tenantId}/campaigns/${id}?m=${ok ? "plan_approved" : "stale"}`);
  });

  router.post("/w/:tenantId/campaigns/:campaignId/draft", async (req) => {
    const ctx = await workspace(req);
    if (!MANAGE.includes(ctx.role)) forbid();
    const id = idParam(req, "campaignId");
    const campaign = await ctx.tx((q) => getCampaign(q, id));
    if (!campaign) throw new HttpError(404, "Not found");
    if (campaign.status !== "approved" && campaign.status !== "active") throw new HttpError(400, "Approve the plan before drafting posts.");
    const existing = await ctx.tx((q) => activeWorkRun(q, campaign.brandId, "draft"));
    if (existing) return redirect(`/w/${ctx.tenantId}/runs/${existing.id}`);
    const runId = await ctx
      .tx(async (q) => {
        const rid = await createWorkRun(q, { tenantId: ctx.tenantId, brandId: campaign.brandId, kind: "draft", campaignId: id, input: {}, startedBy: ctx.s.userId });
        await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "draft.requested", entityType: "campaign", entityId: id });
        return { id: rid as string | null, created: true };
      })
      .catch(async (err: Error) => {
        if (!/work_runs_one_active/.test(err.message)) throw err;
        return { id: (await ctx.tx((q) => activeWorkRun(q, campaign.brandId, "draft")))?.id ?? null, created: false };
      });
    if (!runId.id) return redirect(`/w/${ctx.tenantId}/campaigns/${id}`);
    if (!runId.created) return redirect(`/w/${ctx.tenantId}/runs/${runId.id}`);
    const draftRunId = runId.id;
    enqueueOrFail(kit, ctx, draftRunId, () => runDraftJob(kit.content, { tenantId: ctx.tenantId, runId: draftRunId }));
    return redirect(`/w/${ctx.tenantId}/runs/${draftRunId}`);
  });

  async function slotForEdit(ctx: RouteCtx, req: Req) {
    if (!MANAGE.includes(ctx.role)) forbid();
    const id = idParam(req, "slotId");
    const s = await ctx.tx((q) => getSlot(q, id));
    if (!s) throw new HttpError(404, "Not found");
    if (s.contentItemId) throw new HttpError(409, "This post is already drafted; edit the post instead.");
    const camp = await ctx.tx((q) => getCampaign(q, s.campaignId));
    if (!camp || (camp.status !== "proposed" && camp.status !== "approved")) throw new HttpError(409, "This campaign can't be changed any more.");
    const drafting = await ctx.tx((q) => activeWorkRun(q, camp.brandId, "draft"));
    if (drafting?.campaignId === camp.id) throw new HttpError(409, FLASH.draft_running!.message);
    return s;
  }

  router.post("/w/:tenantId/slots/:slotId/move", async (req) => {
    const ctx = await workspace(req);
    const s = await slotForEdit(ctx, req);
    const date = (req.form.get("date") ?? "").trim();
    const time = (req.form.get("time") ?? "").trim();
    const topic = (req.form.get("topic") ?? "").trim().slice(0, 300);
    if (!isCalendarDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "Use YYYY-MM-DD and a 24-hour HH:MM time.");
    if (zonedToUtc(date, time, TZ).getTime() < Date.now()) throw new HttpError(400, "Pick a time in the future.");
    await ctx.tx(async (q) => {
      await updateSlot(q, s.id, { publishAt: zonedToUtc(date, time, TZ).toISOString(), topic });
      await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "slot.updated", entityType: "calendar_slot", entityId: s.id, before: { publishAt: s.publishAt, topic: s.topic }, after: { date, time, topic } });
    });
    return redirect(`/w/${ctx.tenantId}/campaigns/${s.campaignId}?m=slot_saved#slot-${s.id}`);
  });

  router.post("/w/:tenantId/slots/:slotId/cancel", async (req) => {
    const ctx = await workspace(req);
    const s = await slotForEdit(ctx, req);
    await ctx.tx(async (q) => {
      await updateSlot(q, s.id, { status: "cancelled" });
      await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "slot.cancelled", entityType: "calendar_slot", entityId: s.id });
    });
    return redirect(`/w/${ctx.tenantId}/campaigns/${s.campaignId}?m=slot_removed`);
  });

  // ------------------------------------------------------------------ content
  router.get("/w/:tenantId/content", async (req) => {
    const ctx = await workspace(req);
    const brandId = await brandOf(ctx);
    const f = req.url.searchParams.get("state") ?? "";
    const states = ["draft", "in_review", "approved", "exported"].includes(f) ? [f as ContentStateName] : undefined;
    const items = await ctx.tx((q) => listContentItems(q, { brandId, ...(states ? { states } : {}) }));
    return htmlResponse(C.contentListPage(await ctx.shell("content", "Content"), { items, filter: states ? f : "" }));
  });

  async function renderItem(ctx: RouteCtx, id: string, fl?: { kind: "ok" | "error"; message: string }, status = 200): Promise<Res> {
    const d = await ctx.tx(async (q) => {
      const item = await getContentItem(q, id);
      if (!item) return null;
      return {
        item,
        approvals: await listApprovals(q, id),
        tenant: (await getCurrentTenant(q))!,
        sensitive: await usesSensitiveClaims(q, item),
        publications: await listItemPublications(q, id),
        integration: await integrationForChannel(q, item.channel),
        global: await globalPause(q),
      };
    });
    if (!d || !d.item.body) throw new HttpError(404, "Not found");
    const roles = approverRoles(d.tenant.automationMode, d.item.riskClass, d.sensitive);
    return htmlResponse(
      C.contentItemPage(await ctx.shell("content", "Post"), {
        item: d.item,
        approvals: d.approvals,
        canEdit: EDIT.includes(ctx.role),
        canApprove: roles.includes(ctx.role as Role),
        approverLabel: roles.includes("reviewer") ? "the owner or a reviewer" : "the owner",
        canExport: MANAGE.includes(ctx.role),
        lintNow: [],
        canRecheck: EDIT.includes(ctx.role) && !!kit.content.ai,
        media: kit.media,
        publishing: {
          status: { configured: !!kit.publishing, mode: kit.publishing?.mode ?? "dry_run", tenantPublishingEnabled: d.tenant.publishingEnabled, tenantPausedAt: d.tenant.pausedAt, globalPaused: d.global.paused },
          publications: d.publications,
          blocker: kit.publishing ? publishBlocker(d.item, d.integration) : "Publishing isn't configured on this server.",
          accountName: d.integration?.displayName ?? null,
          canSchedule: MANAGE.includes(ctx.role),
          defaultAt: defaultScheduleTime(d.item.publishAt),
        },
        ...(fl ? { flash: fl } : {}),
      }),
      status,
    );
  }

  router.get("/w/:tenantId/content/:itemId", async (req) => {
    const ctx = await workspace(req);
    return renderItem(ctx, idParam(req, "itemId"), flash(req));
  });

  /** Lock the item, run a state-machine transition, persist + audit — all in one transaction. */
  async function transitionItem(ctx: RouteCtx, itemId: string, build: (item: ContentItemRow, q: QueryClient) => Promise<Parameters<typeof transition>[1] | "stale" | "blocked">, extra?: (item: ContentItemRow, q: QueryClient) => Promise<void>): Promise<"ok" | "stale" | "blocked"> {
    try {
      return await ctx.tx(async (q) => {
        // Same lock order as the publisher: the live publication, then the item.
        const live = await lockLiveItemPublication(q, itemId);
        const item = await lockContentItem(q, itemId);
        if (!item) throw new HttpError(404, "Not found");
        const event = await build(item, q);
        if (event === "stale" || event === "blocked") return event;
        const { next, audit } = transition(await machineState(q, item), event, { type: "user", id: ctx.s.userId });
        await setContentState(q, itemId, next.state, next.pausedFrom);
        // Sent back, rejected or posted by hand: a queued send for it must not go out (or block rescheduling).
        if (live?.status === "queued" && next.state !== "scheduled") await updatePublication(q, live.id, { status: "cancelled", lastError: `Cancelled: ${audit.action.replace("content.", "").replace(/_/g, " ")}.` });
        if (extra) await extra(item, q);
        await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: audit.action, entityType: "content_item", entityId: itemId, before: audit.before, after: { ...audit.after, ...(audit.detail ?? {}) } });
        return "ok";
      });
    } catch (err) {
      if (err instanceof TransitionError) return "stale";
      throw err;
    }
  }

  router.post("/w/:tenantId/content/:itemId/edit", async (req) => {
    const ctx = await workspace(req);
    if (!EDIT.includes(ctx.role)) forbid();
    const itemId = idParam(req, "itemId");
    const baseHash = req.form.get("base_hash") ?? "";
    const result = await ctx.tx(async (q) => {
      const item = await lockContentItem(q, itemId);
      if (!item?.body) throw new HttpError(404, "Not found");
      if (item.contentHash !== baseHash || !["draft", "in_review", "approved"].includes(item.state)) return "stale" as const;
      const prev = item.body as PostDraft;
      const candidate = {
        ...prev,
        hook: (req.form.get("hook") ?? "").trim(),
        body: (req.form.get("body") ?? "").trim(),
        cta: (req.form.get("cta") ?? "").trim(),
        hashtags: (req.form.get("hashtags") ?? "").split(/[\s,]+/).map((h) => h.replace(/^#/, "")).filter(Boolean).slice(0, 30),
        ...(prev.creative_brief || prev.media?.length ? { alt_text: (req.form.get("alt_text") ?? "").trim() || null } : {}),
      };
      const r = await reviseItem(q, ctx, item, candidate, "content.edited");
      if (r !== "ok") return r;
      return "ok" as const;
    });
    return redirect(`/w/${ctx.tenantId}/content/${itemId}?m=${result === "ok" ? "edited" : result === "unchanged" ? "unchanged" : "stale"}`);
  });

  router.post("/w/:tenantId/content/:itemId/recheck", async (req) => {
    const ctx = await workspace(req);
    if (!EDIT.includes(ctx.role)) forbid();
    const itemId = idParam(req, "itemId");
    const item = await ctx.tx((q) => getContentItem(q, itemId));
    if (!item?.contentHash) throw new HttpError(404, "Not found");
    if (!kit.content.ai) throw new HttpError(400, "AI is not configured on this server.");
    if (item.state !== "draft") throw new HttpError(409, "Only drafts can be re-checked.");
    try {
      kit.jobs.enqueue(`recheck:${itemId}`, () => runRecheckJob(kit.content, { tenantId: ctx.tenantId, itemId, expectedHash: item.contentHash!, userId: ctx.s.userId }));
    } catch {
      throw new HttpError(503, "The server is busy. Try again in a few minutes.");
    }
    return redirect(`/w/${ctx.tenantId}/content/${itemId}?m=rechecking`);
  });

  router.post("/w/:tenantId/content/:itemId/submit", async (req) => {
    const ctx = await workspace(req);
    if (!EDIT.includes(ctx.role)) forbid();
    const itemId = idParam(req, "itemId");
    const r = await transitionItem(ctx, itemId, async (item) => (hasBlockers(item.findings as never) ? "blocked" : { type: "submit", findings: item.findings as never }));
    return redirect(`/w/${ctx.tenantId}/content/${itemId}?m=${r === "ok" ? "submitted" : r}`);
  });

  router.post("/w/:tenantId/content/:itemId/approve", async (req) => {
    const ctx = await workspace(req);
    const itemId = idParam(req, "itemId");
    const fingerprint = req.form.get("fingerprint") ?? "";
    const r = await approveOne(ctx, itemId, fingerprint, false);
    if (r === "forbidden") forbid("Your role can't approve this post.");
    return redirect(`/w/${ctx.tenantId}/content/${itemId}?m=${r === "ok" ? "approved" : r === "blocked" ? "blocked" : "stale"}`);
  });

  async function approveOne(ctx: RouteCtx, itemId: string, fingerprint: string, batch: boolean): Promise<"ok" | "stale" | "blocked" | "forbidden" | "high"> {
    const tenant = await ctx.tx((q) => getCurrentTenant(q));
    let denied: "forbidden" | "high" | null = null;
    const r = await transitionItem(
      ctx,
      itemId,
      async (item, q) => {
        if (!approverRoles(tenant!.automationMode, item.riskClass, await usesSensitiveClaims(q, item)).includes(ctx.role as Role)) {
          denied = "forbidden";
          return "stale";
        }
        if (batch && item.riskClass === "high") {
          denied = "high";
          return "stale";
        }
        if (!fingerprint || item.contentHash !== fingerprint) return "stale";
        if (hasBlockers(item.findings as never)) return "blocked";
        return { type: "approve", contentHash: item.contentHash };
      },
      async (item, q) => insertApproval(q, { tenantId: ctx.tenantId, itemId, revisionId: item.currentRevisionId!, contentHash: item.contentHash!, decision: "approved", decidedBy: ctx.s.userId, comment: null }),
    );
    return denied ?? r;
  }

  router.post("/w/:tenantId/content/:itemId/changes", async (req) => {
    const ctx = await workspace(req);
    const itemId = idParam(req, "itemId");
    const comment = (req.form.get("comment") ?? "").trim().slice(0, 2000);
    if (!comment) throw new HttpError(400, "Say what should change.");
    const tenant = await ctx.tx((q) => getCurrentTenant(q));
    let denied = false;
    const r = await transitionItem(
      ctx,
      itemId,
      async (item, q) => {
        if (!approverRoles(tenant!.automationMode, item.riskClass, await usesSensitiveClaims(q, item)).includes(ctx.role as Role)) {
          denied = true;
          return "stale";
        }
        return { type: "request_changes", reason: comment };
      },
      async (item, q) => insertApproval(q, { tenantId: ctx.tenantId, itemId, revisionId: item.currentRevisionId!, contentHash: item.contentHash!, decision: "changes_requested", decidedBy: ctx.s.userId, comment }),
    );
    if (denied) forbid("Your role can't review this post.");
    return redirect(`/w/${ctx.tenantId}/content/${itemId}?m=${r === "ok" ? "changes" : "stale"}`);
  });

  router.post("/w/:tenantId/content/:itemId/exported", async (req) => {
    const ctx = await workspace(req);
    if (!MANAGE.includes(ctx.role)) forbid();
    const itemId = idParam(req, "itemId");
    const r = await transitionItem(ctx, itemId, async () => ({ type: "mark_exported" }));
    return redirect(`/w/${ctx.tenantId}/content/${itemId}?m=${r === "ok" ? "exported" : "stale"}`);
  });

  // ------------------------------------------------------------------ approvals
  router.get("/w/:tenantId/approvals", async (req) => {
    const ctx = await workspace(req);
    const brandId = await brandOf(ctx);
    const { items, tenant } = await ctx.tx(async (q) => ({ items: await listContentItems(q, { brandId, states: ["in_review"] }), tenant: (await getCurrentTenant(q))! }));
    const fl = req.url.searchParams.get("m");
    const count = (k: string) => Math.max(0, Math.min(200, Number.parseInt(req.url.searchParams.get(k) ?? "0", 10) || 0));
    const n = count("n");
    const skipped = count("s");
    const message = fl === "batch" ? { kind: "ok" as const, message: `${n} approved.${skipped ? ` ${skipped} skipped (changed since you loaded the page, high risk, or not yours to approve).` : ""}` } : undefined;
    return htmlResponse(C.approvalsPage(await ctx.shell("approvals", "Approvals"), { items, canApprove: (risk) => approverRoles(tenant.automationMode, risk).includes(ctx.role as Role), flash: message }));
  });

  router.post("/w/:tenantId/approvals/batch", async (req) => {
    const ctx = await workspace(req);
    const picks = req.form.getAll("item").slice(0, 200);
    let ok = 0;
    let skipped = 0;
    for (const p of picks) {
      const [id, hash] = p.split(":");
      if (!id || !hash || !/^[0-9a-f-]{36}$/.test(id)) {
        skipped++;
        continue;
      }
      const r = await approveOne(ctx, id, hash, true);
      if (r === "ok") ok++;
      else skipped++;
    }
    return redirect(`/w/${ctx.tenantId}/approvals?m=batch&n=${ok}&s=${skipped}`);
  });

  // ------------------------------------------------------------------ export
  router.get("/w/:tenantId/export.csv", async (req) => {
    const ctx = await workspace(req);
    const brandId = await brandOf(ctx);
    const campaignId = req.url.searchParams.get("campaign");
    if (campaignId && !/^[0-9a-f-]{36}$/.test(campaignId)) throw new HttpError(400, "Bad campaign id");
    const items = await ctx.tx((q) => listContentItems(q, { brandId, states: ["approved"], ...(campaignId ? { campaignId } : {}) }));
    const header = ["publish_date", "publish_time", "time_zone", "channel", "caption", "link", "alt_text", "graphic_headline", "graphic_text", "image_subject", "post_id"];
    const rows = items.map((i) => {
      const p = i.body as PostDraft;
      const at = i.publishAt ? new Date(i.publishAt) : null;
      return [
        at ? localDate(at, TZ) : "",
        at ? at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "",
        TZ,
        C.CHANNEL_LABELS[i.channel] ?? i.channel,
        composeCaptionSafe(p),
        p.link?.url ?? "",
        p.alt_text ?? "",
        p.creative_brief?.headline ?? "",
        p.creative_brief?.supporting_text ?? "",
        p.creative_brief?.image_subject ?? "",
        i.id,
      ];
    });
    const body = [header, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(",")).join("\r\n") + "\r\n";
    return { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="approved-posts-${localDate(new Date(), TZ)}.csv"` }, body: "﻿" + body };
  });
}

/** The slot's time if it's still ahead, otherwise the next whole hour (local date + time strings). */
function defaultScheduleTime(publishAt: string | null): { date: string; time: string } {
  const now = Date.now();
  const at = publishAt && new Date(publishAt).getTime() > now + 5 * 60_000 ? new Date(publishAt) : new Date(Math.ceil((now + 60 * 60_000) / 3_600_000) * 3_600_000);
  return { date: localDate(at, TZ), time: at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) };
}

const composeCaptionSafe = (p: PostDraft): string => composeCaption(p);

function enqueueOrFail(kit: RouteKit, ctx: RouteCtx, runId: string, fn: () => Promise<void>): void {
  try {
    kit.jobs.enqueue(`work:${runId}`, fn);
  } catch {
    void ctx.tx(async (q) => {
      const { updateWorkRun } = await import("@jat/db");
      await updateWorkRun(q, runId, { status: "failed", error: "The server is busy. Try again in a few minutes.", finished: true });
    });
  }
}
