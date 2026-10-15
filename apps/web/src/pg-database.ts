import type { Database, PooledClient } from "@jat/db";

/**
 * Production database adapter over node-postgres (`pg`). Not exercised in the build
 * sandbox (no npm registry access there); covered by the CI run once dependencies install.
 */
export async function createPgDatabase(connectionString: string): Promise<Database & { end(): Promise<void> }> {
  const moduleName = "pg"; // resolved at runtime; typed locally below
  const pg = (await import(moduleName)) as unknown as { default?: { Pool: new (cfg: object) => PgPool }; Pool?: new (cfg: object) => PgPool };
  const Pool = pg.default?.Pool ?? pg.Pool;
  if (!Pool) throw new Error("The 'pg' package is not installed");
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, application_name: "jat-web" });
  return {
    async connect(): Promise<PooledClient> {
      const c = await pool.connect();
      return { query: (t, p) => c.query(t, p) as Promise<{ rows: never[] }>, release: () => c.release() };
    },
    end: () => pool.end(),
  };
}

interface PgPool {
  connect(): Promise<{ query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }>;
  end(): Promise<void>;
}
