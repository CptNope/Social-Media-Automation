/**
 * Per-tenant AI budget guard and run ledger.
 * Storage is injected so the same logic works with Postgres (packages/db) and in tests.
 */

export interface AgentRunRecord {
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

export interface SpendLedger {
  /** Spend for the tenant in the current calendar month (UTC), USD micros. */
  monthToDateMicros(tenantId: string, now: Date): Promise<number>;
  record(run: AgentRunRecord): Promise<void>;
  /**
   * Serialize check → call → record for one tenant so parallel jobs cannot all pass the
   * same budget reading. Postgres implementation: pg_advisory_xact_lock(hashtext(tenant_id)).
   */
  withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T>;
}

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
  constructor(
    readonly tenantId: string,
    readonly spentMicros: number,
    readonly projectedMicros: number,
    readonly budgetMicros: number,
  ) {
    super(`AI budget exceeded for tenant ${tenantId}: spent $${(spentMicros / 1e6).toFixed(2)} + projected $${(projectedMicros / 1e6).toFixed(2)} > budget $${(budgetMicros / 1e6).toFixed(2)}`);
  }
}

/** Throws before the call is made if the projected spend would exceed the tenant's monthly budget. */
export async function assertWithinBudget(ledger: SpendLedger, args: { tenantId: string; budgetCents: number; projectedMicros: number; now: Date }): Promise<void> {
  const budgetMicros = args.budgetCents * 10_000;
  const spent = await ledger.monthToDateMicros(args.tenantId, args.now);
  if (spent + args.projectedMicros > budgetMicros) {
    throw new BudgetExceededError(args.tenantId, spent, args.projectedMicros, budgetMicros);
  }
}

/** In-memory ledger for tests and local scripts. */
export class MemoryLedger implements SpendLedger {
  runs: AgentRunRecord[] = [];
  constructor(private readonly seed: Record<string, number> = {}) {}
  async monthToDateMicros(tenantId: string): Promise<number> {
    return (this.seed[tenantId] ?? 0) + this.runs.filter((r) => r.tenantId === tenantId).reduce((s, r) => s + r.costMicros, 0);
  }
  async record(run: AgentRunRecord): Promise<void> {
    this.runs.push(run);
  }
  #locks = new Map<string, Promise<unknown>>();
  async withTenantLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(tenantId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#locks.set(tenantId, next.catch(() => undefined));
    return next;
  }
}
