import type { QueryClient } from "./index.ts";

/** Integrations, credentials, publications and pause switches. Same conventions as store.ts. */
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const json = <T>(v: unknown): T => (typeof v === "string" ? (JSON.parse(v) as T) : (v as T));

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
export interface IntegrationRow {
  id: string;
  channel: string;
  externalAccountId: string;
  displayName: string;
  status: "connected" | "needs_reauth" | "revoked" | "error";
  channelPaused: boolean;
  capabilities: Record<string, unknown>;
  tokenExpiresAt: string | null;
  lastHealthCheckAt: string | null;
  createdAt: string;
}

const INT_COLS = "id, channel, external_account_id, display_name, status, channel_paused, capabilities, token_expires_at, last_health_check_at, created_at";
const intg = (r: Record<string, unknown>): IntegrationRow => ({
  id: r.id as string,
  channel: r.channel as string,
  externalAccountId: r.external_account_id as string,
  displayName: r.display_name as string,
  status: r.status as IntegrationRow["status"],
  channelPaused: Boolean(r.channel_paused),
  capabilities: json(r.capabilities),
  tokenExpiresAt: iso(r.token_expires_at),
  lastHealthCheckAt: iso(r.last_health_check_at),
  createdAt: iso(r.created_at)!,
});

export async function listIntegrations(tx: QueryClient): Promise<IntegrationRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${INT_COLS} FROM integrations WHERE status <> 'revoked' ORDER BY channel`);
  return rows.map(intg);
}

export async function getIntegration(tx: QueryClient, id: string): Promise<IntegrationRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${INT_COLS} FROM integrations WHERE id = $1`, [id]);
  return rows[0] ? intg(rows[0]) : null;
}

export async function integrationForChannel(tx: QueryClient, channel: string): Promise<IntegrationRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${INT_COLS} FROM integrations WHERE channel = $1 AND status <> 'revoked' LIMIT 1`, [channel]);
  return rows[0] ? intg(rows[0]) : null;
}

/**
 * Connect an account: revokes any other account on the same channel (one per channel), then
 * inserts the integration or revives a previously revoked row for the same account.
 */
export async function upsertIntegration(tx: QueryClient, a: { tenantId: string; channel: string; externalAccountId: string; displayName: string; capabilities: Record<string, unknown>; scopes: string[]; status?: IntegrationRow["status"]; tokenExpiresAt?: string | null }): Promise<string> {
  const { rows: others } = await tx.query<{ id: string }>(`SELECT id FROM integrations WHERE channel = $1 AND external_account_id <> $2 AND status <> 'revoked' FOR UPDATE`, [a.channel, a.externalAccountId]);
  for (const o of others) {
    await tx.query(`SELECT remove_credential($1)`, [o.id]);
    await tx.query(`UPDATE integrations SET status = 'revoked', check_requested_at = NULL WHERE id = $1 RETURNING id`, [o.id]);
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO integrations (tenant_id, channel, external_account_id, display_name, capabilities, scopes, status, token_expires_at, last_health_check_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, string_to_array($6, ','), $7, $8::timestamptz, now())
     ON CONFLICT (tenant_id, channel, external_account_id) DO UPDATE
       SET display_name = EXCLUDED.display_name, capabilities = EXCLUDED.capabilities, scopes = EXCLUDED.scopes,
           status = EXCLUDED.status, token_expires_at = EXCLUDED.token_expires_at, last_health_check_at = now()  -- a channel pause survives reconnecting
     RETURNING id`,
    [a.tenantId, a.channel, a.externalAccountId, a.displayName, JSON.stringify(a.capabilities), a.scopes.join(","), a.status ?? "connected", a.tokenExpiresAt ?? null],
  );
  return rows[0]!.id;
}

export async function setIntegrationStatus(tx: QueryClient, id: string, status: IntegrationRow["status"]): Promise<void> {
  await tx.query(`UPDATE integrations SET status = $2, check_requested_at = CASE WHEN $2 = 'revoked' THEN NULL ELSE check_requested_at END WHERE id = $1 RETURNING id`, [id, status]);
}

/** Publisher: lock a connection while its token is refreshed (serializes rotating refresh tokens). */
export async function lockIntegration(tx: QueryClient, id: string): Promise<IntegrationRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${INT_COLS} FROM integrations WHERE id = $1 FOR UPDATE`, [id]);
  return rows[0] ? intg(rows[0]) : null;
}

export async function setTokenExpiry(tx: QueryClient, id: string, at: string | null): Promise<void> {
  await tx.query(`UPDATE integrations SET token_expires_at = $2::timestamptz WHERE id = $1 RETURNING id`, [id, at]);
}

/** Publisher: connections whose access token expires before `before`, across tenants (ids only). */
export async function findExpiringTokens(tx: QueryClient, before: Date, channels: readonly string[], limit = 50): Promise<Array<{ id: string; tenantId: string; channel: string }>> {
  if (!channels.length) return [];
  await tx.query("SET LOCAL ROLE jat_scheduler");
  // Filtered by channel in SQL: idle short-lived tokens (X, Google) must never crowd out the ones that need keeping alive.
  const { rows } = await tx.query<{ id: string; tenant_id: string; channel: string }>(
    `SELECT id, tenant_id, channel FROM integrations WHERE status = 'connected' AND token_expires_at IS NOT NULL AND token_expires_at < $1::timestamptz AND channel = ANY(string_to_array($2, ',')) ORDER BY token_expires_at LIMIT $3`,
    [before.toISOString(), channels.join(","), limit],
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, channel: r.channel }));
}

/** Web tier: ask the publisher worker to test this connection. */
export async function requestIntegrationCheck(tx: QueryClient, id: string): Promise<void> {
  await tx.query(`UPDATE integrations SET check_requested_at = now() WHERE id = $1 AND status <> 'revoked' RETURNING id`, [id]);
}

/** Publisher: connections waiting for a check, across tenants (ids only, via jat_scheduler). */
export async function findRequestedChecks(tx: QueryClient, limit = 20): Promise<Array<{ id: string; tenantId: string }>> {
  await tx.query("SET LOCAL ROLE jat_scheduler");
  const { rows } = await tx.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM integrations WHERE check_requested_at IS NOT NULL AND status <> 'revoked' ORDER BY check_requested_at LIMIT $1`, [limit]);
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id }));
}

export async function clearCheckRequest(tx: QueryClient, id: string): Promise<void> {
  await tx.query(`UPDATE integrations SET check_requested_at = NULL WHERE id = $1 RETURNING id`, [id]);
}

export async function markIntegrationChecked(tx: QueryClient, id: string, displayName: string): Promise<void> {
  await tx.query(`UPDATE integrations SET last_health_check_at = now(), display_name = $2, status = 'connected' WHERE id = $1 RETURNING id`, [id, displayName]);
}

export async function setChannelPaused(tx: QueryClient, id: string, paused: boolean): Promise<void> {
  await tx.query(`UPDATE integrations SET channel_paused = $2 WHERE id = $1 RETURNING id`, [id, paused]);
}

// ---------------------------------------------------------------------------
// Credentials (web tier: insert + remove only; publisher role: read)
// ---------------------------------------------------------------------------
export interface CredentialRecord {
  version: 1;
  kekId: string;
  wrappedDek: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export async function insertCredential(tx: QueryClient, tenantId: string, integrationId: string, rec: CredentialRecord): Promise<void> {
  await tx.query(`SELECT remove_credential($1)`, [integrationId]);
  await tx.query(
    `INSERT INTO credentials (integration_id, tenant_id, version, kek_id, wrapped_dek, iv, auth_tag, ciphertext) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [integrationId, tenantId, rec.version, rec.kekId, rec.wrappedDek, rec.iv, rec.authTag, rec.ciphertext],
  );
}

export async function removeCredential(tx: QueryClient, integrationId: string): Promise<void> {
  await tx.query(`SELECT remove_credential($1)`, [integrationId]);
}

/** Publisher role only: replace a credential after a token refresh. */
export async function updateCredential(tx: QueryClient, integrationId: string, rec: CredentialRecord): Promise<void> {
  const { rows } = await tx.query<{ integration_id: string }>(
    `UPDATE credentials SET version = $2, kek_id = $3, wrapped_dek = $4, iv = $5, auth_tag = $6, ciphertext = $7, rotated_at = now() WHERE integration_id = $1 RETURNING integration_id`,
    [integrationId, rec.version, rec.kekId, rec.wrappedDek, rec.iv, rec.authTag, rec.ciphertext],
  );
  if (!rows.length) throw new Error("credential not found");
}

/** Publisher role only (the web role has no SELECT on credentials). */
export async function readCredential(tx: QueryClient, integrationId: string): Promise<CredentialRecord | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT version, kek_id, wrapped_dek, iv, auth_tag, ciphertext FROM credentials WHERE integration_id = $1`, [integrationId]);
  const r = rows[0];
  return r ? { version: 1, kekId: r.kek_id as string, wrappedDek: r.wrapped_dek as string, iv: r.iv as string, authTag: r.auth_tag as string, ciphertext: r.ciphertext as string } : null;
}

// ---------------------------------------------------------------------------
// Pause switches
// ---------------------------------------------------------------------------
export async function setTenantPaused(tx: QueryClient, paused: boolean, reason: string | null): Promise<void> {
  await tx.query(`UPDATE tenants SET paused_at = $1::timestamptz, paused_reason = $2 WHERE id = app_current_tenant() RETURNING id`, [paused ? new Date().toISOString() : null, paused ? reason : null]);
}

export async function globalPause(tx: QueryClient): Promise<{ paused: boolean; reason: string | null }> {
  const { rows } = await tx.query<{ global_paused: boolean; paused_reason: string | null }>(`SELECT global_paused, paused_reason FROM platform_settings LIMIT 1`);
  return { paused: Boolean(rows[0]?.global_paused), reason: rows[0]?.paused_reason ?? null };
}

// ---------------------------------------------------------------------------
// Publications
// ---------------------------------------------------------------------------
export type PublicationStatus = "queued" | "publishing" | "published" | "failed" | "needs_attention" | "exported" | "deleted" | "dry_run" | "cancelled";

export interface PublicationRow {
  id: string;
  contentItemId: string;
  revisionId: string;
  integrationId: string | null;
  idempotencyKey: string;
  status: PublicationStatus;
  externalId: string | null;
  permalink: string | null;
  attempts: number;
  lastError: string | null;
  note: string | null;
  scheduledFor: string | null;
  nextAttemptAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  channel?: string;
  hook?: string | null;
}

const PUB_COLS = "p.id, p.content_item_id, p.revision_id, p.integration_id, p.idempotency_key, p.status, p.external_id, p.permalink, p.attempts, p.last_error, p.note, p.scheduled_for, p.next_attempt_at, p.published_at, p.created_at, p.updated_at";
const pub = (r: Record<string, unknown>): PublicationRow => ({
  id: r.id as string,
  contentItemId: r.content_item_id as string,
  revisionId: r.revision_id as string,
  integrationId: (r.integration_id as string | null) ?? null,
  idempotencyKey: r.idempotency_key as string,
  status: r.status as PublicationStatus,
  externalId: (r.external_id as string | null) ?? null,
  permalink: (r.permalink as string | null) ?? null,
  attempts: Number(r.attempts),
  lastError: (r.last_error as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  scheduledFor: iso(r.scheduled_for),
  nextAttemptAt: iso(r.next_attempt_at),
  publishedAt: iso(r.published_at),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  ...(r.channel ? { channel: r.channel as string } : {}),
  ...(r.hook !== undefined ? { hook: (r.hook as string | null) ?? null } : {}),
});

export async function createPublication(tx: QueryClient, a: { tenantId: string; itemId: string; revisionId: string; integrationId: string; scheduledFor: string; createdBy: string }): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO publications (tenant_id, content_item_id, revision_id, integration_id, idempotency_key, status, scheduled_for, created_by)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, 'queued', $5::timestamptz, $6) RETURNING id`,
    [a.tenantId, a.itemId, a.revisionId, a.integrationId, a.scheduledFor, a.createdBy],
  );
  return rows[0]!.id;
}

export async function listItemPublications(tx: QueryClient, itemId: string): Promise<PublicationRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${PUB_COLS} FROM publications p WHERE p.content_item_id = $1 ORDER BY p.created_at DESC LIMIT 50`, [itemId]);
  return rows.map(pub);
}

export async function listRecentPublications(tx: QueryClient, limit = 30): Promise<PublicationRow[]> {
  const { rows } = await tx.query<Record<string, unknown>>(
    `SELECT ${PUB_COLS}, ci.channel, r.body->>'hook' AS hook FROM publications p JOIN content_items ci ON ci.id = p.content_item_id JOIN content_revisions r ON r.id = p.revision_id
     ORDER BY COALESCE(p.published_at, p.scheduled_for, p.created_at) DESC LIMIT $1`,
    [limit],
  );
  return rows.map(pub);
}

export async function liveItemPublication(tx: QueryClient, itemId: string): Promise<PublicationRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${PUB_COLS} FROM publications p WHERE p.content_item_id = $1 AND p.status IN ('queued', 'publishing') LIMIT 1`, [itemId]);
  return rows[0] ? pub(rows[0]) : null;
}

/**
 * Lock one publication. The dispatcher uses SKIP LOCKED so concurrent workers never process the
 * same row; recording an outcome waits for the lock instead.
 */
export async function lockPublication(tx: QueryClient, id: string, opts: { skipLocked?: boolean } = { skipLocked: true }): Promise<PublicationRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${PUB_COLS} FROM publications p WHERE p.id = $1 FOR UPDATE${opts.skipLocked ? " SKIP LOCKED" : ""}`, [id]);
  return rows[0] ? pub(rows[0]) : null;
}

/** The live (queued/publishing) publication of an item, locked. Lock it before the item (same order as the dispatcher). */
export async function lockLiveItemPublication(tx: QueryClient, itemId: string): Promise<PublicationRow | null> {
  const { rows } = await tx.query<Record<string, unknown>>(`SELECT ${PUB_COLS} FROM publications p WHERE p.content_item_id = $1 AND p.status IN ('queued', 'publishing') FOR UPDATE`, [itemId]);
  return rows[0] ? pub(rows[0]) : null;
}

export async function updatePublication(
  tx: QueryClient,
  id: string,
  patch: { status?: PublicationStatus; externalId?: string; permalink?: string | null; attemptsIncrement?: boolean; lastError?: string | null; nextAttemptAt?: string | null; published?: boolean; note?: string | null },
): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const add = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  if (patch.status) add("status", patch.status);
  if (patch.externalId !== undefined) add("external_id", patch.externalId);
  if (patch.permalink !== undefined) add("permalink", patch.permalink);
  if (patch.attemptsIncrement) sets.push("attempts = attempts + 1");
  if (patch.lastError !== undefined) add("last_error", patch.lastError);
  if (patch.note !== undefined) add("note", patch.note);
  if (patch.nextAttemptAt !== undefined) add("next_attempt_at", patch.nextAttemptAt, "::timestamptz");
  if (patch.published) sets.push("published_at = now()");
  await tx.query(`UPDATE publications SET ${sets.join(", ")} WHERE id = $1 RETURNING id`, params);
}

/**
 * Due or stranded work across all tenants, read through the jat_scheduler role, which can
 * see only ids, tenant ids, status and timing. Run on the publisher connection.
 */
export async function findDuePublications(tx: QueryClient, now: Date, limit = 20): Promise<Array<{ id: string; tenantId: string; stranded: boolean }>> {
  await tx.query("SET LOCAL ROLE jat_scheduler");
  const { rows } = await tx.query<{ id: string; tenant_id: string; status: string }>(
    `SELECT id, tenant_id, status FROM publications
     WHERE (status = 'queued' AND scheduled_for <= $1::timestamptz AND (next_attempt_at IS NULL OR next_attempt_at <= $1::timestamptz))
        OR (status = 'publishing' AND updated_at < $1::timestamptz - interval '15 minutes')
     ORDER BY scheduled_for LIMIT $2`,
    [now.toISOString(), limit],
  );
  return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, stranded: r.status === "publishing" }));
}
