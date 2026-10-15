import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PostDraft, PostMedia } from "@jat/core";
import { getAsset, getContentItem, insertAsset, lockContentItem, type Database, type MemberRole } from "@jat/db";
import { GRAPHIC_SIZES, UnsupportedMediaError, graphicHtml, isMediaKey, newMediaKey, probeFile, verifyLocalSignature, type GraphicRenderer, type MediaInfo, type MediaStore } from "@jat/media";
import { loadBrandContext } from "./content-jobs.ts";
import { reviseItem, type RouteCtx } from "./content-routes.ts";
import { HttpError, redirect, type Req, type Router } from "./http.ts";
import type { JobRunner } from "./jobs.ts";

/** Media storage and rendering for the web tier. */
export interface MediaConfig {
  store: MediaStore;
  /** Upload size cap (bytes). */
  maxUploadBytes: number;
  /** Branded graphics from creative briefs; null when Chromium isn't available. */
  renderer: GraphicRenderer | null;
  /** Local store only: the secret behind `/media/signed/...` URLs. */
  localSigningSecret?: Buffer;
}

export interface MediaKit {
  router: Router;
  workspace: (req: Req) => Promise<RouteCtx>;
  idParam: (req: Req, name: string) => string;
  jobs: JobRunner;
  db: Database;
  media: MediaConfig | null;
  log: (msg: string, err?: unknown) => void;
}

const EDIT: MemberRole[] = ["agency_operator", "client_owner", "client_editor"];
const EDITABLE = ["draft", "in_review", "approved"];
const MIME_BY_EXT: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/**
 * Serve a file with single-range support: Safari and iOS won't play video without it,
 * and platforms that fetch by URL may ask for ranges too.
 */
export function ranged(req: Pick<Req, "headers">, body: Buffer, headers: Record<string, string>): { status: number; headers: Record<string, string>; body: Buffer } {
  const base: Record<string, string> = { ...headers, "accept-ranges": "bytes" };
  const h = req.headers["range"];
  const m = typeof h === "string" ? /^bytes=(\d*)-(\d*)$/.exec(h.trim()) : null;
  if (!m || (!m[1] && !m[2])) return { status: 200, headers: base, body };
  const size = body.length;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return { status: 416, headers: { ...base, "content-range": `bytes */${size}` }, body: Buffer.alloc(0) };
  return { status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}` }, body: body.subarray(start, end + 1) };
}

export function toPostMedia(assetId: string, info: Pick<MediaInfo, "kind" | "mime" | "sha256" | "bytes" | "width" | "height" | "durationMs">, origin: PostMedia["origin"]): PostMedia {
  return { asset_id: assetId, kind: info.kind, mime: info.mime, sha256: info.sha256, bytes: info.bytes, width: info.width, height: info.height, duration_ms: info.durationMs, origin };
}

export function registerMediaRoutes(kit: MediaKit): void {
  const { router, workspace, idParam } = kit;

  const need = (): MediaConfig => {
    if (!kit.media) throw new HttpError(400, "Media storage isn't configured on this server.");
    return kit.media;
  };

  /**
   * Store a file and attach it to the post as a new version (approval dropped). The base hash
   * must match what the person saw, so a stale page can't overwrite newer changes.
   */
  async function attach(ctx: RouteCtx, itemId: string, baseHash: string, file: string, info: MediaInfo, origin: PostMedia["origin"], altText: string | null): Promise<"ok" | "stale" | "unchanged"> {
    const m = need();
    const key = newMediaKey(ctx.tenantId, info.mime);
    await m.store.put(key, { path: file }, info.mime);
    return ctx.tx(async (q) => {
      const item = await lockContentItem(q, itemId);
      if (!item?.body) throw new HttpError(404, "Not found");
      if (item.contentHash !== baseHash || !EDITABLE.includes(item.state)) return "stale" as const;
      const assetId = await insertAsset(q, { tenantId: ctx.tenantId, brandId: item.brandId, kind: info.kind === "video" ? "video" : origin === "rendered" ? "graphic" : "photo", storageKey: key, mime: info.mime, width: info.width, height: info.height, sha256: info.sha256, bytes: info.bytes, durationMs: info.durationMs, origin, altText, createdBy: ctx.s.userId });
      const prev = item.body as PostDraft;
      return reviseItem(q, ctx, item, { ...prev, media: [toPostMedia(assetId, info, origin)], ...(info.kind === "image" ? { alt_text: altText ?? prev.alt_text ?? null } : {}) }, "content.media_attached", { assetId, origin, sha256: info.sha256 });
    });
  }

  const back = (ctx: RouteCtx, itemId: string, m: string) => redirect(`/w/${ctx.tenantId}/content/${itemId}?m=${m}#media`);

  router.post("/w/:tenantId/content/:itemId/media/upload", async (req) => {
    const ctx = await workspace(req);
    if (!EDIT.includes(ctx.role)) throw new HttpError(403, "Your role doesn't allow this action.");
    const itemId = idParam(req, "itemId");
    const file = req.files?.find((f) => f.field === "file");
    if (!file || file.bytes === 0) throw new HttpError(400, "Choose a photo or video to upload.");
    let info: MediaInfo;
    try {
      info = await probeFile(file.path);
    } catch (err) {
      if (err instanceof UnsupportedMediaError) throw new HttpError(415, err.message);
      throw err;
    }
    const alt = (req.form.get("alt_text") ?? "").trim().slice(0, 1000) || null;
    const r = await attach(ctx, itemId, req.form.get("base_hash") ?? "", file.path, info, "uploaded", alt);
    return back(ctx, itemId, r === "ok" ? "media_added" : r === "unchanged" ? "unchanged" : "stale");
  });

  router.post("/w/:tenantId/content/:itemId/media/generate", async (req) => {
    const ctx = await workspace(req);
    if (!EDIT.includes(ctx.role)) throw new HttpError(403, "Your role doesn't allow this action.");
    const m = need();
    if (!m.renderer) throw new HttpError(400, "The graphics renderer isn't available on this server (it needs Chromium).");
    const itemId = idParam(req, "itemId");
    const item = await ctx.tx((q) => getContentItem(q, itemId));
    const post = item?.body as PostDraft | null;
    if (!item || !post) throw new HttpError(404, "Not found");
    if (!post.creative_brief?.headline) throw new HttpError(400, "This post has no creative brief to make a graphic from.");
    const brand = await ctx.tx((q) => loadBrandContext(q, item.brandId));
    const v = brand.dna.visual;
    const tokens = {
      brandName: brand.dna.identity.display_name.value ?? "",
      colors: (v.colors.value ?? []).map((c) => ({ hex: c.hex, role: c.role })),
      fonts: (v.typography.value ?? []).map((f) => ({ family: f.family, role: f.role })),
    };
    const size = GRAPHIC_SIZES[item.channel] ?? GRAPHIC_SIZES.default!;
    const jpg = await m.renderer.renderJpeg(graphicHtml(tokens, { headline: post.creative_brief.headline, ...(post.creative_brief.supporting_text ? { supportingText: post.creative_brief.supporting_text } : {}) }, size), size);
    const dir = await mkdtemp(join(tmpdir(), "jat-gfx-"));
    try {
      const path = join(dir, "graphic.jpg");
      await writeFile(path, jpg);
      const r = await attach(ctx, itemId, req.form.get("base_hash") ?? "", path, await probeFile(path), "rendered", post.alt_text ?? `${post.creative_brief.headline}`.slice(0, 250));
      return back(ctx, itemId, r === "ok" ? "graphic_added" : r === "unchanged" ? "unchanged" : "stale");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  router.post("/w/:tenantId/content/:itemId/media/remove", async (req) => {
    const ctx = await workspace(req);
    if (!EDIT.includes(ctx.role)) throw new HttpError(403, "Your role doesn't allow this action.");
    const itemId = idParam(req, "itemId");
    const baseHash = req.form.get("base_hash") ?? "";
    const r = await ctx.tx(async (q) => {
      const item = await lockContentItem(q, itemId);
      if (!item?.body) throw new HttpError(404, "Not found");
      if (item.contentHash !== baseHash || !EDITABLE.includes(item.state)) return "stale" as const;
      const { media: _drop, ...rest } = item.body as PostDraft;
      return reviseItem(q, ctx, item, rest, "content.media_removed");
    });
    return back(ctx, itemId, r === "ok" ? "media_removed" : r === "unchanged" ? "unchanged" : "stale");
  });

  /** Preview for signed-in members of the workspace (RLS scopes the asset lookup). */
  router.get("/w/:tenantId/media/:assetId", async (req) => {
    const ctx = await workspace(req);
    const m = need();
    const asset = await ctx.tx((q) => getAsset(q, idParam(req, "assetId")));
    if (!asset || !isMediaKey(asset.storageKey) || !asset.storageKey.startsWith(`t/${ctx.tenantId}/`)) throw new HttpError(404, "Not found");
    return ranged(req, await m.store.get(asset.storageKey), { "content-type": asset.mime, "content-disposition": "inline", "cache-control": "private, max-age=600" });
  });

  /** Local store only: time-limited public URLs for platforms that fetch media by URL. */
  router.get("/media/signed/t/:tenant/:file", async (req) => {
    const m = kit.media;
    const key = `t/${req.params.tenant ?? ""}/${req.params.file ?? ""}`;
    if (!m?.localSigningSecret || !verifyLocalSignature(m.localSigningSecret, key, req.url.searchParams.get("exp"), req.url.searchParams.get("sig"))) throw new HttpError(404, "Not found");
    const ext = key.split(".").pop() ?? "";
    return ranged(req, await m.store.get(key), { "content-type": MIME_BY_EXT[ext] ?? "application/octet-stream", "cache-control": "private, max-age=300" });
  });
}
