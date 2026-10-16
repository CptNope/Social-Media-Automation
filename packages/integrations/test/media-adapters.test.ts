import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BlueskyAdapter, FacebookPagesAdapter, InstagramAdapter, PinterestAdapter, PublishError, TikTokAdapter, YouTubeAdapter, linkFacet, tiktokChunks, type PublishableMedia } from "../src/index.ts";

type Reply = { status?: number; json?: unknown; headers?: Record<string, string>; text?: string };
function fakeFetch(handler: (url: URL, init: RequestInit) => Reply | Promise<Reply>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const f = (async (u: string, init: RequestInit = {}) => {
    const url = new URL(u);
    calls.push({ url, init });
    const r = await handler(url, init);
    return new Response(r.text ?? (r.json === undefined ? null : JSON.stringify(r.json)), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return { f, calls };
}
const kind = (k: string) => (e: unknown) => e instanceof PublishError && e.kind === k;
const noSleep = async () => {};
const image = (over: Partial<PublishableMedia> = {}): PublishableMedia => ({ kind: "image", mime: "image/jpeg", size: 9, width: 1080, height: 1350, durationMs: null, altText: "Technician wrapping a pipe", sha256: "a".repeat(64), bytes: async () => Buffer.from("jpeg-bytes"), publicUrl: async () => "https://media.example/signed/x.jpg?sig=1", ...over });
const video = (size = 12, over: Partial<PublishableMedia> = {}): PublishableMedia => ({ kind: "video", mime: "video/mp4", size, width: 1080, height: 1920, durationMs: 20_000, altText: null, sha256: "b".repeat(64), bytes: async () => Buffer.alloc(size, 1), publicUrl: async () => "https://media.example/v.mp4", ...over });
const post = (media: PublishableMedia | null, link = true) => ({ text: "Three checks before the first hard freeze.", title: "Three checks", link: link ? { url: "https://acme.example/w?utm_source=x&utm_medium=social&utm_campaign=w", title: "Three checks", description: "" } : null, idempotencyKey: "k", media });
const fbApp = { appId: "app", appSecret: "secret", version: "v26.0", redirectUri: "https://app.example/oauth/instagram/callback" };

describe("Instagram adapter", () => {
  const cred = { igUserId: "1784", username: "acme", pageId: "111", pageAccessToken: "PAGE", userAccessToken: "USER" };

  it("lists Instagram accounts linked to the person's Pages", async () => {
    const { f } = fakeFetch((url) => {
      if (url.pathname.endsWith("/oauth/access_token")) return { json: { access_token: url.searchParams.get("grant_type") ? "LONG" : "SHORT" } };
      assert.match(url.searchParams.get("fields")!, /instagram_business_account\{id,username\}/);
      return { json: { data: [{ id: "111", name: "Acme Page", access_token: "PAGE", instagram_business_account: { id: "1784", username: "acme" } }, { id: "222", name: "No IG", access_token: "P2" }] } };
    });
    const accts = await new InstagramAdapter(fbApp, f).accountsFromCode({ code: "c" });
    assert.deepEqual(accts.map((a) => [a.id, a.name]), [["1784", "@acme (via Acme Page)"]]);
    assert.deepEqual(accts[0]!.credential, { ...cred, userAccessToken: "LONG" });
  });

  it("image: container from a short-lived URL with alt text, waits until ready, publishes once", async () => {
    let polls = 0;
    const { f, calls } = fakeFetch((url, init) => {
      if (url.pathname.endsWith("/1784/media")) return { json: { id: "C1" } };
      if (url.pathname.endsWith("/C1")) return { json: { status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" } };
      if (url.pathname.endsWith("/media_publish")) return { json: { id: "M1" } };
      return { json: { permalink: "https://www.instagram.com/p/abc/" } };
    });
    const r = await new InstagramAdapter(fbApp, f, noSleep).publish(post(image()), cred);
    const container = new URLSearchParams(String(calls[0]!.init.body));
    assert.equal(container.get("image_url"), "https://media.example/signed/x.jpg?sig=1");
    assert.equal(container.get("alt_text"), "Technician wrapping a pipe");
    assert.equal(container.get("caption"), "Three checks before the first hard freeze.");
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/media_publish")).length, 1);
    assert.deepEqual(r, { externalId: "M1", permalink: "https://www.instagram.com/p/abc/" });
  });

  it("falls back to the user token if the Page token can't create containers", async () => {
    const { f, calls } = fakeFetch((url, init) => {
      const token = new URLSearchParams(String(init.body ?? "")).get("access_token") ?? url.searchParams.get("access_token");
      if (url.pathname.endsWith("/1784/media")) return token === "PAGE" ? { status: 400, json: { error: { message: "perm", code: 10 } } } : { json: { id: "C1" } };
      if (url.pathname.endsWith("/C1")) return { json: { status_code: "FINISHED" } };
      if (url.pathname.endsWith("/media_publish")) {
        assert.equal(token, "USER");
        return { json: { id: "M1" } };
      }
      return { json: {} };
    });
    assert.equal((await new InstagramAdapter(fbApp, f, noSleep).publish(post(image()), cred)).externalId, "M1");
    assert.equal(calls.filter((c) => c.url.pathname.endsWith("/1784/media")).length, 2);
  });

  it("Reels: resumable upload of the bytes, then publish", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.hostname === "rupload.facebook.com") return { json: { success: true } };
      if (url.pathname.endsWith("/1784/media")) return { json: { id: "C2" } };
      if (url.pathname.endsWith("/C2")) return { json: { status_code: "FINISHED" } };
      if (url.pathname.endsWith("/media_publish")) return { json: { id: "M2" } };
      return { json: {} };
    });
    await new InstagramAdapter(fbApp, f, noSleep).publish(post(video()), cred);
    assert.equal(new URLSearchParams(String(calls[0]!.init.body)).get("media_type"), "REELS");
    const up = calls.find((c) => c.url.hostname === "rupload.facebook.com")!;
    assert.equal(up.url.pathname, "/ig-api-upload/C2");
    assert.equal((up.init.headers as Record<string, string>).file_size, "12");
    assert.equal((up.init.headers as Record<string, string>).authorization, "OAuth PAGE");
  });

  it("refuses non-JPEG images and text-only posts; never retries an uncertain publish; retries the daily limit later", async () => {
    const never = fakeFetch(() => assert.fail("no call"));
    await assert.rejects(new InstagramAdapter(fbApp, never.f, noSleep).publish(post(image({ mime: "image/png" })), cred), kind("permanent"));
    await assert.rejects(new InstagramAdapter(fbApp, never.f, noSleep).publish(post(null), cred), kind("permanent"));
    const pub = (reply: Reply) => fakeFetch((url) => (url.pathname.endsWith("/1784/media") ? { json: { id: "C1" } } : url.pathname.endsWith("/C1") ? { json: { status_code: "FINISHED" } } : reply));
    await assert.rejects(new InstagramAdapter(fbApp, pub({ status: 500, json: { error: { message: "x", code: 2 } } }).f, noSleep).publish(post(image()), cred), kind("ambiguous"));
    await assert.rejects(new InstagramAdapter(fbApp, pub({ status: 400, json: { error: { message: "limit", code: 9, error_subcode: 2207042 } } }).f, noSleep).publish(post(image()), cred), (e: unknown) => e instanceof PublishError && e.kind === "transient" && (e.retryAfterMs ?? 0) >= 3_600_000);
    const failed = fakeFetch((url) => (url.pathname.endsWith("/1784/media") ? { json: { id: "C1" } } : { json: { status_code: "ERROR", status: "Error: Media download has failed" } }));
    await assert.rejects(new InstagramAdapter(fbApp, failed.f, noSleep).publish(post(image()), cred), kind("permanent"));
  });
});

describe("Pinterest adapter", () => {
  const app = { clientId: "pid", clientSecret: "psecret", redirectUri: "https://app.example/oauth/pinterest/callback" };
  const cred = { boardId: "555", boardName: "Home care tips", username: "acme", accessToken: "AT", refreshToken: "pinrRT" };

  it("lists boards as the things to connect, with continuous refresh tokens kept alive", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.pathname === "/v5/oauth/token") return { json: { access_token: "AT", refresh_token: "pinrRT", expires_in: 2_592_000 } };
      if (url.pathname === "/v5/user_account") return { json: { username: "acme" } };
      return { json: { items: [{ id: "555", name: "Home care tips", privacy: "PUBLIC" }, { id: "777", name: "Drafts", privacy: "SECRET" }], bookmark: null } };
    });
    const p = new PinterestAdapter(app, f);
    const accts = await p.accountsFromCode({ code: "c" });
    assert.deepEqual(accts.map((a) => a.name), ["Home care tips", "Drafts (secret)"]);
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Basic ${Buffer.from("pid:psecret").toString("base64")}`);
    assert.equal(p.refresh.keepAlive, true);
  });

  it("creates an image pin from base64 with title, link and alt text", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, json: { id: "9001" } }));
    const r = await new PinterestAdapter(app, f).publish(post(image()), cred);
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.equal(body.board_id, "555");
    assert.equal(body.title, "Three checks");
    assert.equal(body.alt_text, "Technician wrapping a pipe");
    assert.deepEqual(body.media_source, { source_type: "image_base64", content_type: "image/jpeg", data: Buffer.from("jpeg-bytes").toString("base64") });
    assert.deepEqual(r, { externalId: "9001", permalink: "https://www.pinterest.com/pin/9001/" });
  });

  it("video pins: register, upload to Pinterest's storage, wait, then pin", async () => {
    let polls = 0;
    const { f, calls } = fakeFetch((url) => {
      if (url.pathname === "/v5/media") return { status: 201, json: { media_id: "M7", upload_url: "https://pinterest-media-upload.s3.amazonaws.com/", upload_parameters: { key: "uploads/x", policy: "p", "x-amz-signature": "s" } } };
      if (url.hostname.endsWith("amazonaws.com")) return { status: 204 };
      if (url.pathname === "/v5/media/M7") return { json: { status: ++polls < 2 ? "processing" : "succeeded" } };
      return { status: 201, json: { id: "9002" } };
    });
    await new PinterestAdapter(app, f, noSleep).publish(post(video()), cred);
    const upload = calls.find((c) => c.url.hostname.endsWith("amazonaws.com"))!;
    const form = upload.init.body as FormData;
    assert.equal(form.get("key"), "uploads/x");
    assert.ok(form.get("file") instanceof Blob);
    assert.equal((upload.init.headers as Record<string, string> | undefined)?.authorization, undefined, "no bearer token sent to storage");
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)).media_source, { source_type: "video_id", media_id: "M7", cover_image_key_frame_time: 1 });
  });

  it("classifies errors; server errors on the pin itself are uncertain", async () => {
    const run = (status: number) => new PinterestAdapter(app, fakeFetch(() => ({ status, json: { code: 1, message: "x" } })).f).publish(post(image()), cred);
    await assert.rejects(run(401), kind("auth"));
    await assert.rejects(run(403), kind("permission"));
    await assert.rejects(run(429), kind("transient"));
    await assert.rejects(run(400), kind("permanent"));
    await assert.rejects(run(502), kind("ambiguous"));
  });
});

describe("TikTok adapter (upload to the creator's drafts)", () => {
  const app = { clientKey: "ck", clientSecret: "cs", redirectUri: "https://app.example/oauth/tiktok/callback" };
  const cred = { openId: "open-1", displayName: "Acme", accessToken: "AT", refreshToken: "RT" };

  it("splits files per TikTok's chunk rules", () => {
    const MB = 1024 * 1024;
    assert.deepEqual(tiktokChunks(3 * MB), { chunkSize: 3 * MB, count: 1 });
    assert.deepEqual(tiktokChunks(8 * MB), { chunkSize: 8 * MB, count: 1 });
    assert.deepEqual(tiktokChunks(25 * MB), { chunkSize: 10 * MB, count: 2 });
  });

  it("uploads in ordered chunks with Content-Range, then reports it's in the drafts", async () => {
    const size = 25 * 1024 * 1024;
    const { f, calls } = fakeFetch((url) => {
      if (url.pathname === "/v2/post/publish/inbox/video/init/") return { json: { data: { publish_id: "v_inbox_1", upload_url: "https://open-upload.tiktokapis.com/upload/?id=1" }, error: { code: "ok" } } };
      if (url.hostname === "open-upload.tiktokapis.com") return { status: 201 };
      return { json: { data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } } };
    });
    const r = await new TikTokAdapter(app, f, noSleep).publish(post(video(size)), cred);
    const init = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(init.source_info, { source: "FILE_UPLOAD", video_size: size, chunk_size: 10 * 1024 * 1024, total_chunk_count: 2 });
    const puts = calls.filter((c) => c.url.hostname === "open-upload.tiktokapis.com").map((c) => (c.init.headers as Record<string, string>)["content-range"]);
    assert.deepEqual(puts, [`bytes 0-${10 * 1024 * 1024 - 1}/${size}`, `bytes ${10 * 1024 * 1024}-${size - 1}/${size}`]);
    assert.equal(r.externalId, "v_inbox_1");
    assert.match(r.note!, /TikTok drafts/);
  });

  it("a failing status check after a finished upload is success with a note, never a resend", async () => {
    const { f, calls } = fakeFetch((url) => {
      if (url.pathname === "/v2/post/publish/inbox/video/init/") return { json: { data: { publish_id: "v_inbox_2", upload_url: "https://open-upload.tiktokapis.com/upload/?id=2" }, error: { code: "ok" } } };
      if (url.hostname === "open-upload.tiktokapis.com") return { status: 201 };
      return { status: 503, json: { error: { code: "internal_error", message: "down" } } };
    });
    const r = await new TikTokAdapter(app, f, noSleep).publish(post(video()), cred);
    assert.equal(r.externalId, "v_inbox_2");
    assert.match(r.note!, /couldn't confirm/);
    assert.equal(calls.filter((c) => c.url.pathname === "/v2/post/publish/inbox/video/init/").length, 1);
  });

  it("checks error codes even on HTTP 200, and rotates refresh tokens", async () => {
    const err = fakeFetch(() => ({ json: { data: {}, error: { code: "access_token_invalid", message: "expired" } } }));
    await assert.rejects(new TikTokAdapter(app, err.f, noSleep).publish(post(video()), cred), kind("auth"));
    const spam = fakeFetch(() => ({ status: 403, json: { error: { code: "spam_risk_too_many_pending_share", message: "x" } } }));
    await assert.rejects(new TikTokAdapter(app, spam.f, noSleep).publish(post(video()), cred), kind("transient"));
    await assert.rejects(new TikTokAdapter(app, fakeFetch(() => assert.fail()).f).publish(post(image()), cred), kind("permanent"));
    const rot = fakeFetch(() => ({ json: { access_token: "AT2", refresh_token: "RT2", expires_in: 86400, open_id: "open-1" } }));
    assert.deepEqual((await new TikTokAdapter(app, rot.f).refresh.run(cred)).credential, { ...cred, accessToken: "AT2", refreshToken: "RT2" });
  });
});

describe("YouTube adapter", () => {
  const app = { clientId: "gid", clientSecret: "gs", redirectUri: "https://app.example/oauth/youtube/callback" };
  const cred = { channelId: "UC1", title: "Acme Plumbing", accessToken: "AT", refreshToken: "RT" };
  const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=XYZ";

  it("opens a resumable session with metadata, uploads, and links the video", async () => {
    const { f, calls } = fakeFetch((url, init) => {
      if (init.method === "POST") return { status: 200, headers: { location: SESSION } };
      return { status: 201, json: { id: "vid123", status: { privacyStatus: "public" } } };
    });
    const r = await new YouTubeAdapter(app, f).publish({ ...post(video()), text: "Pipes <freeze> fast", title: "Three <checks>" }, cred);
    const meta = JSON.parse(String(calls[0]!.init.body));
    assert.equal(meta.snippet.title, "Three checks");
    assert.match(meta.snippet.description, /^Pipes freeze fast\n\nhttps:\/\/acme\.example/);
    assert.equal(meta.status.selfDeclaredMadeForKids, false);
    assert.equal((calls[0]!.init.headers as Record<string, string>)["x-upload-content-length"], "12");
    assert.deepEqual(r, { externalId: "vid123", permalink: "https://www.youtube.com/watch?v=vid123" });
  });

  it("an interrupted upload is checked, not repeated: finished → success; partial → resumed once", async () => {
    let n = 0;
    const finished = fakeFetch((url, init): Reply => {
      if (init.method === "POST") return { headers: { location: SESSION } };
      if (++n === 1) return { status: 503, json: {} };
      assert.equal((init.headers as Record<string, string>)["content-range"], "bytes */12");
      return { status: 201, json: { id: "vid9" } };
    });
    assert.equal((await new YouTubeAdapter(app, finished.f).publish(post(video()), cred)).externalId, "vid9");
    let m = 0;
    const partial = fakeFetch((url, init): Reply => {
      if (init.method === "POST") return { headers: { location: SESSION } };
      m++;
      if (m === 1) return { status: 502, json: {} };
      if (m === 2) return { status: 308, headers: { range: "bytes=0-4" } };
      assert.equal((init.headers as Record<string, string>)["content-range"], "bytes 5-11/12");
      return { status: 201, json: { id: "vid10" } };
    });
    assert.equal((await new YouTubeAdapter(app, partial.f).publish(post(video()), cred)).externalId, "vid10");
    const unknown = fakeFetch((url, init) => (init.method === "POST" ? { headers: { location: SESSION } } : { status: 500, json: {} }));
    await assert.rejects(new YouTubeAdapter(app, unknown.f).publish(post(video()), cred), kind("ambiguous"));
  });

  it("quota errors wait; images are refused; reports forced-private uploads", async () => {
    const quota = fakeFetch(() => ({ status: 403, json: { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } } }));
    await assert.rejects(new YouTubeAdapter(app, quota.f).publish(post(video()), cred), kind("transient"));
    await assert.rejects(new YouTubeAdapter(app).publish(post(image()), cred), kind("permanent"));
    const priv = fakeFetch((url, init) => (init.method === "POST" ? { headers: { location: SESSION } } : { status: 201, json: { id: "v", status: { privacyStatus: "private" } } }));
    assert.match((await new YouTubeAdapter(app, priv.f).publish(post(video()), cred)).note!, /private/);
  });
});

describe("images on Facebook and Bluesky", () => {
  it("Facebook uploads the photo with the request and puts the link in the message", async () => {
    const { f, calls } = fakeFetch(() => ({ json: { id: "PH1", post_id: "111_222" } }));
    const r = await new FacebookPagesAdapter({ ...fbApp, redirectUri: "x" }, f).publish(post(image()), { pageId: "111", pageName: "Acme", pageAccessToken: "PAGE" });
    assert.equal(calls[0]!.url.pathname, "/v26.0/111/photos");
    const form = calls[0]!.init.body as FormData;
    assert.match(String(form.get("message")), /\n\nhttps:\/\/acme\.example/);
    assert.ok(form.get("source") instanceof Blob);
    assert.deepEqual(r, { externalId: "111_222", permalink: "https://www.facebook.com/111/posts/222" });
  });

  it("Bluesky uploads the image blob, embeds it with alt text, and turns the link into a facet", async () => {
    const DID_DOC = { service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example" }] };
    const { f, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith("createSession")) return { json: { did: "did:plc:a", handle: "acme.bsky.social", accessJwt: "A", refreshJwt: "R", didDoc: DID_DOC } };
      if (url.pathname.endsWith("uploadBlob")) return { json: { blob: { $type: "blob", ref: { $link: "bafk" }, mimeType: "image/jpeg", size: 10 } } };
      return { json: { uri: "at://did:plc:a/app.bsky.feed.post/3k" } };
    });
    await new BlueskyAdapter(f).publish(post(image()), { identifier: "acme.bsky.social", appPassword: "p" });
    const upload = calls.find((c) => c.url.pathname.endsWith("uploadBlob"))!;
    assert.equal((upload.init.headers as Record<string, string>)["content-type"], "image/jpeg");
    const rec = JSON.parse(String(calls.at(-1)!.init.body)).record;
    assert.equal(rec.embed.$type, "app.bsky.embed.images");
    assert.equal(rec.embed.images[0].alt, "Technician wrapping a pipe");
    assert.deepEqual(rec.embed.images[0].aspectRatio, { width: 1080, height: 1350 });
    const url = post(null).link!.url;
    assert.ok(rec.text.endsWith(url));
    assert.deepEqual(rec.facets, [linkFacet(rec.text, url)]);
    assert.equal(Buffer.from(rec.text).subarray(rec.facets[0].index.byteStart, rec.facets[0].index.byteEnd).toString(), url);
    await assert.rejects(new BlueskyAdapter(f).publish(post(image({ size: 2_000_000 })), { identifier: "acme.bsky.social", appPassword: "p" }), kind("permanent"));
  });
});
