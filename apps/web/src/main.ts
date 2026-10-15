import { createServer } from "node:http";
import { HttpClaudeClient, runBrandExtraction } from "@jat/ai";
import { DbSpendLedger, type Database } from "@jat/db";
import { crawlSite } from "@jat/ingest";
import { createApp, type Mailer } from "./app.ts";
import { InProcessJobs } from "./jobs.ts";
import { createPgDatabase } from "./pg-database.ts";

/**
 * Environment:
 *   DATABASE_URL        postgres://app_user:...  (role without BYPASSRLS)
 *   SESSION_SECRET      ≥ 32 random bytes, base64
 *   BASE_URL            public origin, e.g. https://app.example.com
 *   ANTHROPIC_API_KEY   optional; without it onboarding saves evidence but can't draft Brand DNA
 *   TRUSTED_PROXIES     number of reverse proxies in front of the app (for client IPs), default 0
 *   DEV_SHOW_LOGIN_LINKS=1  show magic links on screen (only with NODE_ENV=development)
 *   DEV_PSQL=1 + PG_BIN, PGHOST, PGPORT, PGUSER, PGDATABASE  psql-backed database (only with NODE_ENV=development)
 */
const env = process.env;
const production = env.NODE_ENV === "production";
// Dev conveniences need an explicit opt-in: a deployment that forgets NODE_ENV must not get them.
const development = env.NODE_ENV === "development";

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

const consoleMailer: Mailer = {
  async sendLoginLink(email) {
    // Production needs a real provider (see docs/J backlog AUTH-2); never log tokens in production.
    if (production) throw new Error("No email provider configured");
    console.log(`[mail] sign-in link issued for ${email}`);
  },
};

async function database(): Promise<Database> {
  if (env.DEV_PSQL === "1") {
    if (!development) throw new Error("DEV_PSQL requires NODE_ENV=development");
    const { PsqlDatabase } = await import("@jat/db/testing/psql-client");
    return new PsqlDatabase({ bin: required("PG_BIN"), host: required("PGHOST"), port: env.PGPORT ?? "5432", user: env.PGUSER ?? "postgres", database: env.PGDATABASE ?? "postgres" });
  }
  return createPgDatabase(required("DATABASE_URL"));
}

const db = await database();
const ledger = new DbSpendLedger(db);
const claude = env.ANTHROPIC_API_KEY ? new HttpClaudeClient({ apiKey: env.ANTHROPIC_API_KEY }) : null;

const handler = createApp({
  db,
  sessionSecret: Buffer.from(required("SESSION_SECRET"), "base64"),
  baseUrl: required("BASE_URL"),
  mailer: consoleMailer,
  jobs: new InProcessJobs(2),
  production,
  devShowLoginLinks: development && env.DEV_SHOW_LOGIN_LINKS === "1",
  trustedProxies: Number(env.TRUSTED_PROXIES ?? 0),
  onboarding: {
    crawl: (opts) => crawlSite(opts),
    extract: claude ? (input) => runBrandExtraction({ client: claude, ledger }, input) : null,
  },
});

const port = Number(env.PORT ?? 3000);
createServer((req, res) => void handler(req, res)).listen(port, () => console.log(`JAT Marketing OS listening on ${env.BASE_URL} (port ${port})`));
