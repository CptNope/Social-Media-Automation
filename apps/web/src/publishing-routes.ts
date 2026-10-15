import { randomBytes } from "node:crypto";
import { DEFAULT_TIMEZONE, transition, TransitionError, zonedToUtc, isCalendarDate, type ContentEvent } from "@jat/core";
import {
  appendAudit,
  createPublication,
  getCurrentTenant,
  getIntegration,
  globalPause,
  insertCredential,
  integrationForChannel,
  listIntegrations,
  listItemPublications,
  listRecentPublications,
  lockContentItem,
  lockLiveItemPublication,
  removeCredential,
  requestIntegrationCheck,
  setChannelPaused,
  setContentState,
  setIntegrationStatus,
  setTenantPaused,
  updatePublication,
  upsertIntegration,
  type ContentItemRow,
  type MemberRole,
  type QueryClient,
} from "@jat/db";
import { FACEBOOK_SCOPES, PublishError, type BlueskyCredential, type ChannelAdapter, type FacebookPagesAdapter } from "@jat/integrations";
import { encryptSecret, type KekProvider } from "@jat/vault";
import { machineState, type RouteCtx } from "./content-routes.ts";
import { HttpError, htmlResponse, parseCookies, redirect, serializeCookie, type Req, type Router } from "./http.ts";
import { checkIntegration, publishBlocker, type PublisherDeps } from "./publisher.ts";
import * as P from "./views/publishing.ts";

/** Everything the web tier needs for publishing. Absent → publishing isn't configured (export only). */
export interface PublishingConfig {
  /** PUBLISH_MODE (shown in the UI; the publisher enforces it). */
  mode: "live" | "dry_run";
  /** KEK used to encrypt newly stored credentials (the web role can insert credentials, never read them). */
  activeKek: KekProvider;
  /** Used to verify an app password before storing it. */
  bluesky: Pick<ChannelAdapter<BlueskyCredential>, "check">;
  /** Facebook app (OAuth); null when FACEBOOK_APP_ID/SECRET aren't set. */
  facebook: FacebookPagesAdapter | null;
  /**
   * The publisher, when it runs in this process (JAT_PROCESS=all). Null in a web-only process:
   * "Test connection" is then queued for the worker instead of reading credentials here.
   */
  publisher: PublisherDeps | null;
}

export interface PublishingKit {
  router: Router;
  workspace: (req: Req) => Promise<RouteCtx>;
  idParam: (req: Req, name: string) => string;
  requireUserId: (req: Req) => Promise<string>;
  config: PublishingConfig | null;
  secureCookies: boolean;
}

const MANAGE: MemberRole[] = ["agency_operator", "client_owner"];
const TZ = DEFAULT_TIMEZONE;
const FB_STATE_COOKIE = "jat_fb_state";
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 500;

const FLASH: Record<string, { kind: "ok" | "error"; message: string }> = {
  paused: { kind: "ok", message: "Publishing is paused for this client." },
  resumed: { kind: "ok", message: "Publishing resumed." },
  channel_paused: { kind: "ok", message: "Channel paused." },
  channel_resumed: { kind: "ok", message: "Channel resumed." },
  connected: { kind: "ok", message: "Connected." },
  disconnected: { kind: "ok", message: "Disconnected. Its stored credentials were deleted." },
  check_ok: { kind: "ok", message: "Connection works." },
  check_requested: { kind: "ok", message: "Connection check requested. Reload in a few seconds to see the result." },
  fb_denied: { kind: "error", message: "Facebook sign-in was cancelled." },
  fb_expired: { kind: "error", message: "That Facebook sign-in expired or didn't match this browser. Try again." },
};

/** Short-lived, server-side only. Page tokens never reach the browser. */
class PendingStore<T> {
  #m = new Map<string, { value: T; expires: number }>();
  put(value: T): string {
    const now = Date.now();
    for (const [k, v] of this.#m) if (v.expires < now) this.#m.delete(k);
    if (this.#m.size >= MAX_PENDING) throw new HttpError(503, "Too many sign-ins in progress. Try again in a few minutes.");
    const key = randomBytes(24).toString("base64url");
    this.#m.set(key, { value, expires: now + PENDING_TTL_MS });
    return key;
  }
  peek(key: string): T | null {
    const v = this.#m.get(key);
    if (!v || v.expires < Date.now()) return null;
    return v.value;
  }
  take(key: string): T | null {
    const v = this.peek(key);
    this.#m.delete(key);
    return v;
  }
}

export function registerPublishingRoutes(kit: PublishingKit): void {
  const { router, workspace, idParam } = kit;
  const cfg = kit.config;
  const oauthStates = new PendingStore<{ tenantId: string; userId: string }>();
  const pagePicks = new PendingStore<{ tenantId: string; userId: string; pages: Array<{ id: string; name: string; accessToken: string; canPost: boolean }> }>();

  const forbid = (): never => {
    throw new HttpError(403, "Your role doesn't allow this action.");
  };
  const manage = async (req: Req) => {
    const ctx = await workspace(req);
    if (!MANAGE.includes(ctx.role)) forbid();
    return ctx;
  };
  const needConfig = (): PublishingConfig => {
    if (!cfg) throw new HttpError(400, "Publishing isn't configured on this server.");
    return cfg;
  };
  const back = (ctx: RouteCtx, m: string, anchor = "") => redirect(`/w/${ctx.tenantId}/connections?m=${m}${anchor}`);

  async function storeConnection(ctx: RouteCtx, a: { channel: string; externalAccountId: string; displayName: string; secret: unknown; capabilities: Record<string, unknown>; scopes: string[]; status?: "connected" | "error" }) {
    const c = needConfig();
    await ctx.tx(async (q) => {
      const id = await upsertIntegration(q, { tenantId: ctx.tenantId, channel: a.channel, externalAccountId: a.externalAccountId, displayName: a.displayName, capabilities: a.capabilities, scopes: a.scopes, ...(a.status ? { status: a.status } : {}) });
      const rec = await encryptSecret(JSON.stringify(a.secret), { tenantId: ctx.tenantId, integrationId: id }, c.activeKek);
      await insertCredential(q, ctx.tenantId, id, rec);
      await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "integration.connected", entityType: "integration", entityId: id, after: { channel: a.channel, account: a.displayName } });
    });
  }

  // ------------------------------------------------------------------ page
  async function renderConnections(ctx: RouteCtx, flash: { kind: "ok" | "error"; message: string } | undefined, status = 200) {
    const d = await ctx.tx(async (q) => ({ tenant: (await getCurrentTenant(q))!, global: await globalPause(q), integrations: await listIntegrations(q), publications: await listRecentPublications(q, 30) }));
    return htmlResponse(
      P.connectionsPage(await ctx.shell("connections", "Connections"), {
        status: { configured: !!cfg, mode: cfg?.mode ?? "dry_run", tenantPublishingEnabled: d.tenant.publishingEnabled, tenantPausedAt: d.tenant.pausedAt, globalPaused: d.global.paused },
        integrations: d.integrations,
        publications: d.publications,
        canManage: MANAGE.includes(ctx.role),
        facebookConfigured: !!cfg?.facebook,
        flash,
      }),
      status,
    );
  }

  router.get("/w/:tenantId/connections", async (req) => {
    const ctx = await workspace(req);
    const k = req.url.searchParams.get("m") ?? "";
    return renderConnections(ctx, Object.hasOwn(FLASH, k) ? FLASH[k] : undefined);
  });

  // ------------------------------------------------------------------ pause switches
  router.post("/w/:tenantId/connections/pause", async (req) => {
    const ctx = await manage(req);
    const paused = req.form.get("paused") === "1";
    const reason = (req.form.get("reason") ?? "").trim().slice(0, 300) || null;
    await ctx.tx(async (q) => {
      await setTenantPaused(q, paused, reason);
      await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: paused ? "tenant.paused" : "tenant.resumed", entityType: "tenant", entityId: ctx.tenantId, after: { reason } });
    });
    return back(ctx, paused ? "paused" : "resumed");
  });

  for (const op of ["pause", "resume"] as const) {
    router.post(`/w/:tenantId/connections/:integrationId/${op}`, async (req) => {
      const ctx = await manage(req);
      const id = idParam(req, "integrationId");
      await ctx.tx(async (q) => {
        if (!(await getIntegration(q, id))) throw new HttpError(404, "Not found");
        await setChannelPaused(q, id, op === "pause");
        await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: `channel.${op === "pause" ? "paused" : "resumed"}`, entityType: "integration", entityId: id });
      });
      return back(ctx, op === "pause" ? "channel_paused" : "channel_resumed");
    });
  }

  router.post("/w/:tenantId/connections/:integrationId/disconnect", async (req) => {
    const ctx = await manage(req);
    const id = idParam(req, "integrationId");
    await ctx.tx(async (q) => {
      if (!(await getIntegration(q, id))) throw new HttpError(404, "Not found");
      await removeCredential(q, id);
      await setIntegrationStatus(q, id, "revoked");
      await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "integration.disconnected", entityType: "integration", entityId: id });
    });
    return back(ctx, "disconnected");
  });

  router.post("/w/:tenantId/connections/:integrationId/check", async (req) => {
    const ctx = await manage(req);
    const c = needConfig();
    const id = idParam(req, "integrationId");
    if (!c.publisher) {
      await ctx.tx(async (q) => {
        if (!(await getIntegration(q, id))) throw new HttpError(404, "Not found");
        await requestIntegrationCheck(q, id);
      });
      return back(ctx, "check_requested");
    }
    const r = await checkIntegration(c.publisher, { tenantId: ctx.tenantId, integrationId: id, userId: ctx.s.userId });
    // Rendered directly so the platform's error text is never reflected from a URL.
    return r.ok ? back(ctx, "check_ok") : renderConnections(ctx, { kind: "error", message: `Connection check failed: ${r.message}` }, 422);
  });

  // ------------------------------------------------------------------ Bluesky
  router.post("/w/:tenantId/connections/bluesky", async (req) => {
    const ctx = await manage(req);
    const c = needConfig();
    const identifier = (req.form.get("identifier") ?? "").trim().replace(/^@/, "").toLowerCase();
    const appPassword = (req.form.get("app_password") ?? "").trim();
    if (!/^[a-z0-9._:@-]{3,253}$/.test(identifier)) throw new HttpError(400, "Enter the Bluesky handle, like yourbusiness.bsky.social.");
    if (appPassword.length < 8 || appPassword.length > 64) throw new HttpError(400, "Enter a Bluesky app password (Settings → Privacy and security → App passwords).");
    let accountName: string;
    try {
      accountName = (await c.bluesky.check({ identifier, appPassword })).accountName;
    } catch (err) {
      const msg = err instanceof PublishError && err.kind === "auth" ? "Bluesky didn't accept that handle and app password." : `Couldn't reach Bluesky: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`;
      throw new HttpError(400, msg);
    }
    await storeConnection(ctx, { channel: "bluesky", externalAccountId: accountName.replace(/^@/, "").toLowerCase(), displayName: accountName, secret: { identifier, appPassword }, capabilities: { text: true, link_card: true }, scopes: ["app_password"] });
    return back(ctx, "connected", "#ch-bluesky");
  });

  // ------------------------------------------------------------------ WordPress
  router.post("/w/:tenantId/connections/wordpress", async (req) => {
    const ctx = await manage(req);
    needConfig();
    const raw = (req.form.get("site_url") ?? "").trim();
    const username = (req.form.get("username") ?? "").trim();
    const applicationPassword = (req.form.get("app_password") ?? "").trim();
    let site: URL;
    try {
      site = new URL(raw);
    } catch {
      throw new HttpError(400, "Enter the site address, starting with https://");
    }
    if (site.protocol !== "https:" || site.username || site.password || (site.port && site.port !== "443") || site.search || site.hash) throw new HttpError(400, "The site address must be a plain https:// address.");
    if (!username || username.length > 60) throw new HttpError(400, "Enter the WordPress username.");
    if (applicationPassword.length < 16 || applicationPassword.length > 64) throw new HttpError(400, "Enter a WordPress application password (24 characters, spaces allowed).");
    const siteUrl = `${site.origin}${site.pathname.replace(/\/$/, "")}`;
    const signingSecret = randomBytes(32).toString("base64url");
    await storeConnection(ctx, { channel: "wordpress", externalAccountId: siteUrl.toLowerCase(), displayName: siteUrl, secret: { siteUrl, username, applicationPassword, signingSecret }, capabilities: { seo: true, drafts: true }, scopes: ["application_password"], status: "error" });
    // Rendered directly (no redirect) so the secret is never in a URL; responses are no-store.
    return htmlResponse(P.wordpressSecretPage(await ctx.shell("connections", "Connect WordPress"), { siteUrl, secret: signingSecret }));
  });

  // ------------------------------------------------------------------ Facebook (OAuth)
  router.post("/w/:tenantId/connections/facebook/start", async (req) => {
    const ctx = await manage(req);
    const fb = needConfig().facebook;
    if (!fb) throw new HttpError(400, "Facebook isn't configured on this server.");
    const state = oauthStates.put({ tenantId: ctx.tenantId, userId: ctx.s.userId });
    return redirect(fb.authorizeUrl(state), { "set-cookie": serializeCookie(FB_STATE_COOKIE, state, { maxAgeSeconds: PENDING_TTL_MS / 1000, secure: kit.secureCookies }) });
  });

  router.get("/oauth/facebook/callback", async (req) => {
    const userId = await kit.requireUserId(req);
    const fb = needConfig().facebook;
    if (!fb) throw new HttpError(400, "Facebook isn't configured on this server.");
    const state = req.url.searchParams.get("state") ?? "";
    const cookieState = parseCookies(req.headers.cookie)[FB_STATE_COOKIE] ?? "";
    const pending = state && state === cookieState ? oauthStates.take(state) : null;
    const clear = { "set-cookie": serializeCookie(FB_STATE_COOKIE, "", { maxAgeSeconds: 0, secure: kit.secureCookies }) };
    if (!pending || pending.userId !== userId) throw new HttpError(400, FLASH.fb_expired!.message);
    if (req.url.searchParams.get("error")) return redirect(`/w/${pending.tenantId}/connections?m=fb_denied`, clear);
    const code = req.url.searchParams.get("code") ?? "";
    if (!code || code.length > 2000) throw new HttpError(400, FLASH.fb_expired!.message);
    let pages;
    try {
      pages = await fb.pagesFromCode(code);
    } catch (err) {
      throw new HttpError(502, `Facebook sign-in failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`);
    }
    const key = pagePicks.put({ tenantId: pending.tenantId, userId, pages });
    return redirect(`/w/${pending.tenantId}/connections/facebook/pick?k=${encodeURIComponent(key)}`, clear);
  });

  const pickFor = (ctx: RouteCtx, key: string) => {
    const p = pagePicks.peek(key);
    if (!p || p.userId !== ctx.s.userId || p.tenantId !== ctx.tenantId) throw new HttpError(400, FLASH.fb_expired!.message);
    return p;
  };

  router.get("/w/:tenantId/connections/facebook/pick", async (req) => {
    const ctx = await manage(req);
    const key = req.url.searchParams.get("k") ?? "";
    const p = pickFor(ctx, key);
    return htmlResponse(P.facebookPickPage(await ctx.shell("connections", "Choose a Page"), { key, pages: p.pages.map(({ id, name, canPost }) => ({ id, name, canPost })) }));
  });

  router.post("/w/:tenantId/connections/facebook/pick", async (req) => {
    const ctx = await manage(req);
    const key = req.form.get("k") ?? "";
    const page = pickFor(ctx, key).pages.find((x) => x.id === req.form.get("page_id"));
    if (!page || !page.canPost) throw new HttpError(400, "Pick a Page you can post to.");
    pagePicks.take(key);
    await storeConnection(ctx, { channel: "facebook", externalAccountId: page.id, displayName: page.name, secret: { pageId: page.id, pageName: page.name, pageAccessToken: page.accessToken }, capabilities: { text: true, link: true }, scopes: FACEBOOK_SCOPES });
    return back(ctx, "connected", "#ch-facebook");
  });

  // ------------------------------------------------------------------ scheduling (content items)
  /**
   * Lock order matches the publisher: the live publication first, then the item.
   * Returns "stale" when the state machine refuses (someone else changed the item).
   */
  async function itemTx(ctx: RouteCtx, itemId: string, fn: (q: QueryClient, item: ContentItemRow, live: Awaited<ReturnType<typeof lockLiveItemPublication>>) => Promise<{ event: ContentEvent; after?: (q: QueryClient) => Promise<void>; detail?: Record<string, unknown> } | string>): Promise<string> {
    try {
      return await ctx.tx(async (q) => {
        const live = await lockLiveItemPublication(q, itemId);
        const item = await lockContentItem(q, itemId);
        if (!item?.body) throw new HttpError(404, "Not found");
        const r = await fn(q, item, live);
        if (typeof r === "string") return r;
        const { next, audit } = transition(await machineState(q, item), r.event, { type: "user", id: ctx.s.userId });
        await setContentState(q, itemId, next.state, next.pausedFrom);
        if (r.after) await r.after(q);
        await appendAudit(q, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: audit.action, entityType: "content_item", entityId: itemId, before: audit.before, after: { ...audit.after, ...(audit.detail ?? {}), ...(r.detail ?? {}) } });
        return "ok";
      });
    } catch (err) {
      if (err instanceof TransitionError) return "stale";
      if (err instanceof Error && /publications_one_live/.test(err.message)) return "stale";
      throw err;
    }
  }

  const itemBack = (ctx: RouteCtx, itemId: string, m: string) => redirect(`/w/${ctx.tenantId}/content/${itemId}?m=${m}`);

  router.post("/w/:tenantId/content/:itemId/schedule", async (req) => {
    const ctx = await manage(req);
    needConfig();
    const itemId = idParam(req, "itemId");
    let at: Date;
    if (req.form.get("now") === "1") at = new Date();
    else {
      const date = (req.form.get("date") ?? "").trim();
      const time = (req.form.get("time") ?? "").trim();
      if (!isCalendarDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, "Use YYYY-MM-DD and a 24-hour HH:MM time.");
      at = zonedToUtc(date, time, TZ);
      if (at.getTime() < Date.now() - 60_000) throw new HttpError(400, "Pick a time in the future, or use Publish now.");
    }
    const fingerprint = req.form.get("fingerprint") ?? "";
    const r = await itemTx(ctx, itemId, async (q, item, live) => {
      const integration = await integrationForChannel(q, item.channel);
      const blocker = publishBlocker(item, integration);
      if (blocker) throw new HttpError(400, blocker);
      if (live) return "stale";
      if (!fingerprint || item.contentHash !== fingerprint) return "stale";
      return {
        event: { type: "schedule", at: at.toISOString() },
        detail: { integrationId: integration!.id },
        after: async (qq) => {
          const pubId = await createPublication(qq, { tenantId: ctx.tenantId, itemId, revisionId: item.currentRevisionId!, integrationId: integration!.id, scheduledFor: at.toISOString(), createdBy: ctx.s.userId });
          await appendAudit(qq, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "publish.scheduled", entityType: "publication", entityId: pubId, after: { at: at.toISOString(), channel: item.channel } });
        },
      };
    });
    return itemBack(ctx, itemId, r === "ok" ? "scheduled" : "stale");
  });

  router.post("/w/:tenantId/content/:itemId/unschedule", async (req) => {
    const ctx = await manage(req);
    const itemId = idParam(req, "itemId");
    const r = await itemTx(ctx, itemId, async (_q, item, live) => {
      if (live?.status === "publishing") return "sending";
      if (item.state !== "scheduled") return "stale";
      return {
        event: { type: "unschedule" },
        after: async (qq) => {
          if (live) await updatePublication(qq, live.id, { status: "cancelled", lastError: "Unscheduled by a person." });
        },
      };
    });
    return itemBack(ctx, itemId, r === "ok" ? "unscheduled" : r === "sending" ? "sending" : "stale");
  });

  router.post("/w/:tenantId/content/:itemId/retry", async (req) => {
    const ctx = await manage(req);
    needConfig();
    const itemId = idParam(req, "itemId");
    const r = await itemTx(ctx, itemId, async (q, item, live) => {
      if (live || item.state !== "failed") return "stale";
      if ((await listItemPublications(q, itemId)).some((p) => p.status === "published")) throw new HttpError(409, "This post was already published. Mark it as posted instead of retrying.");
      const integration = await integrationForChannel(q, item.channel);
      const blocker = publishBlocker(item, integration);
      if (blocker) throw new HttpError(400, blocker);
      const now = new Date().toISOString();
      return {
        event: { type: "retry_publish" },
        after: async (qq) => {
          const pubId = await createPublication(qq, { tenantId: ctx.tenantId, itemId, revisionId: item.currentRevisionId!, integrationId: integration!.id, scheduledFor: now, createdBy: ctx.s.userId });
          await appendAudit(qq, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "publish.retried", entityType: "publication", entityId: pubId });
        },
      };
    });
    return itemBack(ctx, itemId, r === "ok" ? "retrying" : "stale");
  });
}
