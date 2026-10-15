import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { LocalKekProvider, decryptSecret, encryptSecret, rewrapSecret } from "../src/index.ts";

const kek1 = new LocalKekProvider(randomBytes(32), "kek-1");
const kek2 = new LocalKekProvider(randomBytes(32), "kek-2");
const ctx = { tenantId: "tenant-a", integrationId: "int-1" };
const token = JSON.stringify({ access_token: "EAAB-secret-token", refresh_token: "r-123" });

describe("credential vault", () => {
  it("round-trips a secret", async () => {
    const rec = await encryptSecret(token, ctx, kek1);
    assert.equal(rec.kekId, "kek-1");
    assert.ok(!rec.ciphertext.includes("secret"));
    assert.equal(await decryptSecret(rec, ctx, kek1), token);
  });

  it("uses a fresh IV and data key per encryption", async () => {
    const a = await encryptSecret(token, ctx, kek1);
    const b = await encryptSecret(token, ctx, kek1);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.notEqual(a.wrappedDek, b.wrappedDek);
  });

  it("fails to decrypt under a different tenant or integration (AAD binding)", async () => {
    const rec = await encryptSecret(token, ctx, kek1);
    await assert.rejects(decryptSecret(rec, { ...ctx, tenantId: "tenant-b" }, kek1));
    await assert.rejects(decryptSecret(rec, { ...ctx, integrationId: "int-2" }, kek1));
  });

  it("detects tampering", async () => {
    const rec = await encryptSecret(token, ctx, kek1);
    const ct = Buffer.from(rec.ciphertext, "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    await assert.rejects(decryptSecret({ ...rec, ciphertext: ct.toString("base64") }, ctx, kek1));
  });

  it("rejects truncated auth tags", async () => {
    const rec = await encryptSecret(token, ctx, kek1);
    const shortTag = Buffer.from(rec.authTag, "base64").subarray(0, 4).toString("base64");
    await assert.rejects(decryptSecret({ ...rec, authTag: shortTag }, ctx, kek1), /auth tag length/);
  });

  it("rotates the KEK without re-encrypting the secret", async () => {
    const rec = await encryptSecret(token, ctx, kek1);
    const rotated = await rewrapSecret(rec, ctx, kek1, kek2);
    assert.equal(rotated.kekId, "kek-2");
    assert.equal(rotated.ciphertext, rec.ciphertext);
    assert.equal(await decryptSecret(rotated, ctx, new Map([["kek-1", kek1], ["kek-2", kek2]])), token);
    await assert.rejects(decryptSecret(rotated, ctx, kek1), /No KEK/);
  });

  it("refuses the local KEK in production and short keys", () => {
    assert.throws(() => LocalKekProvider.fromEnv({ NODE_ENV: "production", LOCAL_KEK_BASE64: randomBytes(32).toString("base64") }), /production/);
    assert.throws(() => new LocalKekProvider(randomBytes(16), "short"), /32 bytes/);
  });
});
