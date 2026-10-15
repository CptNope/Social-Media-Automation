/**
 * Local demo: starts a throwaway Postgres cluster, applies migrations, seeds two clients
 * and three people, and runs the dashboard on http://localhost:3000.
 *
 *   PG_BIN=/usr/lib/postgresql/16/bin pnpm --filter @jat/web demo
 *
 * Sign-in links are shown on screen (development only). Without ANTHROPIC_API_KEY the
 * "Draft Brand DNA" job uses a canned sample response so the flow can be explored offline;
 * the website crawl is real unless DEMO_FAKE_CRAWL=1.
 *
 * Publishing runs in dry-run mode (nothing is ever sent). Bluesky connections are checked
 * against the real service; DEMO_FAKE_PUBLISH=1 swaps in an offline stand-in that accepts
 * any app password so the scheduling screens can be explored without an account.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { HttpClaudeClient, runBrandExtraction, runPlanning, runPostDraft, runPostReview } from "@jat/ai";
import { sampleClaude } from "../src/sample-ai.ts";
import { DbSpendLedger } from "@jat/db";
import { PsqlDatabase } from "@jat/db/testing/psql-client";
import { crawlSite, createSafeFetch, type CrawlResult } from "@jat/ingest";
import { BlueskyAdapter, type BlueskyCredential, type ChannelAdapter } from "@jat/integrations";
import { LocalKekProvider } from "@jat/vault";
import { startDispatcher, type PublisherDeps } from "../src/publisher.ts";
import { findPgBin, migrationsSql, startTempPg } from "../../../packages/db/test/pg-harness.ts";
import { createApp } from "../src/app.ts";
import { InProcessJobs } from "../src/jobs.ts";

const bin = findPgBin();
if (!bin) throw new Error("PostgreSQL server binaries not found; set PG_BIN");
const pg = startTempPg(bin);
pg.admin(migrationsSql());
pg.admin(`
  INSERT INTO tenants (id, name, slug, automation_mode) VALUES
    ('11111111-1111-4111-8111-111111111111', 'Acme Plumbing & Heating', 'acme', 'manual'),
    ('22222222-2222-4222-8222-222222222222', 'Bravo Bakery', 'bravo', 'assisted');
  INSERT INTO users (id, email, name) VALUES
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner@acme.example', 'Olive Owner'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'ops@jat.example', 'Oscar Operator'),
    ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'editor@acme.example', 'Edie Editor');
  INSERT INTO memberships (tenant_id, user_id, role) VALUES
    ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'client_owner'),
    ('11111111-1111-4111-8111-111111111111', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'agency_operator'),
    ('22222222-2222-4222-8222-222222222222', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'agency_operator'),
    ('11111111-1111-4111-8111-111111111111', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'client_editor');`);

const db = new PsqlDatabase(pg.conn);
const ledger = new DbSpendLedger(db);

const SAMPLE = {
  fields: [
    { path: "identity.display_name", value_json: '"Acme Plumbing & Heating"', sources: ["web:/"], confidence: "high", status: "extracted" },
    { path: "identity.tagline", value_json: '"Warm homes, dry basements"', sources: ["web:/"], confidence: "high", status: "extracted" },
    { path: "identity.industry", value_json: '"Residential plumbing and heating"', sources: ["web:/"], confidence: "medium", status: "inferred" },
    { path: "identity.locations", value_json: JSON.stringify([{ label: "Worcester shop", address: "12 Main St, Worcester, MA", service_area: ["Worcester", "Shrewsbury", "Grafton"] }]), sources: ["web:/"], confidence: "high", status: "extracted" },
    { path: "visual.colors", value_json: JSON.stringify([{ name: "Harbor blue", hex: "#1A4C8B", role: "primary" }, { name: "Copper", hex: "#B8642E", role: "accent" }, { name: "Fog", hex: "#F2F4F3", role: "background" }]), sources: ["css:site"], confidence: "medium", status: "inferred" },
    { path: "visual.typography", value_json: JSON.stringify([{ family: "Inter", role: "body", weights: [400, 600] }]), sources: ["css:site"], confidence: "medium", status: "inferred" },
    { path: "voice.personality", value_json: '["friendly","practical","straight-talking"]', sources: ["web:/"], confidence: "medium", status: "inferred" },
    { path: "voice.preferred_ctas", value_json: '["Book a visit","Call us"]', sources: ["web:/"], confidence: "high", status: "extracted" },
    { path: "voice.vocabulary_preferred", value_json: '["technician"]', sources: ["note:operator"], confidence: "high", status: "extracted" },
    { path: "strategy.offerings", value_json: JSON.stringify([{ name: "Furnace tune-up", description: "Annual furnace safety check and cleaning" }, { name: "Emergency plumbing", description: "Burst pipes, leaks and blocked drains" }]), sources: ["web:/"], confidence: "high", status: "extracted" },
    { path: "strategy.geo_targets", value_json: '["Worcester","Shrewsbury","Grafton"]', sources: ["web:/"], confidence: "high", status: "extracted" },
    { path: "identity.founded_year", value_json: "null", sources: [], confidence: "low", status: "missing" },
    { path: "strategy.pillars", value_json: JSON.stringify([{ id: "home-care-tips", name: "Home care tips", description: "Practical seasonal maintenance advice", proof_claim_ids: [] }, { id: "behind-the-scenes", name: "Behind the scenes", description: "The technicians and how they work", proof_claim_ids: [] }, { id: "services", name: "Services", description: "What Acme does and when to call", proof_claim_ids: [] }]), sources: ["web:/"], confidence: "medium", status: "inferred" },
    { path: "strategy.personas", value_json: JSON.stringify([{ id: "new-homeowner", name: "New homeowner", description: "First house, unsure what needs maintenance", goals: ["Avoid surprise repairs"], objections: ["Worried about upselling"], channels: ["facebook", "instagram"] }, { id: "busy-parent", name: "Busy parent", description: "Needs quick, reliable fixes", goals: ["Fast scheduling"], objections: ["Price"], channels: ["facebook", "google_business_profile"] }]), sources: ["web:/"], confidence: "medium", status: "inferred" },
  ],
  candidate_claims: [{ text: "Licensed in Massachusetts", category: "credential", quote: "Licensed in Massachusetts", source_id: "web:/" }],
  conflicts: [],
  missing_information: ["Year the business was founded", "Official brand colors (the website may differ)", "Any awards or certifications"],
};
const HOME = "Acme Plumbing & Heating. Warm homes, dry basements. Licensed in Massachusetts. Serving Worcester, Shrewsbury and Grafton from our shop at 12 Main St, Worcester, MA. Furnace tune-up. Emergency plumbing. Book a visit. Call us.";

const fakeCrawl = async (): Promise<CrawlResult> => ({
  pages: [{ url: "https://acme.example/", status: 200, page: { title: "Acme", metaDescription: "", canonical: null, robotsMeta: null, h1: [], h2: [], text: HOME, links: [], stylesheets: [], colors: [], fonts: [], imagesMissingAlt: 0 } }],
  skipped: [],
  robots: { status: "ok", sitemaps: [] },
  requests: 2,
  siteColors: ["#1A4C8B", "#B8642E", "#F2F4F3"],
  siteFonts: ["Inter"],
  evidence: [
    { id: "web:/", kind: "web", text: HOME },
    { id: "css:site", kind: "css", text: "Colors used on the website: #1A4C8B, #B8642E, #F2F4F3\nFont families: Inter" },
  ],
});

const claude = process.env.ANTHROPIC_API_KEY ? new HttpClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY }) : sampleClaude(SAMPLE);
const port = Number(process.env.PORT ?? 3000);

/** OFFLINE STAND-IN (DEMO_FAKE_PUBLISH=1 only): accepts any app password; publishing stays dry-run anyway. */
const offlineBluesky: ChannelAdapter<BlueskyCredential> = {
  channel: "bluesky",
  async publish() {
    throw new Error("The demo never publishes");
  },
  async remove() {},
  async check(c) {
    return { ok: true, accountName: `@${c.identifier.replace(/^@/, "")}` };
  },
};
const kek = new LocalKekProvider(randomBytes(32), "demo-kek");
const safeFetch = createSafeFetch();
const publisher: PublisherDeps = {
  publisherDb: new PsqlDatabase(pg.conn, "publisher_user"),
  keks: kek,
  mode: "dry_run",
  adapters: { bluesky: process.env.DEMO_FAKE_PUBLISH === "1" ? offlineBluesky : new BlueskyAdapter(safeFetch), facebook: null },
  safeFetch,
  log: (m, e) => console.error(m, e ?? ""),
};
const stopDispatcher = startDispatcher(publisher, 10_000);

const handler = createApp({
  db,
  sessionSecret: randomBytes(32),
  baseUrl: `http://localhost:${port}`,
  mailer: { sendLoginLink: async (email) => console.log(`[demo] sign-in link issued for ${email} (shown on screen)`) },
  jobs: new InProcessJobs(2),
  devShowLoginLinks: true,
  onboarding: {
    crawl: process.env.DEMO_FAKE_CRAWL === "1" || !process.env.ANTHROPIC_API_KEY ? fakeCrawl : (o) => crawlSite(o),
    extract: (input) => runBrandExtraction({ client: claude, ledger }, input),
  },
  contentAi: {
    plan: (r) => runPlanning({ client: claude, ledger }, r),
    draft: (r) => runPostDraft({ client: claude, ledger }, r),
    review: (r) => runPostReview({ client: claude, ledger }, r),
  },
  publishing: { mode: "dry_run", activeKek: kek, bluesky: publisher.adapters.bluesky, facebook: null, publisher },
});

const server = createServer((req, res) => void handler(req, res)).listen(port, () => {
  console.log(`\nJAT Marketing OS demo: http://localhost:${port}`);
  console.log("Sign in as ops@jat.example (operator), owner@acme.example (owner) or editor@acme.example (editor).");
  console.log(process.env.ANTHROPIC_API_KEY ? "Using the real Claude API and real website crawl." : "No ANTHROPIC_API_KEY: AI steps use an offline sample model (canned, schema-valid output).");
});

const shutdown = async () => {
  server.close();
  stopDispatcher();
  await db.close();
  pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
