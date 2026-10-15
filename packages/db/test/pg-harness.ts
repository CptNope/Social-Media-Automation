import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Throwaway Postgres cluster for integration tests, driven through psql so the
 * test suite needs no npm packages. Skips cleanly when Postgres binaries are absent.
 * In CI, point PG_BIN at the server binaries (e.g. /usr/lib/postgresql/16/bin).
 */
export function findPgBin(): string | undefined {
  const candidates = [process.env.PG_BIN, "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/16/bin", "/usr/local/bin", "/opt/homebrew/bin"].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, "initdb")) && existsSync(join(d, "pg_ctl")) && existsSync(join(d, "psql")));
}

export interface TempPg {
  /** Connection details for additional clients (see testing/psql-client.ts). */
  conn: { bin: string; host: string; port: string; user: string; database: string };
  /** Run SQL as the superuser (setup). Returns stdout (-At format). */
  admin(sql: string): string;
  /** Run SQL as app_user inside one transaction scoped to a tenant (and optional user). */
  asApp(sql: string, scope?: { tenantId?: string; userId?: string }): { ok: boolean; out: string; err: string };
  stop(): void;
}

export function startTempPg(bin: string): TempPg {
  const isRoot = process.getuid?.() === 0;
  const dir = mkdtempSync(join(tmpdir(), "jat-pg-"));
  chmodSync(dir, 0o777);
  const data = join(dir, "data");
  const port = String(20000 + Math.floor(Math.random() * 20000));
  const run = (cmd: string, args: string[]) => {
    const full = isRoot ? ["-u", "postgres", "--", join(bin, cmd), ...args] : args;
    return execFileSync(isRoot ? "runuser" : join(bin, cmd), full, { stdio: "pipe" });
  };
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"]);
  run("pg_ctl", ["-D", data, "-o", `-k ${dir} -p ${port} -c listen_addresses=''`, "-w", "-l", join(dir, "log"), "start"]);

  const psql = (sql: string) =>
    spawnSync(join(bin, "psql"), ["-h", dir, "-p", port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-At"], { input: sql, encoding: "utf8" });

  return {
    conn: { bin, host: dir, port, user: "postgres", database: "postgres" },
    admin(sql) {
      const r = psql(sql);
      if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
      return r.stdout.trim();
    },
    asApp(sql, scope = {}) {
      const lines = ["BEGIN;", "SET LOCAL ROLE app_user;"];
      if (scope.tenantId) lines.push(`SELECT set_config('app.tenant_id', '${scope.tenantId}', true) \\g /dev/null`);
      if (scope.userId) lines.push(`SELECT set_config('app.user_id', '${scope.userId}', true) \\g /dev/null`);
      lines.push(sql, "COMMIT;");
      const r = psql(lines.join("\n"));
      return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
    },
    stop() {
      try {
        run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export function migrationsSql(): string {
  const dirPath = new URL("../migrations/", import.meta.url).pathname;
  return readdirSync(dirPath)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dirPath, f), "utf8"))
    .join("\n");
}
