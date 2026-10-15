import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import type { Database, PooledClient, QueryClient } from "../src/index.ts";

/**
 * TEST/DEV ONLY: a QueryClient backed by a long-lived `psql` process, so the app and its
 * tests can run against real Postgres without an npm Postgres driver. Production uses
 * node-postgres (see apps/web/src/pg-database.ts).
 *
 * - Parameters are inlined as SQL literals (safe quoting) — never use this with untrusted SQL text.
 * - Row-returning statements are wrapped in json_agg so results round-trip as JSON
 *   (bigint → number, timestamptz → ISO string; callers normalize types).
 */
export interface PsqlConn {
  bin: string;
  host: string;
  port: string;
  user: string;
  database: string;
}

import { randomBytes } from "node:crypto";

export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Non-finite number parameter");
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.includes("\u0000")) throw new Error("NUL byte in parameter");
  return `'${s.replace(/'/g, "''")}'`;
}

export function inlineParams(text: string, params: unknown[] = []): string {
  return text.replace(/\$(\d+)/g, (_, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`Missing parameter $${n}`);
    return sqlLiteral(params[i]);
  });
}

function wrap(sql: string): { text: string; returnsRows: boolean } {
  const s = sql.trim().replace(/;+\s*$/, "");
  const head = s.slice(0, 12).toUpperCase();
  if (head.startsWith("SELECT") || head.startsWith("VALUES") || (head.startsWith("WITH") && !/\b(INSERT|UPDATE|DELETE)\b/i.test(s))) {
    return { text: `SELECT coalesce(json_agg(q), '[]'::json) FROM (${s}) q;`, returnsRows: true };
  }
  if (/\bRETURNING\b/i.test(s) && /^(INSERT|UPDATE|DELETE)\b/i.test(s)) {
    return { text: `WITH q AS (${s}) SELECT coalesce(json_agg(q), '[]'::json) FROM q;`, returnsRows: true };
  }
  return { text: `${s};`, returnsRows: false };
}

export class PsqlClient implements PooledClient {
  #proc: ChildProcessWithoutNullStreams;
  #out = "";
  #err = "";
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(conn: PsqlConn, opts: { role?: string } = {}) {
    this.#proc = spawn(join(conn.bin, "psql"), ["-h", conn.host, "-p", conn.port, "-U", conn.user, "-d", conn.database, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=0"], { stdio: "pipe" });
    this.#proc.stdout.setEncoding("utf8");
    this.#proc.stderr.setEncoding("utf8");
    this.#proc.stdout.on("data", (d: string) => (this.#out += d));
    this.#proc.stderr.on("data", (d: string) => (this.#err += d));
    // Literal quoting below relies on standard_conforming_strings (backslashes are literal).
    void this.query("SET standard_conforming_strings = on");
    if (opts.role) void this.query(`SET ROLE ${opts.role.replace(/[^a-z_]/g, "")}`);
  }

  query<R = unknown>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
    const run = async (): Promise<{ rows: R[] }> => {
      if (this.#closed) throw new Error("psql client is closed");
      const { text: sql, returnsRows } = wrap(inlineParams(text, params));
      // A fresh random end marker per query, so data can never fake the end of a response.
      const SENTINEL = `__JAT_END_${randomBytes(12).toString("hex")}__`;
      this.#out = "";
      this.#err = "";
      this.#proc.stdin.write(`${sql}\n\\echo ${SENTINEL}\n\\warn ${SENTINEL}\n`);
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (this.#out.includes(SENTINEL) && this.#err.includes(SENTINEL)) return resolve();
          if (this.#proc.exitCode !== null) return reject(new Error(`psql exited: ${this.#err}`));
          setTimeout(tick, 1);
        };
        tick();
      });
      const err = this.#err.split(SENTINEL)[0]!;
      const m = /ERROR:\s+([\s\S]*?)(?:\n(?:LINE|DETAIL|HINT|CONTEXT|psql:)|$)/.exec(err);
      if (m) {
        const detail = /DETAIL:\s+(.*)/.exec(err)?.[1];
        throw Object.assign(new Error(m[1]!.trim()), { detail });
      }
      if (!returnsRows) return { rows: [] };
      const out = this.#out.split(SENTINEL)[0]!.trim();
      return { rows: out ? (JSON.parse(out) as R[]) : [] };
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => undefined);
    return p;
  }

  release(): void {
    /* single connection: nothing to return */
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#proc.stdin.end("\\q\n");
    await new Promise((r) => this.#proc.once("exit", r));
  }
}

/** A tiny pool of psql connections implementing the app's Database interface. */
export class PsqlDatabase implements Database {
  #idle: PsqlClient[] = [];
  #all: PsqlClient[] = [];
  constructor(
    private readonly conn: PsqlConn,
    private readonly role = "app_user",
  ) {}

  async connect(): Promise<PooledClient> {
    const c = this.#idle.pop() ?? this.#create();
    return {
      query: (t, p) => c.query(t, p),
      release: () => {
        this.#idle.push(c);
      },
    };
  }

  #create(): PsqlClient {
    const c = new PsqlClient(this.conn, { role: this.role });
    this.#all.push(c);
    return c;
  }

  async close(): Promise<void> {
    await Promise.all(this.#all.map((c) => c.close()));
  }
}

export type { QueryClient };
