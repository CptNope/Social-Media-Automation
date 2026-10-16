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
import { PublishError, pkcePair, type BlueskyCredential, type ChannelAdapter, type ConnectableAccount, type OAuthConnector } from "@jat/integrations";
import { encryptSecret, type KekProvider } from "@jat/vault";
import { machineState, type RouteCtx } from "./content-routes.ts";
import { HttpError, htmlResponse, parseCookies, redirect, serializeCookie, type Req, type Router } from "./http.ts";
import { checkIntegration, publishBlocker, type PublisherDeps } from "./publisher.ts";
import * as P from "./views/publishing.ts";
import { CHANNEL_LABELS } from "./views/content.ts";

/** Everything the web tier needs for publishing. Absent → publishing isn't configured (export only). */
export interface PublishingConfig {
  /** PUBLISH_MODE (shown in the UI; the publisher enforces it). */
  mode: "live" | "dry_run";
  /** KEK used to encrypt newly stored credentials (the web role can insert credentials, never read them). */
  activeKek: KekProvider;
  /** Used to verify an app password before storing it. */
  bluesky: Pick<ChannelAdapter<BlueskyCredential>, "check">;
  /** OAuth sign-in for each channel whose app credentials are configured (absent → "not configured"). */
  oauth: Partial<Record<OAuthChannel, OAuthConnector<unknown>>>;
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
/** Channels connected by OAuth sign-in. */
export const OAUTH_CHANNELS = ["facebook", "instagram", "linkedin", "google_business_profile", "threads", "x", "pinterest", "tiktok", "youtube"] as const;
export type OAuthChannel = (typeof OAUTH_CHANNELS)[number];
const isOAuthChannel = (c: string): c is OAuthChannel => (OAUTH_CHANNELS as readonly string[]).includes(c);
/** One state cookie per channel, so sign-ins to two platforms in parallel don't clash. */
const stateCookie = (channel: OAuthChannel) => `jat_oauth_${channel}`;
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
  oauth_denied: { kind: "error", message: "Sign-in was cancelled." },
  oauth_none: { kind: "error", message: "That sign-in didn't give access to anything you can post to." },
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
  const oauthStates = new PendingStore<{ tenantId: string; userId: string; channel: OAuthChannel; verifier: string | null }>();
  const accountPicks = new PendingStore<{ tenantId: string; userId: string; channel: OAuthChannel; accounts: Array<ConnectableAccount<unknown>> }>();
  const EXPIRED = "That sign-in expired or didn't match this browser. Try again.";

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

  async function storeConnection(ctx: RouteCtx, a: { channel: string; externalAccountId: string; displayName: string; secret: unknown; capabilities: Record<string, unknown>; scopes: readonly string[]; status?: "connected" | "error"; tokenExpiresAt?: string | null }) {
    const c = needConfig();
    await ctx.tx(async (q) => {
      const id = await upsertIntegration(q, { tenantId: ctx.tenantId, channel: a.channel, externalAccountId: a.externalAccountId, displayName: a.displayName, capabilities: a.capabilities, scopes: [...a.scopes], tokenExpiresAt: a.tokenExpiresAt ?? null, ...(a.status ? { status: a.status } : {}) });
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
        oauthConfigured: Object.fromEntries(OAUTH_CHANNELS.map((c) => [c, !!cfg?.oauth[c]])) as Record<OAuthChannel, boolean>,
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

  // ------------------------------------------------------------------ OAuth sign-in (Facebook, LinkedIn, Google, Threads, X)
  const connectorFor = (channel: string): { channel: OAuthChannel; connector: OAuthConnector<unknown> } => {
    if (!isOAuthChannel(channel)) throw new HttpError(404, "Not found");
    const connector = needConfig().oauth[channel];
    if (!connector) throw new HttpError(400, `${CHANNEL_LABELS[channel]} isn't configured on this server.`);
    return { channel, connector };
  };

  const connectAccount = (ctx: RouteCtx, channel: OAuthChannel, connector: OAuthConnector<unknown>, a: ConnectableAccount<unknown>) =>
    storeConnection(ctx, { channel, externalAccountId: a.id, displayName: a.name, secret: a.credential, capabilities: { text: true, link: true }, scopes: connector.scopes, tokenExpiresAt: a.tokenExpiresAt });

  router.post("/w/:tenantId/connections/:channel/start", async (req) => {
    const ctx = await manage(req);
    const { channel, connector } = connectorFor(req.params.channel ?? "");
    const pkce = connector.usesPkce ? pkcePair() : null;
    // The PKCE verifier stays server-side with the state; only the challenge goes to the platform.
    const state = oauthStates.put({ tenantId: ctx.tenantId, userId: ctx.s.userId, channel, verifier: pkce?.verifier ?? null });
    return redirect(connector.authorizeUrl({ state, ...(pkce ? { codeChallenge: pkce.challenge } : {}) }), { "set-cookie": serializeCookie(stateCookie(channel), state, { maxAgeSeconds: PENDING_TTL_MS / 1000, secure: kit.secureCookies }) });
  });

  router.get("/oauth/:channel/callback", async (req) => {
    const userId = await kit.requireUserId(req);
    const { channel, connector } = connectorFor(req.params.channel ?? "");
    const state = req.url.searchParams.get("state") ?? "";
    const cookieState = parseCookies(req.headers.cookie)[stateCookie(channel)] ?? "";
    const pending = state && state === cookieState ? oauthStates.take(state) : null;
    const clear = { "set-cookie": serializeCookie(stateCookie(channel), "", { maxAgeSeconds: 0, secure: kit.secureCookies }) };
    if (!pending || pending.userId !== userId || pending.channel !== channel) throw new HttpError(400, EXPIRED);
    if (req.url.searchParams.get("error")) return redirect(`/w/${pending.tenantId}/connections?m=oauth_denied#ch-${channel}`, clear);
    const code = req.url.searchParams.get("code") ?? "";
    if (!code || code.length > 2000) throw new HttpError(400, EXPIRED);
    let accounts: Array<ConnectableAccount<unknown>>;
    try {
      accounts = await connector.accountsFromCode({ code, ...(pending.verifier ? { codeVerifier: pending.verifier } : {}) });
    } catch (err) {
      throw new HttpError(502, `${CHANNEL_LABELS[channel]} sign-in failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`);
    }
    if (!accounts.length) return redirect(`/w/${pending.tenantId}/connections?m=oauth_none#ch-${channel}`, clear);
    const key = accountPicks.put({ tenantId: pending.tenantId, userId, channel, accounts });
    return redirect(`/w/${pending.tenantId}/connections/${channel}/pick?k=${encodeURIComponent(key)}`, clear);
  });

  const pickFor = (ctx: RouteCtx, channel: string, key: string) => {
    const p = accountPicks.peek(key);
    if (!p || p.userId !== ctx.s.userId || p.tenantId !== ctx.tenantId || p.channel !== channel) throw new HttpError(400, EXPIRED);
    return p;
  };

  router.get("/w/:tenantId/connections/:channel/pick", async (req) => {
    const ctx = await manage(req);
    const { channel, connector } = connectorFor(req.params.channel ?? "");
    const key = req.url.searchParams.get("k") ?? "";
    const p = pickFor(ctx, channel, key);
    // Tokens never reach the page: only ids, names and whether each can post.
    return htmlResponse(
      P.accountPickPage(await ctx.shell("connections", `Choose a ${connector.accountNoun}`), {
        key,
        channel,
        channelLabel: CHANNEL_LABELS[channel] ?? channel,
        noun: connector.accountNoun,
        accounts: p.accounts.map(({ id, name, canPost, reason }) => ({ id, name, canPost, reason: reason ?? null })),
      }),
    );
  });

  router.post("/w/:tenantId/connections/:channel/pick", async (req) => {
    const ctx = await manage(req);
    const { channel, connector } = connectorFor(req.params.channel ?? "");
    const key = req.form.get("k") ?? "";
    const account = pickFor(ctx, channel, key).accounts.find((x) => x.id === req.form.get("account_id"));
    if (!account || !account.canPost) throw new HttpError(400, `Pick a ${connector.accountNoun} you can post to.`);
    accountPicks.take(key);
    await connectAccount(ctx, channel, connector, account);
    return back(ctx, "connected", `#ch-${channel}`);
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
