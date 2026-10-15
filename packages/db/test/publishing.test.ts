import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findPgBin, migrationsSql, startTempPg, type TempPg } from "./pg-harness.ts";

const bin = findPgBin();
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const UA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRAND_A = "a0000000-0000-4000-8000-00000000000a";
const BRAND_B = "b0000000-0000-4000-8000-00000000000b";

/** Migration 0004: the dispatcher's narrow cross-tenant view and the publisher role's isolation. */
describe("publishing schema (0004)", { skip: bin ? false : "Postgres server binaries not found (set PG_BIN)" }, () => {
  let pg: TempPg;

  /** Run SQL in one transaction as `role`, optionally scoped to a tenant. */
  const as = (role: string, sql: string, tenantId?: string) => {
    const lines = ["BEGIN;", `SET LOCAL ROLE ${role};`];
    if (tenantId) lines.push(`SELECT set_config('app.tenant_id', '${tenantId}', true) \\g /dev/null`);
    lines.push(sql, "COMMIT;");
    const r = spawnSync(join(pg.conn.bin, "psql"), ["-h", pg.conn.host, "-p", pg.conn.port, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-X", "-q", "-At"], { input: lines.join("\n"), encoding: "utf8" });
    return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() };
  };

  before(() => {
    pg = startTempPg(bin!);
    pg.admin(migrationsSql());
    pg.admin(`
      INSERT INTO tenants (id, name, slug) VALUES ('${A}', 'Acme', 'acme'), ('${B}', 'Bravo', 'bravo');
      INSERT INTO users (id, email) VALUES ('${UA}', 'owner@acme.example');
      INSERT INTO brands (id, tenant_id, name) VALUES ('${BRAND_A}', '${A}', 'Acme'), ('${BRAND_B}', '${B}', 'Bravo');
      INSERT INTO integrations (id, tenant_id, channel, external_account_id, display_name) VALUES
        ('a1000000-0000-4000-8000-00000000000a', '${A}', 'bluesky', 'acme.bsky.social', '@acme'),
        ('b1000000-0000-4000-8000-00000000000b', '${B}', 'bluesky', 'bravo.bsky.social', '@bravo');
      INSERT INTO credentials (integration_id, tenant_id, kek_id, wrapped_dek, iv, auth_tag, ciphertext) VALUES
        ('a1000000-0000-4000-8000-00000000000a', '${A}', 'k', 'w', 'i', 't', 'secret-a'),
        ('b1000000-0000-4000-8000-00000000000b', '${B}', 'k', 'w', 'i', 't', 'secret-b');`);
    for (const [t, brand, integ, item, rev] of [
      [A, BRAND_A, "a1000000-0000-4000-8000-00000000000a", "a2000000-0000-4000-8000-00000000000a", "a3000000-0000-4000-8000-00000000000a"],
      [B, BRAND_B, "b1000000-0000-4000-8000-00000000000b", "b2000000-0000-4000-8000-00000000000b", "b3000000-0000-4000-8000-00000000000b"],
    ] as const) {
      pg.admin(`
        INSERT INTO content_items (id, tenant_id, brand_id, channel, kind, state) VALUES ('${item}', '${t}', '${brand}', 'bluesky', 'social_post', 'scheduled');
        INSERT INTO content_revisions (id, tenant_id, content_item_id, revision, body, content_hash, created_by) VALUES ('${rev}', '${t}', '${item}', 1, '{"hook":"secret hook ${t}"}', repeat('a', 64), 'test');
        UPDATE content_items SET current_revision_id = '${rev}' WHERE id = '${item}';
        INSERT INTO publications (tenant_id, content_item_id, revision_id, integration_id, idempotency_key, status, scheduled_for) VALUES ('${t}', '${item}', '${rev}', '${integ}', gen_random_uuid()::text, 'queued', now() - interval '1 minute');`);
    }
  });

  after(() => pg?.stop());

  it("the publisher role sees only the current tenant's publications and credentials", () => {
    // Regression: the scheduler policy also applies to members of jat_scheduler (publisher_user).
    assert.equal(as("publisher_user", "SELECT count(*) FROM publications;", A).out, "1");
    assert.equal(as("publisher_user", "SELECT count(*) FROM publications;").out, "0", "no tenant set → nothing");
    assert.equal(as("publisher_user", "SELECT string_agg(ciphertext, ',') FROM credentials;", A).out, "secret-a");
  });

  it("the scheduler sees due work across tenants, but only ids and timing", () => {
    const r = as("publisher_user", "SET LOCAL ROLE jat_scheduler; SELECT count(DISTINCT tenant_id) FROM publications WHERE status = 'queued' AND scheduled_for <= now();");
    assert.equal(r.out, "2", r.err);
    for (const sql of ["SELECT revision_id FROM publications", "SELECT idempotency_key FROM publications", "SELECT * FROM content_revisions", "SELECT * FROM credentials", "SELECT * FROM content_items", "SELECT display_name FROM integrations", "SELECT external_account_id FROM integrations"]) {
      const x = as("publisher_user", `SET LOCAL ROLE jat_scheduler; ${sql};`);
      assert.equal(x.ok, false, `${sql} must be denied`);
      assert.match(x.err, /permission denied/);
    }
    assert.equal(as("publisher_user", "SET LOCAL ROLE jat_scheduler; UPDATE publications SET status = 'cancelled';").ok, false);
  });

  it("the web role can't become the scheduler or read credentials", () => {
    // (SET ROLE is checked against the login role, a superuser in this harness, so check membership directly.)
    assert.equal(pg.admin("SELECT pg_has_role('app_user', 'jat_scheduler', 'MEMBER')"), "f");
    assert.equal(pg.admin("SELECT pg_has_role('app_user', 'publisher_user', 'MEMBER')"), "f");
    assert.equal(pg.admin("SELECT pg_has_role('publisher_user', 'jat_scheduler', 'MEMBER')"), "t");
    assert.equal(pg.admin("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'jat_scheduler'"), "f");
    assert.match(as("app_user", "SELECT count(*) FROM credentials;", A).err, /permission denied/);
  });

  it("at most one live publication per post, and one connected account per channel", () => {
    const dup = as("app_user", `INSERT INTO publications (tenant_id, content_item_id, revision_id, idempotency_key, status) VALUES ('${A}', 'a2000000-0000-4000-8000-00000000000a', 'a3000000-0000-4000-8000-00000000000a', 'k2', 'queued');`, A);
    assert.equal(dup.ok, false);
    assert.match(dup.err, /publications_one_live/);
    const second = as("app_user", `INSERT INTO integrations (tenant_id, channel, external_account_id, display_name) VALUES ('${A}', 'bluesky', 'other.bsky.social', '@other');`, A);
    assert.match(second.err, /integrations_one_per_channel/);
    // Revoking the first frees the channel.
    assert.equal(as("app_user", `UPDATE integrations SET status = 'revoked' WHERE channel = 'bluesky'; INSERT INTO integrations (tenant_id, channel, external_account_id, display_name) VALUES ('${A}', 'bluesky', 'other.bsky.social', '@other');`, A).ok, true);
  });
});
