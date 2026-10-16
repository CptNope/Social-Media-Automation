import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ranged } from "../src/media-routes.ts";
import { publishBlocker, publishableMedia } from "../src/publisher.ts";
import { PublishError } from "@jat/integrations";
import type { MediaStore } from "@jat/media";

const req = (range?: string) => ({ headers: range ? { range } : {} }) as { headers: Record<string, string> };
const body = Buffer.from("0123456789");

describe("media preview ranges", () => {
  it("serves whole files, single ranges, suffixes, and refuses impossible ranges", () => {
    const whole = ranged(req(), body, { "content-type": "video/mp4" });
    assert.equal(whole.status, 200);
    assert.equal(whole.headers["accept-ranges"], "bytes");
    const part = ranged(req("bytes=2-5"), body, {});
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], "bytes 2-5/10");
    assert.equal(part.body.toString(), "2345");
    assert.equal(ranged(req("bytes=7-"), body, {}).body.toString(), "789");
    assert.equal(ranged(req("bytes=-3"), body, {}).body.toString(), "789");
    assert.equal(ranged(req("bytes=8-100"), body, {}).body.toString(), "89");
    const bad = ranged(req("bytes=20-"), body, {});
    assert.equal(bad.status, 416);
    assert.equal(bad.headers["content-range"], "bytes */10");
    // Multiple ranges aren't supported: the whole file is sent.
    assert.equal(ranged(req("bytes=0-1,4-5"), body, {}).status, 200);
  });
});

describe("publishing media posts", () => {
  const base = { hook: "Hi", body: "Body", hashtags: [], cta: null, link: null, alt_text: "A photo", creative_brief: { headline: "H" } };
  const media = [{ asset_id: "a", kind: "video", mime: "video/mp4", sha256: "x".repeat(64), bytes: 10, width: 1080, height: 1920, duration_ms: 5000, origin: "uploaded" }];
  it("stories are blocked rather than going out as a regular post", () => {
    const msg = publishBlocker({ channel: "instagram", body: { ...base, format: "story", media } as never }, { status: "connected" });
    assert.match(msg!, /Stories can't be published automatically/);
    assert.equal(publishBlocker({ channel: "instagram", body: { ...base, format: "video", media } as never }, { status: "connected" }), null);
  });

  it("a storage failure is a retryable error; a changed file is not", async () => {
    const down = { get: async () => Promise.reject(new Error("R2 503")) } as unknown as MediaStore;
    const m = publishableMedia(down, "k", media[0] as never, null);
    await assert.rejects(m.bytes(), (e: unknown) => e instanceof PublishError && e.kind === "transient");
    const changed = { get: async () => Buffer.from("other"), signedGetUrl: async () => "https://x" } as unknown as MediaStore;
    const m2 = publishableMedia(changed, "k", media[0] as never, null);
    await assert.rejects(m2.publicUrl(), (e: unknown) => e instanceof PublishError && e.kind === "permanent");
  });
});
