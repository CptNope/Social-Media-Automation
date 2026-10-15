import { createServer } from "node:http";
import { HttpClaudeClient, runBrandExtraction, runPlanning, runPostDraft, runPostReview } from "@jat/ai";
import { DbSpendLedger, type Database } from "@jat/db";
import { crawlSite, createSafeFetch } from "@jat/ingest";
import { BlueskyAdapter, FacebookPagesAdapter, GoogleBusinessAdapter, LINKEDIN_DEFAULT_VERSION, LinkedInAdapter, ThreadsAdapter, XAdapter } from "@jat/integrations";
import { LocalKekProvider } from "@jat/vault";
import { createApp, type Mailer } from "./app.ts";
import { InProcessJobs } from "./jobs.ts";
import { createPgDatabase } from "./pg-database.ts";
import type { PublishingConfig } from "./publishing-routes.ts";
import { startDispatcher, type PublisherDeps } from "./publisher.ts";

/**
 * Environment:
 *   DATABASE_URL        postgres://app_user:...  (role without BYPASSRLS)
 *   SESSION_SECRET      ≥ 32 random bytes, base64
 *   BASE_URL            public origin, e.g. https://app.example.com
 *   ANTHROPIC_API_KEY   optional; without it onboarding saves evidence but can't draft Brand DNA
 *   TRUSTED_PROXIES     number of reverse proxies in front of the app (for client IPs), default 0
 *   DEV_SHOW_LOGIN_LINKS=1  show magic links on screen (only with NODE_ENV=development)
 *   DEV_PSQL=1 + PG_BIN, PGHOST, PGPORT, PGUSER, PGDATABASE  psql-backed database (only with NODE_ENV=development)
 *
 * Publishing (all optional; without PUBLISHER_DATABASE_URL the app is export-only):
 *   PUBLISHER_DATABASE_URL  postgres://...  login role that is a member of publisher_user (reads credentials)
 *   PUBLISH_MODE            "live" to actually send; anything else is dry-run (default)
 *   LOCAL_KEK_BASE64        32-byte credential KEK (development only; production needs a KMS provider — not built yet)
 *   FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, FACEBOOK_GRAPH_VERSION (default v26.0)
 *   LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, LINKEDIN_VERSION (default 202610)
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   (Google Business Profile)
 *   THREADS_APP_ID, THREADS_APP_SECRET, THREADS_GRAPH_HOST (default graph.threads.net)
 *   X_CLIENT_ID, X_CLIENT_SECRET
 *   Each platform's OAuth redirect URI is {BASE_URL}/oauth/{channel}/callback
 *   PUBLISHER_INTERVAL_SECONDS  dispatcher interval, default 30
 *   JAT_PROCESS             all (default) | web | worker — see below
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

/**
 * JAT_PROCESS: "all" (default; one process does everything), "web" (HTTP only — never holds the
 * credential-reading connection) or "worker" (publisher only, no HTTP). Production should run
 * "web" and "worker" separately so a web-tier bug can't read stored credentials.
 */
const processRole = (env.JAT_PROCESS ?? "all") as "all" | "web" | "worker";
if (!["all", "web", "worker"].includes(processRole)) throw new Error("JAT_PROCESS must be all, web or worker");
if (production && !env.JAT_PROCESS) throw new Error("Set JAT_PROCESS=web and JAT_PROCESS=worker in production (\"all\" lets the web process read credentials)");

async function publishing(): Promise<PublishingConfig | null> {
  const devPsql = env.DEV_PSQL === "1" && development;
  // Export-only unless a credential KEK is set and the publisher can run (here, or in a separate worker).
  if (!env.LOCAL_KEK_BASE64 || !(processRole === "web" || env.PUBLISHER_DATABASE_URL || devPsql)) return null;
  // Throws in production by design: credentials need a KMS-backed KEK there (not built yet).
  const kek = LocalKekProvider.fromEnv(env);
  const mode = env.PUBLISH_MODE === "live" ? "live" : "dry_run";
  const safeFetch = createSafeFetch();
  // Bluesky writes go to the account's PDS (from its DID document), so use the SSRF-safe client.
  const bluesky = new BlueskyAdapter(safeFetch);
  const callback = (channel: string) => new URL(`/oauth/${channel}/callback`, required("BASE_URL")).toString();
  // Each OAuth platform is enabled by its app credentials; missing ones show "not configured".
  const facebook = env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET ? new FacebookPagesAdapter({ appId: env.FACEBOOK_APP_ID, appSecret: env.FACEBOOK_APP_SECRET, version: env.FACEBOOK_GRAPH_VERSION ?? "v26.0", redirectUri: callback("facebook") }) : undefined;
  const linkedin = env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET ? new LinkedInAdapter({ clientId: env.LINKEDIN_CLIENT_ID, clientSecret: env.LINKEDIN_CLIENT_SECRET, redirectUri: callback("linkedin"), version: env.LINKEDIN_VERSION ?? LINKEDIN_DEFAULT_VERSION }) : undefined;
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? new GoogleBusinessAdapter({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: callback("google_business_profile") }) : undefined;
  const threads = env.THREADS_APP_ID && env.THREADS_APP_SECRET ? new ThreadsAdapter({ appId: env.THREADS_APP_ID, appSecret: env.THREADS_APP_SECRET, redirectUri: callback("threads"), ...(env.THREADS_GRAPH_HOST ? { graphHost: env.THREADS_GRAPH_HOST } : {}) }) : undefined;
  const x = env.X_CLIENT_ID && env.X_CLIENT_SECRET ? new XAdapter({ clientId: env.X_CLIENT_ID, clientSecret: env.X_CLIENT_SECRET, redirectUri: callback("x") }) : undefined;
  const oauth = { ...(facebook ? { facebook } : {}), ...(linkedin ? { linkedin } : {}), ...(google ? { google_business_profile: google } : {}), ...(threads ? { threads } : {}), ...(x ? { x } : {}) };
  let publisher: PublisherDeps | null = null;
  if (processRole !== "web") {
    const publisherDb: Database = devPsql
      ? new (await import("@jat/db/testing/psql-client")).PsqlDatabase({ bin: required("PG_BIN"), host: required("PGHOST"), port: env.PGPORT ?? "5432", user: env.PGUSER ?? "postgres", database: env.PGDATABASE ?? "postgres" }, "publisher_user")
      : await createPgDatabase(required("PUBLISHER_DATABASE_URL"));
    publisher = { publisherDb, keks: kek, activeKek: kek, mode, adapters: { bluesky, ...oauth }, safeFetch, log: (m, e) => console.error(m, e ?? "") };
  }
  return { mode, activeKek: kek, bluesky, oauth, publisher };
}
const publishingConfig = await publishing();
if (publishingConfig?.publisher) {
  startDispatcher(publishingConfig.publisher, Number(env.PUBLISHER_INTERVAL_SECONDS ?? 30) * 1000);
  console.log(`Publisher running in ${publishingConfig.mode} mode`);
}
if (processRole === "worker") {
  if (!publishingConfig?.publisher) throw new Error("JAT_PROCESS=worker needs PUBLISHER_DATABASE_URL and a KEK");
  console.log("Worker started (no HTTP server).");
}
const ledger = new DbSpendLedger(db);
const claude = env.ANTHROPIC_API_KEY ? new HttpClaudeClient({ apiKey: env.ANTHROPIC_API_KEY }) : null;

if (processRole !== "worker") {
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
    contentAi: claude
      ? {
          plan: (r) => runPlanning({ client: claude, ledger }, r),
          draft: (r) => runPostDraft({ client: claude, ledger }, r),
          review: (r) => runPostReview({ client: claude, ledger }, r),
        }
      : null,
    publishing: publishingConfig,
  });

  const port = Number(env.PORT ?? 3000);
  createServer((req, res) => void handler(req, res)).listen(port, () => console.log(`JAT Marketing OS listening on ${env.BASE_URL} (port ${port})`));
}
