import type { QueryClient } from "./index.ts";

/**
 * Planning and content queries. Same conventions as store.ts: run inside a tenant-scoped
 * transaction, JSON parameters pre-serialized, results normalized across drivers.
 */
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

// ---------------------------------------------------------------------------
// Brand website + channel settings
// ---------------------------------------------------------------------------
export async function setBrandWebsite(tx: QueryClient, brandId: string, url: string | null): Promise<void> {
  await tx.query(`UPDATE brands SET website_url = $2 WHERE id = $1 RETURNING id`, [brandId, url]);
}

export async function getBrandWebsite(tx: QueryClient, brandId: string): Promise<string | null> {
  const { rows } = await tx.query<{ website_url: string | null }>(`SELECT website_url FROM brands WHERE id = $1`, [brandId]);
  return rows[0]?.website_url ?? null;
}

export interface ChannelSetting {
  channel: string;
  enabled: boolean;
  postsPerWeek: number;
}

export async function listChannelSettings(tx: QueryClient, brandId: string): Promise<ChannelSetting[]> {
  const { rows } = await tx.query<{ channel: string; enabled: boolean; posts_per_week: number }>(`SELECT channel, enabled, posts_per_week FROM channel_settings WHERE brand_id = $1 ORDER BY channel`, [brandId]);
  return rows.map((r) => ({ channel: r.channel, enabled: Boolean(r.enabled), postsPerWeek: Number(r.posts_per_week) }));
}

export async function upsertChannelSetting(tx: QueryClient, args: { tenantId: string; brandId: string; channel: string; enabled: boolean; postsPerWeek: number }): Promise<void> {
  await tx.query(
    `INSERT INTO channel_settings (tenant_id, brand_id, channel, enabled, posts_per_week) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (brand_id, channel) DO UPDATE SET enabled = EXCLUDED.enabled, posts_per_week = EXCLUDED.posts_per_week, updated_at = now()`,
    [args.tenantId, args.brandId, args.channel, args.enabled, args.postsPerWeek],
  );
}

// ---------------------------------------------------------------------------
// Work runs (planning / drafting jobs)
// ---------------------------------------------------------------------------
export interface WorkRun {
  id: string;
  brandId: string;
  kind: "plan" | "draft";
  campaignId: string | null;
  status: "queued" | "running" | "done" | "failed";
  input: Record<string, unknown>;
  progress: { done?: number; total?: number; failed?: number; message?: string };
  error: string | null;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
}

const WR_COLS = "id, brand_id, kind, campaign_id, status, input, progress, error, started_by, created_at, finished_at";
const wr = (r: Record<string, unknown>): WorkRun => ({
  id: r.id as string,
  brandId: r.brand_id as string,
  kind: r.kind as WorkRun["kind"],
  campaignId: (r.campaign_id as string | null) ?? null,
  status: r.status as WorkRun["status"],
  input: json(r.input),
  progress: json(r.progress),
  error: (r.error as string | null) ?? null,
  startedBy: r.started_by as string,
  createdAt: iso(r.created_at)!,
  finishedAt: iso(r.finished_at),
});

export async function createWorkRun(tx: QueryClient, args: { tenantId: string; brandId: string; kind: WorkRun["kind"]; campaignId?: string | null; input: Record<string, unknown>; startedBy: string }): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO work_runs (tenant_id, brand_id, kind, campaign_id, input, started_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
    [args.tenantId, args.brandId, args.kind, args.campaignId ?? null, JSON.stringify(args.input), args.startedBy],
  );
  return rows[0]!.id;
}

export async function getWorkRun(tx: QueryClient, id: string): Promise<WorkRun | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${WR_COLS} FROM work_runs WHERE id = $1`, [id]);
  return rows[0] ? wr(rows[0]) : null;
}

/** Minutes without a heartbeat after which a queued/running job is considered interrupted. */
export const STALE_RUN_MINUTES = 15;

export async function activeWorkRun(tx: QueryClient, brandId: string, kind: WorkRun["kind"]): Promise<WorkRun | null> {
  await tx.query(
    `UPDATE work_runs SET status = 'failed', error = 'Interrupted (the server restarted). Start it again.', finished_at = now()
     WHERE brand_id = $1 AND kind = $2 AND status IN ('queued', 'running') AND updated_at < now() - make_interval(mins => $3) RETURNING id`,
    [brandId, kind, STALE_RUN_MINUTES],
  );
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${WR_COLS} FROM work_runs WHERE brand_id = $1 AND kind = $2 AND status IN ('queued', 'running') LIMIT 1`, [brandId, kind]);
  return rows[0] ? wr(rows[0]) : null;
}

export async function listWorkRuns(tx: QueryClient, brandId: string, limit = 10): Promise<WorkRun[]> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${WR_COLS} FROM work_runs WHERE brand_id = $1 ORDER BY created_at DESC LIMIT $2`, [brandId, limit]);
  return rows.map(wr);
}

export async function updateWorkRun(tx: QueryClient, id: string, patch: { status?: WorkRun["status"]; progress?: WorkRun["progress"]; error?: string | null; campaignId?: string; finished?: boolean }): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.status) add("status", patch.status);
  if (patch.progress) add("progress", JSON.stringify(patch.progress), "::jsonb");
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.campaignId) add("campaign_id", patch.campaignId);
  if (patch.finished) sets.push("finished_at = now()");
  sets.push("updated_at = now()");
  await tx.query(`UPDATE work_runs SET ${sets.join(", ")} WHERE id = $1`, params);
}

// ---------------------------------------------------------------------------
// Campaigns and calendar slots
// ---------------------------------------------------------------------------
export interface CampaignRow {
  id: string;
  brandId: string;
  name: string;
  objective: string;
  description: string | null;
  startsOn: string;
  endsOn: string;
  status: "proposed" | "approved" | "active" | "completed" | "cancelled";
  dnaVersionId: string | null;
  planNotes: { assumptions?: string[]; risks?: string[]; goals?: string };
  createdAt: string;
}

const CAMP_COLS = "id, brand_id, name, objective, description, starts_on::text AS starts_on, ends_on::text AS ends_on, status, dna_version_id, plan_notes, created_at";
const camp = (r: Record<string, unknown>): CampaignRow => ({
  id: r.id as string,
  brandId: r.brand_id as string,
  name: r.name as string,
  objective: r.objective as string,
  description: (r.description as string | null) ?? null,
  startsOn: String(r.starts_on).slice(0, 10),
  endsOn: String(r.ends_on).slice(0, 10),
  status: r.status as CampaignRow["status"],
  dnaVersionId: (r.dna_version_id as string | null) ?? null,
  planNotes: json(r.plan_notes),
  createdAt: iso(r.created_at)!,
});

export async function insertCampaign(tx: QueryClient, a: { tenantId: string; brandId: string; name: string; objective: string; description: string; startsOn: string; endsOn: string; dnaVersionId: string; planNotes: CampaignRow["planNotes"] }): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO campaigns (tenant_id, brand_id, name, objective, description, starts_on, ends_on, dna_version_id, plan_notes) VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9::jsonb) RETURNING id`,
    [a.tenantId, a.brandId, a.name, a.objective, a.description, a.startsOn, a.endsOn, a.dnaVersionId, JSON.stringify(a.planNotes)],
  );
  return rows[0]!.id;
}

export async function listCampaigns(tx: QueryClient, brandId: string, limit = 50): Promise<CampaignRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${CAMP_COLS} FROM campaigns WHERE brand_id = $1 ORDER BY starts_on DESC, created_at DESC LIMIT $2`, [brandId, limit]);
  return rows.map(camp);
}

export async function getCampaign(tx: QueryClient, id: string): Promise<CampaignRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${CAMP_COLS} FROM campaigns WHERE id = $1`, [id]);
  return rows[0] ? camp(rows[0]) : null;
}

export async function setCampaignStatus(tx: QueryClient, id: string, from: CampaignRow["status"][], to: CampaignRow["status"]): Promise<boolean> {
  const { rows } = await tx.query(`UPDATE campaigns SET status = $2 WHERE id = $1 AND status = ANY(string_to_array($3, ',')) RETURNING id`, [id, to, from.join(",")]);
  return rows.length === 1;
}

export interface SlotRow {
  id: string;
  campaignId: string;
  channel: string;
  format: string;
  pillarId: string;
  personaId: string;
  objective: string;
  publishAt: string;
  delivery: "api" | "export";
  status: "planned" | "drafted" | "cancelled";
  topic: string;
  notes: string;
  offerClaimId: string | null;
  contentItemId: string | null;
  contentState: string | null;
}

const slot = (r: Record<string, unknown>): SlotRow => ({
  id: r.id as string,
  campaignId: r.campaign_id as string,
  channel: r.channel as string,
  format: r.format as string,
  pillarId: r.pillar_id as string,
  personaId: r.persona_id as string,
  objective: r.objective as string,
  publishAt: iso(r.publish_at)!,
  delivery: r.delivery as SlotRow["delivery"],
  status: r.status as SlotRow["status"],
  topic: r.topic as string,
  notes: r.notes as string,
  offerClaimId: (r.offer_claim_id as string | null) ?? null,
  contentItemId: (r.content_item_id as string | null) ?? null,
  contentState: (r.content_state as string | null) ?? null,
});

const SLOT_SELECT = `SELECT s.id, s.campaign_id, s.channel, s.format, s.pillar_id, s.persona_id, s.objective, s.publish_at, s.delivery, s.status, s.topic, s.notes, s.offer_claim_id,
  ci.id AS content_item_id, ci.state AS content_state
  FROM calendar_slots s LEFT JOIN content_items ci ON ci.slot_id = s.id`;

export async function insertSlot(tx: QueryClient, a: { tenantId: string; brandId: string; campaignId: string; channel: string; format: string; pillarId: string; personaId: string; objective: string; publishAt: string; topic: string; notes: string; offerClaimId: string | null }): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO calendar_slots (tenant_id, brand_id, campaign_id, channel, format, pillar_id, persona_id, objective, publish_at, delivery, topic, notes, offer_claim_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, 'export', $10, $11, $12) RETURNING id`,
    [a.tenantId, a.brandId, a.campaignId, a.channel, a.format, a.pillarId, a.personaId, a.objective, a.publishAt, a.topic, a.notes, a.offerClaimId],
  );
  return rows[0]!.id;
}

export async function listSlots(tx: QueryClient, args: { brandId: string; from: string; to: string; campaignId?: string }): Promise<SlotRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `${SLOT_SELECT} WHERE s.brand_id = $1 AND s.publish_at >= $2::timestamptz AND s.publish_at < $3::timestamptz AND ($4::uuid IS NULL OR s.campaign_id = $4::uuid) AND s.status <> 'cancelled'
     ORDER BY s.publish_at, s.channel LIMIT 1000`,
    [args.brandId, args.from, args.to, args.campaignId ?? null],
  );
  return rows.map(slot);
}

export async function listCampaignSlots(tx: QueryClient, campaignId: string): Promise<SlotRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(`${SLOT_SELECT} WHERE s.campaign_id = $1 AND s.status <> 'cancelled' ORDER BY s.publish_at, s.channel LIMIT 1000`, [campaignId]);
  return rows.map(slot);
}

export async function getSlot(tx: QueryClient, id: string): Promise<SlotRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`${SLOT_SELECT} WHERE s.id = $1`, [id]);
  return rows[0] ? slot(rows[0]) : null;
}

/** Lock a slot and return it only if it is still waiting to be drafted at the expected time. */
export async function claimSlotForDraft(tx: QueryClient, slotId: string, expectedPublishAt: string): Promise<boolean> {
  const { rows } = await tx.query<{ publish_at: string; status: string; has_item: boolean }>(
    `SELECT s.publish_at, s.status, EXISTS (SELECT 1 FROM content_items ci WHERE ci.slot_id = s.id) AS has_item FROM calendar_slots s WHERE s.id = $1 FOR UPDATE`,
    [slotId],
  );
  const r = rows[0];
  return !!r && r.status === "planned" && !r.has_item && new Date(r.publish_at).toISOString() === new Date(expectedPublishAt).toISOString();
}

export async function updateSlot(tx: QueryClient, id: string, patch: { publishAt?: string; topic?: string; status?: SlotRow["status"] }): Promise<boolean> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.publishAt) {
    params.push(patch.publishAt);
    sets.push(`publish_at = $${params.length}::timestamptz`);
  }
  if (patch.topic !== undefined) {
    params.push(patch.topic);
    sets.push(`topic = $${params.length}`);
  }
  if (patch.status) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
  }
  if (!sets.length) return false;
  const { rows } = await tx.query(`UPDATE calendar_slots SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, params);
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Content items, revisions, approvals
// ---------------------------------------------------------------------------
export type ContentStateName = "draft" | "in_review" | "approved" | "scheduled" | "publishing" | "published" | "exported" | "failed" | "paused" | "archived";

export interface ContentItemRow {
  id: string;
  brandId: string;
  slotId: string | null;
  channel: string;
  kind: string;
  state: ContentStateName;
  pausedFrom: ContentStateName | null;
  riskClass: "low" | "medium" | "high" | null;
  currentRevisionId: string | null;
  revision: number | null;
  body: unknown;
  contentHash: string | null;
  findings: Array<{ code: string; severity: string; message: string; span?: string; field?: string }>;
  review: { risk_class?: string; summary?: string; findings?: Array<{ code: string; severity: string; span: string; explanation: string; suggested_fix: string }> } | null;
  revisionCreatedBy: string | null;
  createdAt: string;
  publishAt: string | null;
  topic: string | null;
}

const ITEM_SELECT = `SELECT ci.id, ci.brand_id, ci.slot_id, ci.channel, ci.kind, ci.state, ci.paused_from, ci.risk_class, ci.current_revision_id, ci.created_at,
  r.revision, r.body, r.content_hash, r.findings, r.review, r.created_by AS revision_created_by, s.publish_at, s.topic
  FROM content_items ci
  LEFT JOIN content_revisions r ON r.id = ci.current_revision_id
  LEFT JOIN calendar_slots s ON s.id = ci.slot_id`;

const item = (r: Record<string, unknown>): ContentItemRow => ({
  id: r.id as string,
  brandId: r.brand_id as string,
  slotId: (r.slot_id as string | null) ?? null,
  channel: r.channel as string,
  kind: r.kind as string,
  state: r.state as ContentStateName,
  pausedFrom: (r.paused_from as ContentStateName | null) ?? null,
  riskClass: (r.risk_class as ContentItemRow["riskClass"]) ?? null,
  currentRevisionId: (r.current_revision_id as string | null) ?? null,
  revision: r.revision === null || r.revision === undefined ? null : Number(r.revision),
  body: r.body === null || r.body === undefined ? null : json(r.body),
  contentHash: (r.content_hash as string | null) ?? null,
  findings: r.findings ? json(r.findings) : [],
  review: r.review ? json(r.review) : null,
  revisionCreatedBy: (r.revision_created_by as string | null) ?? null,
  createdAt: iso(r.created_at)!,
  publishAt: iso(r.publish_at),
  topic: (r.topic as string | null) ?? null,
});

export async function createContentItem(tx: QueryClient, a: { tenantId: string; brandId: string; slotId: string | null; channel: string; kind: string }): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO content_items (tenant_id, brand_id, slot_id, channel, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [a.tenantId, a.brandId, a.slotId, a.channel, a.kind]);
  return rows[0]!.id;
}

/** Append a revision and make it current. Revisions are immutable (append-only by grant). */
export async function addRevision(tx: QueryClient, a: { tenantId: string; itemId: string; body: unknown; contentHash: string; findings: unknown[]; review: unknown | null; createdBy: string; riskClass: "low" | "medium" | "high" }): Promise<{ id: string; revision: number }> {
  const { rows } = await tx.query<{ id: string; revision: number }>(
    `INSERT INTO content_revisions (tenant_id, content_item_id, revision, body, content_hash, findings, review, created_by)
     VALUES ($1, $2, (SELECT COALESCE(MAX(revision), 0) + 1 FROM content_revisions WHERE content_item_id = $2), $3::jsonb, $4, $5::jsonb, $6::jsonb, $7)
     RETURNING id, revision`,
    [a.tenantId, a.itemId, JSON.stringify(a.body), a.contentHash, JSON.stringify(a.findings), a.review === null ? null : JSON.stringify(a.review), a.createdBy],
  );
  const rev = rows[0]!;
  await tx.query(`UPDATE content_items SET current_revision_id = $2, risk_class = $3 WHERE id = $1 RETURNING id`, [a.itemId, rev.id, a.riskClass]);
  return { id: rev.id, revision: Number(rev.revision) };
}

export async function getContentItem(tx: QueryClient, id: string): Promise<ContentItemRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`${ITEM_SELECT} WHERE ci.id = $1`, [id]);
  return rows[0] ? item(rows[0]) : null;
}

/** Row-lock the item for a state change; returns the fresh row. */
export async function lockContentItem(tx: QueryClient, id: string): Promise<ContentItemRow | null> {
  await tx.query(`SELECT id FROM content_items WHERE id = $1 FOR UPDATE`, [id]);
  return getContentItem(tx, id);
}

export async function listContentItems(tx: QueryClient, args: { brandId: string; states?: ContentStateName[]; campaignId?: string; limit?: number }): Promise<ContentItemRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `${ITEM_SELECT} WHERE ci.brand_id = $1 AND ($2::text IS NULL OR ci.state = ANY(string_to_array($2, ','))) AND ($3::uuid IS NULL OR s.campaign_id = $3::uuid)
     ORDER BY s.publish_at NULLS LAST, ci.created_at LIMIT $4`,
    [args.brandId, args.states?.length ? args.states.join(",") : null, args.campaignId ?? null, args.limit ?? 500],
  );
  return rows.map(item);
}

export async function setContentState(tx: QueryClient, id: string, state: ContentStateName, pausedFrom: ContentStateName | null): Promise<void> {
  await tx.query(`UPDATE content_items SET state = $2, paused_from = $3 WHERE id = $1 RETURNING id`, [id, state, pausedFrom]);
}

export interface ApprovalRow {
  id: string;
  revisionId: string;
  contentHash: string;
  decision: "approved" | "rejected" | "changes_requested";
  decidedBy: string | null;
  policyReason: string | null;
  comment: string | null;
  decidedAt: string;
}

export async function insertApproval(tx: QueryClient, a: { tenantId: string; itemId: string; revisionId: string; contentHash: string; decision: ApprovalRow["decision"]; decidedBy: string; comment: string | null }): Promise<void> {
  await tx.query(
    `INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision, decided_by, comment) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [a.tenantId, a.itemId, a.revisionId, a.contentHash, a.decision, a.decidedBy, a.comment],
  );
}

export async function listApprovals(tx: QueryClient, itemId: string): Promise<ApprovalRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT id, revision_id, content_hash, decision, decided_by, policy_reason, comment, decided_at FROM approvals WHERE content_item_id = $1 ORDER BY decided_at DESC LIMIT 100`,
    [itemId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    revisionId: r.revision_id as string,
    contentHash: r.content_hash as string,
    decision: r.decision as ApprovalRow["decision"],
    decidedBy: (r.decided_by as string | null) ?? null,
    policyReason: (r.policy_reason as string | null) ?? null,
    comment: (r.comment as string | null) ?? null,
    decidedAt: iso(r.decided_at)!,
  }));
}

/** Hooks used by recent posts of this brand (for repetition checks). */
export async function recentHooks(tx: QueryClient, brandId: string, days = 60): Promise<string[]> {
  const { rows } = await tx.query<{ hook: string | null }>(
    `SELECT r.body->>'hook' AS hook FROM content_items ci JOIN content_revisions r ON r.id = ci.current_revision_id
     WHERE ci.brand_id = $1 AND ci.created_at > now() - make_interval(days => $2) LIMIT 500`,
    [brandId, days],
  );
  return rows.map((r) => r.hook).filter((h): h is string => !!h);
}
