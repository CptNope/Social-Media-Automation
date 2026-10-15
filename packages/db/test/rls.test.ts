import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "./pg-harness.ts";
import { INSERT_AGENT_RUN_SQL, MONTH_TO_DATE_SPEND_SQL } from "../src/index.ts";

const bin = findPgBin();
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const UA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BRAND_A = "a0000000-0000-4000-8000-00000000000a";
const BRAND_B = "b0000000-0000-4000-8000-00000000000b";

describe("Postgres tenant isolation (RLS)", { skip: bin ? false : "Postgres server binaries not found (set PG_BIN)" }, () => {
  let pg: TempPg;

  before(() => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    // Seed as superuser (stands in for admin tooling).
    pg.admin(`
      INSERT INTO tenants (id, name, slug) VALUES ('${A}', 'Acme Plumbing', 'acme'), ('${B}', 'Bravo Bakery', 'bravo');
      INSERT INTO users (id, email) VALUES ('${UA}', 'owner@acme.example'), ('${UB}', 'owner@bravo.example');
      INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${A}', '${UA}', 'client_owner'), ('${B}', '${UB}', 'client_owner');
      INSERT INTO brands (id, tenant_id, name) VALUES ('${BRAND_A}', '${A}', 'Acme'), ('${BRAND_B}', '${B}', 'Bravo');
      INSERT INTO claims (tenant_id, brand_id, text, category) VALUES ('${A}', '${BRAND_A}', 'Licensed in MA', 'credential'), ('${B}', '${BRAND_B}', 'Fresh daily', 'service');
    `);
  });

  after(() => pg?.stop());

  it("app role without a tenant setting sees nothing (fails closed)", () => {
    const r = pg.asApp("SELECT count(*) FROM brands;");
    assert.equal(r.ok, true, r.err);
    assert.equal(r.out, "0");
  });

  it("each tenant sees only its own rows", () => {
    assert.equal(pg.asApp("SELECT string_agg(name, ',') FROM brands;", { tenantId: A }).out, "Acme");
    assert.equal(pg.asApp("SELECT string_agg(text, ',') FROM claims;", { tenantId: B }).out, "Fresh daily");
  });

  it("a query without WHERE tenant_id still cannot read another tenant's rows", () => {
    const r = pg.asApp(`SELECT count(*) FROM claims WHERE brand_id = '${BRAND_B}';`, { tenantId: A });
    assert.equal(r.out, "0");
  });

  it("cannot insert rows for another tenant", () => {
    const r = pg.asApp(`INSERT INTO brands (tenant_id, name) VALUES ('${B}', 'Injected');`, { tenantId: A });
    assert.equal(r.ok, false);
    assert.match(r.err, /row-level security/);
  });

  it("cannot move a row to another tenant via UPDATE", () => {
    const r = pg.asApp(`UPDATE brands SET tenant_id = '${B}' WHERE id = '${BRAND_A}';`, { tenantId: A });
    assert.equal(r.ok, false);
    assert.match(r.err, /row-level security/);
  });

  it("UPDATE/DELETE of another tenant's rows affects zero rows", () => {
    const r = pg.asApp(`UPDATE brands SET name = 'pwned' WHERE id = '${BRAND_B}' RETURNING id; DELETE FROM claims WHERE brand_id = '${BRAND_B}' RETURNING id;`, { tenantId: A });
    assert.equal(r.ok, true, r.err);
    assert.equal(r.out, "");
    assert.equal(pg.admin(`SELECT name FROM brands WHERE id = '${BRAND_B}'`), "Bravo");
  });

  it("composite foreign keys stop cross-tenant references", () => {
    // Even if a caller knows another tenant's brand id, it cannot attach rows to it.
    const r = pg.asApp(`INSERT INTO claims (tenant_id, brand_id, text, category) VALUES ('${A}', '${BRAND_B}', 'x', 'other');`, { tenantId: A });
    assert.equal(r.ok, false);
    assert.match(r.err, /foreign key/);
  });

  it("tenants table exposes only the current tenant", () => {
    assert.equal(pg.asApp("SELECT string_agg(slug, ',') FROM tenants;", { tenantId: A }).out, "acme");
  });

  it("a signed-in user can list only their own workspaces before choosing a tenant", () => {
    const r = pg.asApp("SELECT string_agg(t.slug, ',') FROM memberships m JOIN tenants t ON t.id = m.tenant_id;", { userId: UB });
    assert.equal(r.ok, true, r.err);
    assert.equal(r.out, "bravo");
  });

  it("users of other tenants are not visible", () => {
    assert.equal(pg.asApp("SELECT string_agg(email, ',') FROM users;", { tenantId: A, userId: UA }).out, "owner@acme.example");
  });

  it("audit log is append-only for the app role", () => {
    const ins = pg.asApp(`INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id) VALUES ('${A}', 'system', 'test', 'test.action', 'brand', '${BRAND_A}');`, { tenantId: A });
    assert.equal(ins.ok, true, ins.err);
    const upd = pg.asApp("UPDATE audit_log SET action = 'tampered';", { tenantId: A });
    assert.equal(upd.ok, false);
    assert.match(upd.err, /permission denied/);
    const del = pg.asApp("DELETE FROM audit_log;", { tenantId: A });
    assert.equal(del.ok, false);
    assert.match(del.err, /permission denied/);
  });

  it("app role cannot flip the platform-wide pause or create tenants", () => {
    assert.match(pg.asApp("UPDATE platform_settings SET global_paused = false;", { tenantId: A }).err, /permission denied/);
    assert.match(pg.asApp(`INSERT INTO tenants (name, slug) VALUES ('x', 'x-co');`, { tenantId: A }).err, /permission denied/);
  });

  it("active Brand DNA versions are immutable and unique per brand", () => {
    const V1 = "c1000000-0000-4000-8000-000000000001";
    const setup = pg.asApp(
      `INSERT INTO brand_dna_versions (id, tenant_id, brand_id, version, status, data, created_by, approved_by, approved_at)
       VALUES ('${V1}', '${A}', '${BRAND_A}', 1, 'active', '{"schema_version":1}', 'user:${UA}', '${UA}', now());`,
      { tenantId: A },
    );
    assert.equal(setup.ok, true, setup.err);
    assert.match(pg.asApp(`UPDATE brand_dna_versions SET data = '{"tampered":true}' WHERE id = '${V1}';`, { tenantId: A }).err, /immutable/);
    const second = pg.asApp(
      `INSERT INTO brand_dna_versions (tenant_id, brand_id, version, status, data, created_by, approved_by, approved_at)
       VALUES ('${A}', '${BRAND_A}', 2, 'active', '{}', 'user:${UA}', '${UA}', now());`,
      { tenantId: A },
    );
    assert.match(second.err, /brand_dna_one_active/);
    const supersede = pg.asApp(`UPDATE brand_dna_versions SET status = 'superseded' WHERE id = '${V1}';`, { tenantId: A });
    assert.equal(supersede.ok, true, supersede.err);
  });

  it("an active version requires an approver", () => {
    const r = pg.asApp(
      `INSERT INTO brand_dna_versions (tenant_id, brand_id, version, status, data, created_by) VALUES ('${A}', '${BRAND_A}', 9, 'active', '{}', 'agent_run:x');`,
      { tenantId: A },
    );
    assert.equal(r.ok, false);
    assert.match(r.err, /check constraint/);
  });

  it("verified claims require evidence and a verifier", () => {
    const r = pg.asApp(`INSERT INTO claims (tenant_id, brand_id, text, category, status) VALUES ('${A}', '${BRAND_A}', 'Since 1998', 'history', 'verified');`, { tenantId: A });
    assert.equal(r.ok, false);
    assert.match(r.err, /check constraint/);
  });

  it("app role cannot raise its own gating flags (publishing, autonomy, budget)", () => {
    for (const col of ["publishing_enabled = true", "autonomous_eligible = true", "monthly_ai_budget_cents = 999999"]) {
      const r = pg.asApp(`UPDATE tenants SET ${col} WHERE id = '${A}';`, { tenantId: A });
      assert.equal(r.ok, false, col);
      assert.match(r.err, /permission denied/);
    }
    assert.equal(pg.asApp(`UPDATE tenants SET automation_mode = 'assisted' WHERE id = '${A}' RETURNING automation_mode;`, { tenantId: A }).out, "assisted");
  });

  it("app role cannot create users or grant itself memberships", () => {
    assert.match(pg.asApp(`INSERT INTO users (email) VALUES ('x@evil.example');`, { tenantId: A }).err, /permission denied/);
    assert.match(pg.asApp(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ('${A}', '${UB}', 'client_owner');`, { tenantId: A }).err, /permission denied/);
    assert.match(pg.asApp(`UPDATE memberships SET role = 'client_owner';`, { tenantId: A }).err, /permission denied/);
  });

  it("credentials: web role can store and remove but never read; publisher role can read its tenant only", () => {
    const INT_A = "f0000000-0000-4000-8000-00000000000f";
    pg.admin(`INSERT INTO integrations (id, tenant_id, channel, external_account_id, display_name) VALUES ('${INT_A}', '${A}', 'facebook', 'page-1', 'Acme Page');`);
    const store = pg.asApp(`INSERT INTO credentials (integration_id, tenant_id, kek_id, wrapped_dek, iv, auth_tag, ciphertext) VALUES ('${INT_A}', '${A}', 'k', 'w', 'i', 't', 'c');`, { tenantId: A });
    assert.equal(store.ok, true, store.err);
    assert.match(pg.asApp("SELECT ciphertext FROM credentials;", { tenantId: A }).err, /permission denied/);
    const asPublisher = (sql: string, tenantId: string) => pg.asApp(`SET LOCAL ROLE publisher_user; ${sql}`, { tenantId });
    assert.equal(asPublisher("SELECT ciphertext FROM credentials;", A).out, "c");
    assert.equal(asPublisher("SELECT count(*) FROM credentials;", B).out, "0");
    assert.equal(pg.asApp(`SELECT remove_credential('${INT_A}');`, { tenantId: B }).out, "f", "other tenant cannot remove it");
    assert.equal(pg.asApp(`SELECT remove_credential('${INT_A}');`, { tenantId: A }).out, "t");
    assert.equal(pg.admin("SELECT count(*) FROM credentials"), "0");
  });

  it("revisions and approvals are append-only, and an approval must reference its own item's revision", () => {
    const ITEM = "d1000000-0000-4000-8000-0000000000d1";
    const OTHER = "d2000000-0000-4000-8000-0000000000d2";
    const REV = "e1000000-0000-4000-8000-0000000000e1";
    const OTHER_REV = "e2000000-0000-4000-8000-0000000000e2";
    const seed = pg.asApp(`
      INSERT INTO content_items (id, tenant_id, brand_id, channel, kind) VALUES ('${ITEM}', '${A}', '${BRAND_A}', 'facebook', 'social_post'), ('${OTHER}', '${A}', '${BRAND_A}', 'facebook', 'social_post');
      INSERT INTO content_revisions (id, tenant_id, content_item_id, revision, body, content_hash, created_by) VALUES
        ('${REV}', '${A}', '${ITEM}', 1, '{"hook":"a"}', repeat('a', 64), 'test'),
        ('${OTHER_REV}', '${A}', '${OTHER}', 1, '{"hook":"b"}', repeat('b', 64), 'test');
      UPDATE content_items SET current_revision_id = '${REV}' WHERE id = '${ITEM}';`, { tenantId: A });
    assert.equal(seed.ok, true, seed.err);
    assert.match(pg.asApp(`UPDATE content_revisions SET body = '{"hook":"tampered"}' WHERE id = '${REV}';`, { tenantId: A }).err, /permission denied/);
    assert.match(pg.asApp(`UPDATE content_items SET current_revision_id = '${OTHER_REV}' WHERE id = '${ITEM}';`, { tenantId: A }).err, /foreign key/);
    const crossed = pg.asApp(`INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision, decided_by) VALUES ('${A}', '${ITEM}', '${OTHER_REV}', repeat('b', 64), 'approved', '${UA}');`, { tenantId: A });
    assert.match(crossed.err, /foreign key/);
    const ok = pg.asApp(`INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision, decided_by) VALUES ('${A}', '${ITEM}', '${REV}', repeat('a', 64), 'approved', '${UA}');`, { tenantId: A });
    assert.equal(ok.ok, true, ok.err);
    assert.match(pg.asApp("UPDATE approvals SET decision = 'rejected';", { tenantId: A }).err, /permission denied/);
    assert.match(pg.asApp("DELETE FROM approvals;", { tenantId: A }).err, /permission denied/);
    // Policy auto-approvals must record why; anonymous approvals are rejected.
    const anon = pg.asApp(`INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision) VALUES ('${A}', '${ITEM}', '${REV}', repeat('a', 64), 'approved');`, { tenantId: A });
    assert.match(anon.err, /check constraint/);
    const auto = pg.asApp(`INSERT INTO approvals (tenant_id, content_item_id, revision_id, content_hash, decision, policy_reason, veto_until) VALUES ('${A}', '${ITEM}', '${REV}', repeat('a', 64), 'approved', 'assisted: pre-approved pattern', now() + interval '24 hours');`, { tenantId: A });
    assert.equal(auto.ok, true, auto.err);
  });

  it("Brand DNA versions cannot be deleted by the app", () => {
    assert.match(pg.asApp("DELETE FROM brand_dna_versions;", { tenantId: A }).err, /permission denied/);
  });

  it("audit history survives tenant deletion", () => {
    pg.admin(`INSERT INTO tenants (id, name, slug) VALUES ('33333333-3333-4333-8333-333333333333', 'Gone Co', 'gone');
      INSERT INTO audit_log (tenant_id, actor_type, actor_id, action, entity_type, entity_id) VALUES ('33333333-3333-4333-8333-333333333333', 'system', 't', 'x', 'tenant', 'gone');
      DELETE FROM tenants WHERE slug = 'gone';`);
    assert.equal(pg.admin("SELECT count(*) FROM audit_log WHERE tenant_id = '33333333-3333-4333-8333-333333333333'"), "1");
  });

  it("AI cost ledger: append-only, month-to-date spend per tenant and per UTC month", () => {
    const prep = `PREPARE ins AS ${INSERT_AGENT_RUN_SQL}; PREPARE mtd AS ${MONTH_TO_DATE_SPEND_SQL};`;
    const ok = pg.asApp(`${prep} EXECUTE ins('${A}', 'brand-dna-extraction', 'claude-opus-5-5', 'h', 1, 1, 0, 250000, 10, 'succeeded', NULL, NULL);`, { tenantId: A });
    assert.equal(ok.ok, true, ok.err);
    pg.admin(`UPDATE agent_runs SET created_at = '2026-10-15T10:00:00Z';
      INSERT INTO agent_runs (tenant_id, agent, model, input_hash, cost_micros, status, created_at) VALUES
        ('${A}', 'a', 'm', 'h', 1000000, 'succeeded', '2026-10-01T00:00:00Z'),
        ('${A}', 'a', 'm', 'h', 9000000, 'succeeded', '2026-09-30T23:59:59Z'),
        ('${B}', 'a', 'm', 'h', 5000000, 'succeeded', '2026-10-10T00:00:00Z');`);
    assert.equal(pg.asApp(`${prep} EXECUTE mtd('2026-10-15T12:00:00Z');`, { tenantId: A }).out, "1250000");
    assert.equal(pg.asApp(`${prep} EXECUTE mtd('2026-10-15T12:00:00Z');`, { tenantId: B }).out, "5000000");
    assert.match(pg.asApp(`${prep} EXECUTE ins('${B}', 'x', 'm', 'h', 0, 0, 0, 0, 0, 'succeeded', NULL, NULL);`, { tenantId: A }).err, /row-level security/);
    assert.match(pg.asApp("UPDATE agent_runs SET cost_micros = 0;", { tenantId: A }).err, /permission denied/);
  });

  it("publication idempotency keys are unique", () => {
    pg.admin(`
      INSERT INTO content_items (id, tenant_id, brand_id, channel, kind) VALUES ('d0000000-0000-4000-8000-00000000000d', '${A}', '${BRAND_A}', 'facebook', 'social_post');
      INSERT INTO content_revisions (id, tenant_id, content_item_id, revision, body, content_hash, created_by)
        VALUES ('e0000000-0000-4000-8000-00000000000e', '${A}', 'd0000000-0000-4000-8000-00000000000d', 1, '{}', repeat('a', 64), 'test');
    `);
    const ins = `INSERT INTO publications (tenant_id, content_item_id, revision_id, idempotency_key) VALUES ('${A}', 'd0000000-0000-4000-8000-00000000000d', 'e0000000-0000-4000-8000-00000000000e', 'pub-1');`;
    assert.equal(pg.asApp(ins, { tenantId: A }).ok, true);
    assert.match(pg.asApp(ins, { tenantId: A }).err, /duplicate key/);
  });
});
