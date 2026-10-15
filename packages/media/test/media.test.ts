import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMediaStore, R2MediaStore, UnsupportedMediaError, isMediaKey, newMediaKey, probeFile, verifyLocalSignature } from "../src/index.ts";

const fx = (n: string) => new URL(`./fixtures/${n}`, import.meta.url).pathname;
const T = "11111111-1111-4111-8111-111111111111";

describe("probeFile: identifies media from its bytes", () => {
  it("reads image types and sizes", async () => {
    const jpg = await probeFile(fx("portrait.jpg"));
    assert.deepEqual([jpg.kind, jpg.mime, jpg.width, jpg.height], ["image", "image/jpeg", 1080, 1350]);
    assert.match(jpg.sha256, /^[0-9a-f]{64}$/);
    const png = await probeFile(fx("wide.png"));
    assert.deepEqual([png.mime, png.width, png.height], ["image/png", 1200, 630]);
    const webp = await probeFile(fx("small.webp"));
    assert.deepEqual([webp.mime, webp.width, webp.height], ["image/webp", 400, 300]);
  });

  it("reads video type, dimensions and duration", async () => {
    const mp4 = await probeFile(fx("vertical.mp4"));
    assert.deepEqual([mp4.kind, mp4.mime, mp4.width, mp4.height], ["video", "video/mp4", 360, 640]);
    assert.ok(Math.abs(mp4.durationMs! - 2500) <= 60, `duration ${mp4.durationMs}`);
    const mov = await probeFile(fx("clip.mov"));
    assert.deepEqual([mov.mime, mov.width, mov.height], ["video/quicktime", 320, 240]);
    assert.equal((await probeFile(fx("clip.webm"))).mime, "video/webm");
  });

  it("rejects HEIC/audio ISO files and crafted videos quickly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jat-probe-"));
    const box = (type: string, body: Buffer = Buffer.alloc(0)) => {
      const h = Buffer.alloc(8);
      h.writeUInt32BE(8 + body.length);
      h.write(type, 4, "latin1");
      return Buffer.concat([h, body]);
    };
    const ftyp = (brand: string) => box("ftyp", Buffer.concat([Buffer.from(brand, "latin1"), Buffer.alloc(4)]));
    const write = (name: string, b: Buffer) => {
      const p = join(dir, name);
      writeFileSync(p, b);
      return p;
    };
    await assert.rejects(probeFile(write("photo.heic", Buffer.concat([ftyp("heic"), box("meta")]))), /HEIC/);
    await assert.rejects(probeFile(write("song.m4a", Buffer.concat([ftyp("M4A "), box("moov")]))), UnsupportedMediaError);
    // 30,000 empty tracks inside one moov: parsed in memory with a box budget, so it's fast.
    const bomb = write("bomb.mp4", Buffer.concat([ftyp("isom"), box("moov", Buffer.concat(Array.from({ length: 30_000 }, () => box("trak"))))]));
    const t0 = Date.now();
    await assert.rejects(probeFile(bomb), /no video track/);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    // Truncated files are reported as damaged, not a server error.
    await assert.rejects(probeFile(write("cut.mp4", readFileSync(fx("vertical.mp4")).subarray(0, 40))), UnsupportedMediaError);
  });

  it("rejects files that only pretend to be media", async () => {
    await assert.rejects(probeFile(fx("fake.jpg")), UnsupportedMediaError);
  });
});

describe("media stores", () => {
  it("keys are tenant-scoped and unguessable; anything else is refused", async () => {
    const k = newMediaKey(T, "image/jpeg");
    assert.ok(isMediaKey(k) && k.startsWith(`t/${T}/`));
    const store = new LocalMediaStore(mkdtempSync(join(tmpdir(), "jat-media-")), { secret: Buffer.alloc(32, 1), baseUrl: "https://app.example" });
    await assert.rejects(store.get("../../etc/passwd"), /invalid media key/);
    await assert.rejects(store.get(`t/${T}/../../x.jpg`), /invalid media key/);
  });

  it("local store round-trips files and signs expiring URLs", async () => {
    const secret = Buffer.alloc(32, 7);
    const now = new Date("2026-10-15T12:00:00Z");
    const store = new LocalMediaStore(mkdtempSync(join(tmpdir(), "jat-media-")), { secret, baseUrl: "https://app.example" }, () => now);
    const k = newMediaKey(T, "image/jpeg");
    await store.put(k, { path: fx("portrait.jpg") }, "image/jpeg");
    assert.equal((await store.get(k)).length, 8956);
    const u = new URL(await store.signedGetUrl(k, 3600));
    assert.equal(u.pathname, `/media/signed/${k}`);
    assert.ok(verifyLocalSignature(secret, k, u.searchParams.get("exp"), u.searchParams.get("sig"), now));
    assert.ok(!verifyLocalSignature(secret, k, u.searchParams.get("exp"), u.searchParams.get("sig"), new Date(now.getTime() + 3_601_000)), "expired");
    assert.ok(!verifyLocalSignature(secret, newMediaKey(T, "image/jpeg"), u.searchParams.get("exp"), u.searchParams.get("sig"), now), "other key");
    await store.delete(k);
    await assert.rejects(store.get(k));
  });

  it("R2 store sends SigV4-signed S3 requests and presigns GET URLs", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const f = (async (u: URL, init: RequestInit) => {
      calls.push({ url: String(u), method: init.method!, headers: init.headers as Record<string, string>, body: init.body });
      return new Response(init.method === "GET" ? "bytes" : null, { status: 200 });
    }) as unknown as typeof fetch;
    const r2 = new R2MediaStore({ accountId: "0123456789abcdef0123456789abcdef", bucket: "jat-media", accessKeyId: "AK", secretAccessKey: "SK" }, f, () => new Date("2026-10-15T12:00:00Z"));
    const k = newMediaKey(T, "image/png");
    await r2.put(k, { bytes: Buffer.from("png-bytes") }, "image/png");
    assert.equal(calls[0]!.url, `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/jat-media/${k}`);
    assert.match(calls[0]!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AK\/20261015\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(calls[0]!.headers["content-type"], "image/png");
    assert.equal((await r2.get(k)).toString(), "bytes");
    const signed = new URL(await r2.signedGetUrl(k, 3600));
    assert.equal(signed.searchParams.get("X-Amz-Expires"), "3600");
    assert.match(signed.searchParams.get("X-Amz-Signature")!, /^[0-9a-f]{64}$/);
    assert.throws(() => new R2MediaStore({ accountId: "nope", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }), /account id/);
  });
});
