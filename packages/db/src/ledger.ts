import { AsyncLocalStorage } from "node:async_hooks";
import { assertUuid, inTenant, insertAgentRun, monthToDateSpendMicros, type AgentRunRow, type Database, type QueryClient } from "./index.ts";

/**
 * Postgres-backed AI spend ledger (implements @jat/ai SpendLedger structurally).
 *
 * withTenantLock holds a transaction with pg_advisory_xact_lock(hashtext(tenant)) for
 * the duration of check → API call → record, so concurrent workers for one tenant
 * serialize and always see each other's spend. The transaction commits even when the
 * wrapped call fails, so cost rows are never rolled back.
 */
export class DbSpendLedger {
  readonly #db: Database;
  readonly #als = new AsyncLocalStorage<{ tenantId: string; tx: QueryClient }>();

  constructor(db: Database) {
    this.#db = db;
  }

  async withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    assertUuid(tenantId, "tenantId");
    const client = await this.#db.connect();
    let failed = false;
    let error: unknown;
    let result: T | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query("SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext($1))) l", [tenantId]);
      try {
        result = await this.#als.run({ tenantId, tx: client }, fn);
      } catch (e) {
        failed = true;
        error = e;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    if (failed) throw error;
    return result as T;
  }

  async #within<T>(tenantId: string, fn: (tx: QueryClient) => Promise<T>): Promise<T> {
    const ctx = this.#als.getStore();
    if (ctx && ctx.tenantId === tenantId) return fn(ctx.tx);
    return inTenant(this.#db, { tenantId }, fn);
  }

  monthToDateMicros(tenantId: string, now: Date): Promise<number> {
    return this.#within(tenantId, (tx) => monthToDateSpendMicros(tx, now));
  }

  record(run: AgentRunRow): Promise<void> {
    return this.#within(run.tenantId, (tx) => insertAgentRun(tx, run));
  }
}
