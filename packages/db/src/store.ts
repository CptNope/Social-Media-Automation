import type { QueryClient } from "./index.ts";

/**
 * Typed queries used by the web app and workers. Every function expects to run inside
 * `withTenant`/`inTenant` (or `inUser` where noted) so RLS scopes the rows; tenant ids
 * are still passed explicitly on writes because the WITH CHECK policies verify them.
 *
 * Results are normalized (numbers, ISO date strings) so behaviour is identical across
 * Postgres drivers. JSON parameters are always passed pre-serialized (node-postgres would
 * otherwise encode JS arrays as Postgres array literals, e.g. [] → '{}').
 */

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

// ---------------------------------------------------------------------------
// Users, workspaces, memberships
// ---------------------------------------------------------------------------
export type MemberRole = "agency_operator" | "client_owner" | "client_editor" | "reviewer";

export interface Workspace {
  tenantId: string;
  name: string;
  slug: string;
  role: MemberRole;
}

/** inUser: workspaces the signed-in user belongs to. */
export async function listWorkspaces(tx: QueryClient, userId: string): Promise<Workspace[]> {
  const { rows } = await tx.query<{ tenant_id: string; name: string; slug: string; role: MemberRole }>(
    `SELECT m.tenant_id, t.name, t.slug, m.role FROM memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1 ORDER BY t.name`,
    [userId],
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, name: r.name, slug: r.slug, role: r.role }));
}

/** The user's role in the current tenant, or null if not a member. */
export async function currentRole(tx: QueryClient, userId: string): Promise<MemberRole | null> {
  const { rows } = await tx.query<{ role: MemberRole }>(
    `SELECT role FROM memberships WHERE user_id = $1 AND tenant_id = app_current_tenant()`,
    [userId],
  );
  return rows[0]?.role ?? null;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  sessionEpoch: number;
}

export async function getUser(tx: QueryClient, userId: string): Promise<UserRow | null> {
  const { rows } = await tx.query<{ id: string; email: string; name: string | null; session_epoch: number }>(`SELECT id, email, name, session_epoch FROM users WHERE id = $1`, [userId]);
  const r = rows[0];
  return r ? { id: r.id, email: r.email, name: r.name, sessionEpoch: Number(r.session_epoch) } : null;
}

/** inUser: revoke every existing session for the signed-in user ("sign out everywhere"). */
export async function bumpSessionEpoch(tx: QueryClient, userId: string): Promise<void> {
  await tx.query(`UPDATE users SET session_epoch = session_epoch + 1 WHERE id = $1 AND id = app_current_user()`, [userId]);
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  automationMode: "manual" | "assisted" | "autonomous";
  publishingEnabled: boolean;
  pausedAt: string | null;
  monthlyAiBudgetCents: number;
}

export async function getCurrentTenant(tx: QueryClient): Promise<TenantRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT id, name, slug, automation_mode, publishing_enabled, paused_at, monthly_ai_budget_cents FROM tenants WHERE id = app_current_tenant()`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    automationMode: r.automation_mode as TenantRow["automationMode"],
    publishingEnabled: Boolean(r.publishing_enabled),
    pausedAt: iso(r.paused_at),
    monthlyAiBudgetCents: Number(r.monthly_ai_budget_cents),
  };
}

// ---------------------------------------------------------------------------
// Auth (inAnonymous): only the SECURITY DEFINER functions are reachable
// ---------------------------------------------------------------------------
export async function issueLoginToken(tx: QueryClient, email: string, tokenHash: string, ttlMinutes: number): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(`SELECT issue_login_token($1, $2, $3) AS ok`, [email, tokenHash, ttlMinutes]);
  return Boolean(rows[0]?.ok);
}

export async function consumeLoginToken(tx: QueryClient, tokenHash: string): Promise<string | null> {
  const { rows } = await tx.query<{ user_id: string | null }>(`SELECT consume_login_token($1) AS user_id`, [tokenHash]);
  return rows[0]?.user_id ?? null;
}

// ---------------------------------------------------------------------------
// Brands and Brand DNA versions
// ---------------------------------------------------------------------------
export interface BrandRow {
  id: string;
  name: string;
  activeDnaVersionId: string | null;
}

export async function listBrands(tx: QueryClient): Promise<BrandRow[]> {
  const { rows } = await tx.query<{ id: string; name: string; active_dna_version_id: string | null }>(`SELECT id, name, active_dna_version_id FROM brands ORDER BY created_at`);
  return rows.map((r) => ({ id: r.id, name: r.name, activeDnaVersionId: r.active_dna_version_id }));
}

export async function getBrand(tx: QueryClient, brandId: string): Promise<BrandRow | null> {
  const { rows } = await tx.query<{ id: string; name: string; active_dna_version_id: string | null }>(`SELECT id, name, active_dna_version_id FROM brands WHERE id = $1`, [brandId]);
  const r = rows[0];
  return r ? { id: r.id, name: r.name, activeDnaVersionId: r.active_dna_version_id } : null;
}

export async function createBrand(tx: QueryClient, tenantId: string, name: string): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO brands (tenant_id, name) VALUES ($1, $2) RETURNING id`, [tenantId, name]);
  return rows[0]!.id;
}

export type DnaStatus = "proposed" | "active" | "superseded" | "rejected";

export interface DnaVersionSummary {
  id: string;
  brandId: string;
  version: number;
  status: DnaStatus;
  createdBy: string;
  createdAt: string;
  approvedAt: string | null;
}

export interface DnaVersion extends DnaVersionSummary {
  data: unknown;
  approvedBy: string | null;
}

export async function listDnaVersions(tx: QueryClient, brandId: string, limit = 50): Promise<DnaVersionSummary[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT id, brand_id, version, status, created_by, created_at, approved_at FROM brand_dna_versions WHERE brand_id = $1 ORDER BY version DESC LIMIT $2`,
    [brandId, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    brandId: r.brand_id as string,
    version: Number(r.version),
    status: r.status as DnaStatus,
    createdBy: r.created_by as string,
    createdAt: iso(r.created_at)!,
    approvedAt: iso(r.approved_at),
  }));
}

export async function getDnaVersion(tx: QueryClient, versionId: string): Promise<DnaVersion | null> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT id, brand_id, version, status, data, created_by, created_at, approved_by, approved_at FROM brand_dna_versions WHERE id = $1`,
    [versionId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    brandId: r.brand_id as string,
    version: Number(r.version),
    status: r.status as DnaStatus,
    data: json(r.data),
    createdBy: r.created_by as string,
    createdAt: iso(r.created_at)!,
    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: iso(r.approved_at),
  };
}

export async function insertProposedDna(tx: QueryClient, args: { tenantId: string; brandId: string; data: unknown; createdBy: string }): Promise<{ id: string; version: number }> {
  const { rows } = await tx.query<{ id: string; version: number }>(
    `INSERT INTO brand_dna_versions (tenant_id, brand_id, version, status, data, created_by)
     VALUES ($1, $2, (SELECT COALESCE(MAX(version), 0) + 1 FROM brand_dna_versions WHERE brand_id = $2), 'proposed', $3::jsonb, $4)
     RETURNING id, version`,
    [args.tenantId, args.brandId, JSON.stringify(args.data), args.createdBy],
  );
  return { id: rows[0]!.id, version: Number(rows[0]!.version) };
}

/** Only proposed versions can change. Returns false if the version is no longer proposed. */
export async function updateProposedDna(tx: QueryClient, versionId: string, data: unknown): Promise<boolean> {
  const { rows } = await tx.query(`UPDATE brand_dna_versions SET data = $2::jsonb WHERE id = $1 AND status = 'proposed' RETURNING id`, [versionId, JSON.stringify(data)]);
  return rows.length === 1;
}

export async function rejectProposedDna(tx: QueryClient, versionId: string): Promise<boolean> {
  const { rows } = await tx.query(`UPDATE brand_dna_versions SET status = 'rejected' WHERE id = $1 AND status = 'proposed' RETURNING id`, [versionId]);
  return rows.length === 1;
}

/** Lock a version row for the rest of the transaction and return its current status and data. */
export async function lockDnaVersion(tx: QueryClient, versionId: string): Promise<{ brandId: string; status: DnaStatus; version: number; data: unknown } | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT brand_id, status, version, data FROM brand_dna_versions WHERE id = $1 FOR UPDATE`, [versionId]);
  const r = rows[0];
  return r ? { brandId: r.brand_id as string, status: r.status as DnaStatus, version: Number(r.version), data: json(r.data) } : null;
}

export class StaleVersionError extends Error {}

/**
 * Supersede the current active version and activate this proposed one. Call inside one
 * transaction, after `lockDnaVersion` has confirmed the version is still proposed (that
 * row lock is what stops a concurrent reject or edit from slipping in between).
 * Throws StaleVersionError (so the caller's transaction rolls back) if anything changed.
 */
export async function activateDna(tx: QueryClient, args: { brandId: string; versionId: string; userId: string }): Promise<void> {
  await tx.query(`SELECT id FROM brands WHERE id = $1 FOR UPDATE`, [args.brandId]);
  await tx.query(`UPDATE brand_dna_versions SET status = 'superseded' WHERE brand_id = $1 AND status = 'active' AND id <> $2`, [args.brandId, args.versionId]);
  const activated = await tx.query(
    `UPDATE brand_dna_versions SET status = 'active', approved_by = $3, approved_at = now() WHERE id = $1 AND brand_id = $2 AND status = 'proposed' RETURNING id`,
    [args.versionId, args.brandId, args.userId],
  );
  if (activated.rows.length !== 1) throw new StaleVersionError("Version is no longer proposed");
  await tx.query(`UPDATE brands SET active_dna_version_id = $2 WHERE id = $1 RETURNING id`, [args.brandId, args.versionId]);
}

// ---------------------------------------------------------------------------
// Evidence sources
// ---------------------------------------------------------------------------
export interface SourceInput {
  evidenceId: string;
  kind: "url" | "pdf" | "image" | "note" | "social_profile" | "report";
  uri: string;
  text: string;
}

/** Evidence is immutable and scoped to the onboarding run that collected it. */
export async function insertSources(tx: QueryClient, tenantId: string, brandId: string, runId: string, sources: readonly SourceInput[]): Promise<void> {
  for (const s of sources) {
    await tx.query(
      `INSERT INTO sources (tenant_id, brand_id, onboarding_run_id, kind, uri, evidence_id, extracted_text) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [tenantId, brandId, runId, s.kind, s.uri, s.evidenceId, s.text],
    );
  }
}

/** Evidence ids available to a Brand DNA version: those collected by the run that produced it. */
export async function listSourceIds(tx: QueryClient, brandId: string, runId: string | null): Promise<Array<{ evidenceId: string; uri: string; kind: string }>> {
  const { rows } = await tx.query<{ evidence_id: string; uri: string; kind: string }>(
    `SELECT evidence_id, uri, kind FROM sources WHERE brand_id = $1 AND onboarding_run_id IS NOT DISTINCT FROM $2::uuid ORDER BY evidence_id LIMIT 500`,
    [brandId, runId],
  );
  return rows.map((r) => ({ evidenceId: r.evidence_id, uri: r.uri, kind: r.kind }));
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------
export interface ClaimEvidence {
  kind: "document" | "url" | "license_lookup" | "operator_attestation" | "customer_consent";
  reference: string;
  captured_at: string;
  note?: string;
}

export interface ClaimRow {
  id: string;
  text: string;
  category: string;
  status: "pending" | "verified" | "expired" | "rejected";
  evidence: ClaimEvidence[];
  verifiedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export async function listClaims(tx: QueryClient, brandId: string): Promise<ClaimRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT id, text, category, status, evidence, verified_by, expires_at, created_at FROM claims WHERE brand_id = $1 ORDER BY status, created_at DESC LIMIT 500`,
    [brandId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    text: r.text as string,
    category: r.category as string,
    status: r.status as ClaimRow["status"],
    evidence: json<ClaimEvidence[]>(r.evidence),
    verifiedBy: (r.verified_by as string | null) ?? null,
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at)!,
  }));
}

export async function insertClaim(tx: QueryClient, args: { tenantId: string; brandId: string; text: string; category: string; evidence: ClaimEvidence[]; expiresAt?: string | null }): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO claims (tenant_id, brand_id, text, category, evidence, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
    [args.tenantId, args.brandId, args.text, args.category, JSON.stringify(args.evidence), args.expiresAt ?? null],
  );
  return rows[0]!.id;
}

export async function setClaimStatus(tx: QueryClient, args: { claimId: string; status: "verified" | "rejected"; userId: string }): Promise<boolean> {
  const { rows } = await tx.query(
    args.status === "verified"
      ? `UPDATE claims SET status = 'verified', verified_by = $2 WHERE id = $1 AND status IN ('pending', 'expired') RETURNING id`
      : `UPDATE claims SET status = 'rejected' WHERE id = $1 AND status IN ('pending', 'verified', 'expired') AND $2::uuid IS NOT NULL RETURNING id`,
    [args.claimId, args.userId],
  );
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// Onboarding runs
// ---------------------------------------------------------------------------
export type RunStatus = "queued" | "crawling" | "extracting" | "ready" | "failed";

export interface OnboardingRun {
  id: string;
  brandId: string;
  status: RunStatus;
  websiteUrl: string | null;
  business: Record<string, unknown>;
  startedBy: string;
  dnaVersionId: string | null;
  findings: Array<{ code: string; severity: string; message: string; field?: string; span?: string }>;
  conflicts: Array<{ path: string; description: string; sources: string[] }>;
  missingInfo: string[];
  crawlSummary: Record<string, unknown>;
  costMicros: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

function runFromRow(r: Record<string, unknown>): OnboardingRun {
  return {
    id: r.id as string,
    brandId: r.brand_id as string,
    status: r.status as RunStatus,
    websiteUrl: (r.website_url as string | null) ?? null,
    business: json(r.business),
    startedBy: r.started_by as string,
    dnaVersionId: (r.dna_version_id as string | null) ?? null,
    findings: json(r.findings),
    conflicts: json(r.conflicts),
    missingInfo: json(r.missing_info),
    crawlSummary: json(r.crawl_summary),
    costMicros: Number(r.cost_micros),
    error: (r.error as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    finishedAt: iso(r.finished_at),
  };
}

const RUN_COLS = `id, brand_id, status, website_url, business, started_by, dna_version_id, findings, conflicts, missing_info, crawl_summary, cost_micros, error, created_at, finished_at`;

/** The brand's queued/crawling/extracting run, if any (at most one; enforced by a unique index). */
export async function activeOnboardingRun(tx: QueryClient, brandId: string): Promise<OnboardingRun | null> {
  await tx.query(
    `UPDATE onboarding_runs SET status = 'failed', error = 'Interrupted (the server restarted). Start it again.', finished_at = now()
     WHERE brand_id = $1 AND status IN ('queued', 'crawling', 'extracting') AND updated_at < now() - interval '15 minutes' RETURNING id`,
    [brandId],
  );
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${RUN_COLS} FROM onboarding_runs WHERE brand_id = $1 AND status IN ('queued', 'crawling', 'extracting') LIMIT 1`, [brandId]);
  return rows[0] ? runFromRow(rows[0]) : null;
}

export async function createOnboardingRun(tx: QueryClient, args: { tenantId: string; brandId: string; websiteUrl: string | null; business: Record<string, unknown>; startedBy: string }): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO onboarding_runs (tenant_id, brand_id, website_url, business, started_by) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [args.tenantId, args.brandId, args.websiteUrl, JSON.stringify(args.business), args.startedBy],
  );
  return rows[0]!.id;
}

export async function getOnboardingRun(tx: QueryClient, runId: string): Promise<OnboardingRun | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${RUN_COLS} FROM onboarding_runs WHERE id = $1`, [runId]);
  return rows[0] ? runFromRow(rows[0]) : null;
}

export async function listOnboardingRuns(tx: QueryClient, brandId: string, limit = 10): Promise<OnboardingRun[]> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${RUN_COLS} FROM onboarding_runs WHERE brand_id = $1 ORDER BY created_at DESC LIMIT $2`, [brandId, limit]);
  return rows.map(runFromRow);
}

export async function runForVersion(tx: QueryClient, versionId: string): Promise<OnboardingRun | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${RUN_COLS} FROM onboarding_runs WHERE dna_version_id = $1 ORDER BY created_at DESC LIMIT 1`, [versionId]);
  return rows[0] ? runFromRow(rows[0]) : null;
}

export async function updateOnboardingRun(
  tx: QueryClient,
  runId: string,
  patch: Partial<Pick<OnboardingRun, "status" | "dnaVersionId" | "findings" | "conflicts" | "missingInfo" | "crawlSummary" | "costMicros" | "error">> & { finished?: boolean },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [runId];
  const add = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.status) add("status", patch.status);
  if (patch.dnaVersionId !== undefined) add("dna_version_id", patch.dnaVersionId);
  if (patch.findings) add("findings", JSON.stringify(patch.findings), "::jsonb");
  if (patch.conflicts) add("conflicts", JSON.stringify(patch.conflicts), "::jsonb");
  if (patch.missingInfo) add("missing_info", JSON.stringify(patch.missingInfo), "::jsonb");
  if (patch.crawlSummary) add("crawl_summary", JSON.stringify(patch.crawlSummary), "::jsonb");
  if (patch.costMicros !== undefined) add("cost_micros", patch.costMicros);
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.finished) sets.push("finished_at = now()");
  sets.push("updated_at = now()");
  await tx.query(`UPDATE onboarding_runs SET ${sets.join(", ")} WHERE id = $1`, params);
}

// ---------------------------------------------------------------------------
// Audit (read)
// ---------------------------------------------------------------------------
export interface AuditRow {
  id: number;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
}

export async function recentAudit(tx: QueryClient, limit = 20): Promise<AuditRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT id, actor_type, actor_id, action, entity_type, entity_id, created_at FROM audit_log WHERE tenant_id = app_current_tenant() ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    actorType: r.actor_type as string,
    actorId: r.actor_id as string,
    action: r.action as string,
    entityType: r.entity_type as string,
    entityId: r.entity_id as string,
    createdAt: iso(r.created_at)!,
  }));
}
