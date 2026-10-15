/**
 * Local demo: starts a throwaway Postgres cluster, applies migrations, seeds two clients
 * and three people, and runs the dashboard on http://localhost:3000.
 *
 *   PG_BIN=/usr/lib/postgresql/16/bin pnpm --filter @jat/web demo
 *
 * Sign-in links are shown on screen (development only). Without ANTHROPIC_API_KEY the
 * "Draft Brand DNA" job uses a canned sample response so the flow can be explored offline;
 * the website crawl is real unless DEMO_FAKE_CRAWL=1.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { HttpClaudeClient, runBrandExtraction, type ClaudeClient } from "@jat/ai";
import { DbSpendLedger } from "@jat/db";
import { PsqlDatabase } from "@jat/db/testing/psql-client";
import { crawlSite, type CrawlResult } from "@jat/ingest";
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
  ],
  candidate_claims: [{ text: "Licensed in Massachusetts", category: "credential", quote: "Licensed in Massachusetts", source_id: "web:/" }],
  conflicts: [],
  missing_information: ["Year the business was founded", "Official brand colors (the website may differ)", "Any awards or certifications"],
};
const HOME = "Acme Plumbing & Heating. Warm homes, dry basements. Licensed in Massachusetts. Serving Worcester, Shrewsbury and Grafton from our shop at 12 Main St, Worcester, MA. Furnace tune-up. Emergency plumbing. Book a visit. Call us.";

const sampleClaude: ClaudeClient = {
  async createMessage(req) {
    return { id: "demo", model: req.model, stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(SAMPLE) }], usage: { input_tokens: 12_000, output_tokens: 2_500 } };
  },
};
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

const claude = process.env.ANTHROPIC_API_KEY ? new HttpClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY }) : sampleClaude;
const port = Number(process.env.PORT ?? 3000);
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
});

const server = createServer((req, res) => void handler(req, res)).listen(port, () => {
  console.log(`\nJAT Marketing OS demo: http://localhost:${port}`);
  console.log("Sign in as ops@jat.example (operator), owner@acme.example (owner) or editor@acme.example (editor).");
  console.log(process.env.ANTHROPIC_API_KEY ? "Using the real Claude API and real website crawl." : "No ANTHROPIC_API_KEY: Draft Brand DNA uses a canned sample response.");
});

const shutdown = async () => {
  server.close();
  await db.close();
  pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
