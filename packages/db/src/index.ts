/**
 * Database access helpers.
 *
 * The executable schema is SQL-first: `packages/db/migrations/*.sql` (RLS policies,
 * triggers and grants are easiest to review as SQL). A typed query layer (Drizzle)
 * is added in Phase 2 when the web app needs it; these helpers work with any
 * node-postgres-compatible client.
 */

/** Minimal client shape satisfied by `pg.Client` / `pg.PoolClient`. */
export interface QueryClient {
  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** A pooled connection (pg.PoolClient-compatible). */
export interface PooledClient extends QueryClient {
  release(): void;
}

/** Connection pool (pg.Pool-compatible subset). */
export interface Database {
  connect(): Promise<PooledClient>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, label = "id"): string {
  if (!UUID_RE.test(value)) throw new Error(`${label} must be a UUID`);
  return value;
}

export interface TenantScope {
  tenantId: string;
  /** Verified user id, or omitted for system/agent jobs. */
  userId?: string;
}

/**
 * Run `fn` inside a transaction scoped to one tenant. Postgres RLS uses the
 * transaction-local `app.tenant_id` setting, so even a query that forgets a
 * `WHERE tenant_id = ...` cannot read or write another tenant's rows.
 *
 * Settings are applied with `set_config(..., true)` (transaction-local), so they
 * can never leak to the next user of a pooled connection.
 */
export async function withTenant<T>(client: QueryClient, scope: TenantScope, fn: (tx: QueryClient) => Promise<T>): Promise<T> {
  assertUuid(scope.tenantId, "tenantId");
  if (scope.userId) assertUuid(scope.userId, "userId");
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [scope.userId ?? ""]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export interface AuditEntry {
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** Append to the audit log. Must be called inside `withTenant` (RLS supplies the check). */
export async function appendAudit(tx: QueryClient, tenantId: string, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [tenantId, e.actorType, e.actorId, e.action, e.entityType, e.entityId, JSON.stringify(e.before ?? null), JSON.stringify(e.after ?? null)],
  );
}

// ---------------------------------------------------------------------------
// AI cost ledger (backs @jat/ai SpendLedger). Call inside withTenant — RLS scopes rows.
// ---------------------------------------------------------------------------

/** $1 = now (timestamptz). Sums the current tenant's spend since the start of the UTC calendar month (no upper bound, so app/DB clock skew can't hide recent spend). */
export const MONTH_TO_DATE_SPEND_SQL = `SELECT COALESCE(SUM(cost_micros), 0)::bigint AS micros
  FROM agent_runs
  WHERE created_at >= (date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

export const INSERT_AGENT_RUN_SQL = `INSERT INTO agent_runs
  (tenant_id, agent, model, input_hash, input_tokens, output_tokens, cached_tokens, cost_micros, latency_ms, status, output, error)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)`;

export interface AgentRunRow {
  tenantId: string;
  agent: string;
  model: string;
  inputHash: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicros: number;
  latencyMs: number;
  status: "succeeded" | "failed" | "rejected_budget";
  output?: unknown;
  error?: string;
}

export async function monthToDateSpendMicros(tx: QueryClient, now: Date): Promise<number> {
  const { rows } = await tx.query<{ micros: string | number }>(MONTH_TO_DATE_SPEND_SQL, [now.toISOString()]);
  return Number(rows[0]?.micros ?? 0);
}

export async function insertAgentRun(tx: QueryClient, run: AgentRunRow): Promise<void> {
  await tx.query(INSERT_AGENT_RUN_SQL, [
    run.tenantId, run.agent, run.model, run.inputHash, run.inputTokens, run.outputTokens, run.cachedTokens,
    run.costMicros, run.latencyMs, run.status, run.output === undefined ? null : JSON.stringify(run.output), run.error ?? null,
  ]);
}

/** Acquire a connection, run `fn` in a tenant-scoped transaction, release. */
export async function inTenant<T>(db: Database, scope: TenantScope, fn: (tx: QueryClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    return await withTenant(client, scope, fn);
  } finally {
    client.release();
  }
}

/** Transaction with only the user set (no tenant): used to list a user's workspaces. */
export async function inUser<T>(db: Database, userId: string, fn: (tx: QueryClient) => Promise<T>): Promise<T> {
  assertUuid(userId, "userId");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const r = await fn(client);
      await client.query("COMMIT");
      return r;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Transaction with no tenant or user (only SECURITY DEFINER auth functions are usable). */
export async function inAnonymous<T>(db: Database, fn: (tx: QueryClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    try {
      const r = await fn(client);
      await client.query("COMMIT");
      return r;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

export * from "./store.ts";
export * from "./ledger.ts";
export * from "./content-store.ts";
export * from "./publishing-store.ts";
