import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "./pg-harness.ts";
import { PsqlDatabase } from "../testing/psql-client.ts";
import {
  DbSpendLedger,
  activateDna,
  consumeLoginToken,
  createBrand,
  currentRole,
  getDnaVersion,
  inAnonymous,
  inTenant,
  inUser,
  insertClaim,
  insertProposedDna,
  issueLoginToken,
  listClaims,
  listDnaVersions,
  listWorkspaces,
  setClaimStatus,
  updateProposedDna,
  createOnboardingRun,
  updateOnboardingRun,
  getOnboardingRun,
  StaleVersionError,
  insertSources,
  listSourceIds,
  activeOnboardingRun,
  bumpSessionEpoch,
  getUser,
} from "../src/index.ts";

const bin = findPgBin();
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const hash = (c: string) => c.repeat(64);

describe("app store on real Postgres (via psql client)", { skip: bin ? false : "Postgres binaries not found" }, () => {
  let pg: TempPg;
  let db: PsqlDatabase;

  before(() => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    pg.admin(`
      INSERT INTO tenants (id, name, slug) VALUES ('${A}', 'Acme Plumbing', 'acme'), ('${B}', 'Bravo Bakery', 'bravo');
      INSERT INTO users (id, email, name) VALUES ('${OWNER}', 'owner@acme.example', 'Olive Owner'), ('${OP}', 'ops@jat.example', 'Oscar Operator');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${A}', '${OWNER}', 'client_owner'), ('${A}', '${OP}', 'agency_operator'), ('${B}', '${OP}', 'agency_operator');`);
    db = new PsqlDatabase(pg.conn);
  });
  after(async () => {
    await db?.close();
    pg?.stop();
  });

  it("magic-link tokens: unknown emails get nothing, tokens are single-use", async () => {
    assert.equal(await inAnonymous(db, (tx) => issueLoginToken(tx, "nobody@example.com", hash("1"), 15)), false);
    assert.equal(await inAnonymous(db, (tx) => issueLoginToken(tx, "  OWNER@acme.example ", hash("2"), 15)), true);
    assert.equal(await inAnonymous(db, (tx) => consumeLoginToken(tx, hash("2"))), OWNER);
    assert.equal(await inAnonymous(db, (tx) => consumeLoginToken(tx, hash("2"))), null, "second use fails");
    assert.equal(await inAnonymous(db, (tx) => consumeLoginToken(tx, hash("3"))), null);
    await assert.rejects(inAnonymous(db, (tx) => tx.query("SELECT * FROM login_tokens")), /permission denied/);
  });

  it("magic-link tokens: expired tokens fail; spamming can't lock a user out", async () => {
    await inAnonymous(db, (tx) => issueLoginToken(tx, "ops@jat.example", hash("4"), 15));
    pg.admin(`UPDATE login_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = '${hash("4")}'`);
    assert.equal(await inAnonymous(db, (tx) => consumeLoginToken(tx, hash("4"))), null);
    for (const c of ["5", "6", "7", "8", "9", "a", "b"]) assert.equal(await inAnonymous(db, (tx) => issueLoginToken(tx, "ops@jat.example", hash(c), 15)), true);
    // Only the 5 newest stay valid; the newest (the real user's) always works.
    assert.equal(await inAnonymous(db, (tx) => consumeLoginToken(tx, hash("5"))), null, "oldest invalidated");
    assert.equal(await inAnonymous(db, (tx) => consumeLoginToken(tx, hash("b"))), OP);
  });

  it("lists only the user's workspaces and roles", async () => {
    const ws = await inUser(db, OP, (tx) => listWorkspaces(tx, OP));
    assert.deepEqual(ws.map((w) => [w.slug, w.role]), [["acme", "agency_operator"], ["bravo", "agency_operator"]]);
    assert.deepEqual((await inUser(db, OWNER, (tx) => listWorkspaces(tx, OWNER))).map((w) => w.slug), ["acme"]);
    assert.equal(await inTenant(db, { tenantId: B, userId: OWNER }, (tx) => currentRole(tx, OWNER)), null);
    assert.equal(await inTenant(db, { tenantId: A, userId: OWNER }, (tx) => currentRole(tx, OWNER)), "client_owner");
  });

  it("Brand DNA lifecycle: propose → edit → activate → supersede", async () => {
    const brandId = await inTenant(db, { tenantId: A }, (tx) => createBrand(tx, A, "Acme"));
    const v1 = await inTenant(db, { tenantId: A }, (tx) => insertProposedDna(tx, { tenantId: A, brandId, data: { schema_version: 1, n: 1 }, createdBy: `user:${OP}` }));
    assert.equal(v1.version, 1);
    assert.equal(await inTenant(db, { tenantId: A }, (tx) => updateProposedDna(tx, v1.id, { schema_version: 1, n: 2 })), true);
    await inTenant(db, { tenantId: A }, (tx) => activateDna(tx, { brandId, versionId: v1.id, userId: OWNER }));
    assert.equal(await inTenant(db, { tenantId: A }, (tx) => updateProposedDna(tx, v1.id, { tampered: true })), false, "active is frozen");
    const v2 = await inTenant(db, { tenantId: A }, (tx) => insertProposedDna(tx, { tenantId: A, brandId, data: { schema_version: 1, n: 3 }, createdBy: `user:${OP}` }));
    assert.equal(v2.version, 2);
    await inTenant(db, { tenantId: A }, (tx) => activateDna(tx, { brandId, versionId: v2.id, userId: OWNER }));
    const versions = await inTenant(db, { tenantId: A }, (tx) => listDnaVersions(tx, brandId));
    assert.deepEqual(versions.map((v) => [v.version, v.status]), [[2, "active"], [1, "superseded"]]);
    assert.deepEqual((await inTenant(db, { tenantId: A }, (tx) => getDnaVersion(tx, v1.id)))?.data, { schema_version: 1, n: 2 });
    assert.equal(await inTenant(db, { tenantId: B }, (tx) => getDnaVersion(tx, v1.id)), null, "other tenant can't see it");
    // Activating something no longer proposed throws and rolls back (the active version stays active).
    await assert.rejects(inTenant(db, { tenantId: A }, (tx) => activateDna(tx, { brandId, versionId: v1.id, userId: OWNER })), StaleVersionError);
    assert.deepEqual((await inTenant(db, { tenantId: A }, (tx) => listDnaVersions(tx, brandId))).map((v) => v.status), ["active", "superseded"]);
  });

  it("evidence is per run and can't be rewritten", async () => {
    const brandId = await inTenant(db, { tenantId: A }, (tx) => createBrand(tx, A, "Acme 4"));
    const r1 = await inTenant(db, { tenantId: A }, (tx) => createOnboardingRun(tx, { tenantId: A, brandId, websiteUrl: null, business: {}, startedBy: OP }));
    await inTenant(db, { tenantId: A }, (tx) => updateOnboardingRun(tx, r1, { status: "ready", finished: true }));
    const r2 = await inTenant(db, { tenantId: A }, (tx) => createOnboardingRun(tx, { tenantId: A, brandId, websiteUrl: null, business: {}, startedBy: OP }));
    await inTenant(db, { tenantId: A }, (tx) => insertSources(tx, A, brandId, r1, [{ evidenceId: "note:operator", kind: "note", uri: "u", text: "first" }]));
    await inTenant(db, { tenantId: A }, (tx) => insertSources(tx, A, brandId, r2, [{ evidenceId: "note:operator", kind: "note", uri: "u", text: "second" }]));
    assert.equal((await inTenant(db, { tenantId: A }, (tx) => listSourceIds(tx, brandId, r1))).length, 1);
    await assert.rejects(inTenant(db, { tenantId: A }, (tx) => tx.query("UPDATE sources SET extracted_text = 'x'")), /permission denied/);
    // Only one unfinished run per brand.
    await assert.rejects(inTenant(db, { tenantId: A }, (tx) => createOnboardingRun(tx, { tenantId: A, brandId, websiteUrl: null, business: {}, startedBy: OP })), /onboarding_one_active/);
    assert.equal((await inTenant(db, { tenantId: A }, (tx) => activeOnboardingRun(tx, brandId)))?.id, r2);
  });

  it("sign out everywhere bumps the session epoch only for yourself", async () => {
    await inUser(db, OP, (tx) => bumpSessionEpoch(tx, OP));
    await inUser(db, OP, (tx) => bumpSessionEpoch(tx, OWNER)); // someone else's: no effect
    assert.equal((await inUser(db, OP, (tx) => getUser(tx, OP)))?.sessionEpoch, 1);
    assert.equal(pg.admin(`SELECT session_epoch FROM users WHERE id = '${OWNER}'`), "0");
  });

  it("claims: verify requires evidence (DB constraint), rejection works", async () => {
    const brandId = await inTenant(db, { tenantId: A }, (tx) => createBrand(tx, A, "Acme 2"));
    const withEvidence = await inTenant(db, { tenantId: A }, (tx) => insertClaim(tx, { tenantId: A, brandId, text: "Licensed in MA", category: "credential", evidence: [{ kind: "license_lookup", reference: "#123", captured_at: new Date().toISOString() }] }));
    const noEvidence = await inTenant(db, { tenantId: A }, (tx) => insertClaim(tx, { tenantId: A, brandId, text: "Since 1998", category: "history", evidence: [] }));
    assert.equal(await inTenant(db, { tenantId: A }, (tx) => setClaimStatus(tx, { claimId: withEvidence, status: "verified", userId: OWNER })), true);
    await assert.rejects(inTenant(db, { tenantId: A }, (tx) => setClaimStatus(tx, { claimId: noEvidence, status: "verified", userId: OWNER })), /check constraint/);
    assert.equal(await inTenant(db, { tenantId: A }, (tx) => setClaimStatus(tx, { claimId: noEvidence, status: "rejected", userId: OWNER })), true);
    const claims = await inTenant(db, { tenantId: A }, (tx) => listClaims(tx, brandId));
    assert.deepEqual(claims.map((c) => [c.text, c.status]).sort(), [["Licensed in MA", "verified"], ["Since 1998", "rejected"]]);
  });

  it("onboarding runs round-trip JSON fields", async () => {
    const brandId = await inTenant(db, { tenantId: A }, (tx) => createBrand(tx, A, "Acme 3"));
    const runId = await inTenant(db, { tenantId: A }, (tx) => createOnboardingRun(tx, { tenantId: A, brandId, websiteUrl: "https://acme.example", business: { name: "Acme" }, startedBy: OP }));
    await inTenant(db, { tenantId: A }, (tx) => updateOnboardingRun(tx, runId, { status: "failed", error: "boom", findings: [{ code: "x", severity: "warning", message: "it's \"quoted\"" }], costMicros: 1234, finished: true }));
    const run = await inTenant(db, { tenantId: A }, (tx) => getOnboardingRun(tx, runId));
    assert.equal(run?.status, "failed");
    assert.equal(run?.findings[0]?.message, 'it\'s "quoted"');
    assert.equal(run?.costMicros, 1234);
    assert.ok(run?.finishedAt);
  });

  it("DbSpendLedger serializes per tenant and keeps cost rows when the call fails", async () => {
    const ledger = new DbSpendLedger(db);
    const order: string[] = [];
    const job = (name: string, ms: number) =>
      ledger.withTenantLock(A, async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        await ledger.record({ tenantId: A, agent: name, model: "claude-sonnet-5-5", inputHash: "h", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costMicros: 1000, latencyMs: ms, status: "succeeded" });
        order.push(`${name}:end`);
      });
    await Promise.all([job("a", 50), job("b", 1)]);
    assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
    await assert.rejects(
      ledger.withTenantLock(A, async () => {
        await ledger.record({ tenantId: A, agent: "c", model: "m", inputHash: "h", inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 500, latencyMs: 0, status: "failed" });
        throw new Error("api failed");
      }),
      /api failed/,
    );
    assert.equal(await ledger.monthToDateMicros(A, new Date()), 2500);
    assert.equal(await ledger.monthToDateMicros(B, new Date()), 0);
  });
});
