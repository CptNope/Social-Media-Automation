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
