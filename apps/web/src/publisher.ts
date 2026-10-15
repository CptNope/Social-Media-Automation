import { composeCaption, contentHash, evaluatePublishGate, isVisualFormat, transition, type ContentEvent, type PostDraft } from "@jat/core";
import {
  appendAudit,
  clearCheckRequest,
  findDuePublications,
  findRequestedChecks,
  getCurrentTenant,
  getIntegration,
  globalPause,
  inAnonymous,
  inTenant,
  listApprovals,
  lockContentItem,
  lockPublication,
  markIntegrationChecked,
  readCredential,
  setContentState,
  setIntegrationStatus,
  updatePublication,
  type ContentItemRow,
  type Database,
  type IntegrationRow,
  type QueryClient,
} from "@jat/db";
import { PublishError, WordPressClient, type BlueskyCredential, type ChannelAdapter, type FacebookPageCredential, type PublishablePost, type WordPressCredential } from "@jat/integrations";
import { decryptSecret, type KekProvider } from "@jat/vault";
import { carriedAiFindings, lintForBrand, loadBrandContext } from "./content-jobs.ts";

/**
 * The publisher: the only code path that sends content to a platform.
 *
 * For each due publication it re-checks everything at send time through evaluatePublishGate
 * (pauses, approval bound to the exact content hash, final lint, connection health, publish
 * mode, idempotency), then calls the channel adapter outside any database transaction.
 *
 * It runs on a separate database connection as publisher_user — the only role that can read
 * encrypted credentials — and finds due work through the narrow jat_scheduler view.
 *
 * Duplicate safety: a publication is marked "publishing" (committed) before the API call and is
 * never sent again automatically once that has happened. Only errors the platform reports before
 * accepting the post (rate limits, network errors before sending) are retried. Anything that may
 * have posted ("ambiguous") stops and asks a person to check.
 */

export const PUBLISHABLE_CHANNELS = ["facebook", "bluesky"] as const;
export type PublishableChannel = (typeof PUBLISHABLE_CHANNELS)[number];
export const isPublishableChannel = (c: string): c is PublishableChannel => (PUBLISHABLE_CHANNELS as readonly string[]).includes(c);

export const MAX_ATTEMPTS = 5;
/** A paused post that is this late is not sent when publishing resumes; a person decides. */
export const PAUSE_STALE_MS = 24 * 60 * 60 * 1000;
export const PAUSE_RECHECK_MS = 5 * 60 * 1000;
const STRANDED_MS = 15 * 60 * 1000;
const DISPATCH_CONCURRENCY = 4;

export interface PublisherDeps {
  /** Connection pool that connects as publisher_user (never a BYPASSRLS role). */
  publisherDb: Database;
  /** KEKs by id, for decrypting credentials. */
  keks: KekProvider | ReadonlyMap<string, KekProvider>;
  /** PUBLISH_MODE: anything other than "live" never calls a platform. */
  mode: "live" | "dry_run";
  adapters: {
    bluesky: ChannelAdapter<BlueskyCredential>;
    facebook: ChannelAdapter<FacebookPageCredential> | null;
  };
  /** SSRF-safe fetch for customer-supplied hosts (WordPress sites). */
  safeFetch: typeof fetch;
  now?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

const SYSTEM = { type: "system" as const, id: "publisher" };

/** Text sent to the platform: the approved caption exactly, plus a link card. */
export function publishablePost(post: PostDraft, idempotencyKey: string): PublishablePost {
  return {
    text: composeCaption(post),
    link: post.link ? { url: post.link.url, title: post.hook.slice(0, 300), description: post.body.slice(0, 300) } : null,
    idempotencyKey,
  };
}

/** Why this item can't be published automatically (null when it can). Shown before scheduling. */
export function publishBlocker(item: Pick<ContentItemRow, "channel" | "body">, integration: Pick<IntegrationRow, "status"> | null): string | null {
  if (!isPublishableChannel(item.channel)) return "Automatic publishing isn't available for this channel yet. Use the CSV export and mark it as posted.";
  const post = item.body as PostDraft | null;
  if (post && isVisualFormat(post.format)) return "This post is designed around an image, and image publishing arrives with the graphics renderer. Export it, or ask for a text version.";
  if (!integration) return "Connect the account on the Connections page first.";
  if (integration.status !== "connected") return "The connected account needs attention on the Connections page.";
  return null;
}

async function approvedHashFor(q: QueryClient, item: ContentItemRow): Promise<string | null> {
  const approvals = await listApprovals(q, item.id);
  const latest = approvals.find((a) => a.revisionId === item.currentRevisionId);
  return latest?.decision === "approved" ? latest.contentHash : null;
}

async function moveItem(q: QueryClient, tenantId: string, item: ContentItemRow, event: ContentEvent, extra: Record<string, unknown> = {}): Promise<void> {
  const approvedHash = await approvedHashFor(q, item);
  const { next, audit } = transition({ state: item.state, contentHash: item.contentHash ?? "", approvedHash, pausedFrom: item.pausedFrom }, event, SYSTEM);
  await setContentState(q, item.id, next.state, next.pausedFrom);
  await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: audit.action, entityType: "content_item", entityId: item.id, before: audit.before, after: { ...audit.after, ...(audit.detail ?? {}), ...extra } });
}

type Prepared =
  | { kind: "done"; outcome: string }
  | { kind: "send"; publicationId: string; itemId: string; integrationId: string; channel: PublishableChannel; attempts: number; post: PublishablePost; credential: unknown };

/** Process one publication. Safe to call concurrently and repeatedly. Returns a short outcome label. */
export async function processPublication(deps: PublisherDeps, args: { tenantId: string; publicationId: string }): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const prepared = await inTenant(deps.publisherDb, { tenantId: args.tenantId }, (q) => prepare(deps, q, args.tenantId, args.publicationId, now));
  if (prepared.kind === "done") return prepared.outcome;

  let result: { externalId: string; permalink: string | null } | null = null;
  let error: PublishError | null = null;
  try {
    const adapter = prepared.channel === "bluesky" ? deps.adapters.bluesky : deps.adapters.facebook;
    if (!adapter) throw new PublishError("permanent", "Facebook publishing isn't configured on this server.");
    result = await (adapter as ChannelAdapter<unknown>).publish(prepared.post, prepared.credential);
  } catch (err) {
    // Unknown failures might have happened after the platform accepted the post: treat as ambiguous.
    error = err instanceof PublishError ? err : new PublishError("ambiguous", `Unexpected error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
    if (!(err instanceof PublishError)) deps.log?.("[publisher] unexpected adapter error", err);
  }
  return inTenant(deps.publisherDb, { tenantId: args.tenantId }, (q) => record(q, args.tenantId, prepared, result, error, deps.now?.() ?? new Date()));
}

async function prepare(deps: PublisherDeps, q: QueryClient, tenantId: string, publicationId: string, now: Date): Promise<Prepared> {
  const pub = await lockPublication(q, publicationId);
  if (!pub) return { kind: "done", outcome: "locked_or_missing" };

  if (pub.status === "publishing") {
    // A worker died mid-send (or the process restarted). We can't know whether it posted.
    if (now.getTime() - new Date(pub.updatedAt).getTime() < STRANDED_MS) return { kind: "done", outcome: "in_flight" };
    await updatePublication(q, pub.id, { status: "needs_attention", lastError: "We lost track of this publish attempt. Check the account to see whether it posted, then retry or mark it as posted." });
    const item = await lockContentItem(q, pub.contentItemId);
    if (item?.state === "publishing") await moveItem(q, tenantId, item, { type: "publish_failed", error: "stranded", permanent: true });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.stranded", entityType: "publication", entityId: pub.id });
    return { kind: "done", outcome: "stranded" };
  }
  if (pub.status !== "queued") return { kind: "done", outcome: "not_queued" };
  if ((pub.scheduledFor && new Date(pub.scheduledFor) > now) || (pub.nextAttemptAt && new Date(pub.nextAttemptAt) > now)) return { kind: "done", outcome: "not_due" };

  const item = await lockContentItem(q, pub.contentItemId);
  if (!item || item.state !== "scheduled" || item.currentRevisionId !== pub.revisionId || !item.body) {
    await updatePublication(q, pub.id, { status: "cancelled", lastError: "The post was changed or unscheduled before its time." });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.cancelled", entityType: "publication", entityId: pub.id, after: { itemState: item?.state ?? null } });
    return { kind: "done", outcome: "cancelled" };
  }

  // Another publication of this post already went out (e.g. a stranded send that succeeded late).
  const { rows: done } = await q.query<{ n: string }>(`SELECT count(*) AS n FROM publications WHERE content_item_id = $1 AND status = 'published' AND id <> $2`, [item.id, pub.id]);
  if (Number(done[0]?.n ?? 0) > 0) {
    await updatePublication(q, pub.id, { status: "needs_attention", lastError: "Not sent: this post was already published by an earlier attempt." });
    await moveItem(q, tenantId, item, { type: "unschedule" }, { reason: ["already published"] });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.blocked", entityType: "publication", entityId: pub.id, after: { reasons: ["already published"] } });
    return { kind: "done", outcome: "blocked" };
  }

  const post = item.body as PostDraft;
  const integration = pub.integrationId ? await getIntegration(q, pub.integrationId) : null;
  const tenant = (await getCurrentTenant(q))!;
  const global = await globalPause(q);
  const approvedHash = await approvedHashFor(q, item);
  let lint;
  try {
    const ctx = await loadBrandContext(q, item.brandId, now);
    lint = [...lintForBrand(post, ctx), ...carriedAiFindings(item.findings as never)];
  } catch (err) {
    lint = [{ code: "brand.inactive", severity: "blocker" as const, message: err instanceof Error ? err.message : "Brand DNA unavailable" }];
  }
  const credential = integration ? await readCredential(q, integration.id) : null;
  const gate = evaluatePublishGate({
    globalPaused: global.paused,
    tenantPaused: tenant.pausedAt !== null,
    channelPaused: integration?.channelPaused ?? false,
    publishModeEnv: deps.mode,
    tenantPublishingEnabled: tenant.publishingEnabled,
    approvalRequired: true,
    approvedHash,
    currentContentHash: contentHash(post),
    finalLintFindings: lint,
    integrationStatus: integration?.status ?? "revoked",
    capabilityPresent: !!integration && credential !== null && publishBlocker(item, integration) === null,
    tokenExpiresAt: integration?.tokenExpiresAt ? new Date(integration.tokenExpiresAt) : null,
    idempotencyKeyUsed: pub.externalId !== null || pub.publishedAt !== null,
    now,
  });

  if (gate.decision === "blocked") {
    const pauseOnly = gate.reasons.every((r) => /pause/i.test(r));
    const late = pub.scheduledFor ? now.getTime() - new Date(pub.scheduledFor).getTime() : 0;
    if (pauseOnly && late < PAUSE_STALE_MS) {
      await updatePublication(q, pub.id, { nextAttemptAt: new Date(now.getTime() + PAUSE_RECHECK_MS).toISOString(), lastError: gate.reasons.join(" ") });
      return { kind: "done", outcome: "paused" };
    }
    const reasons = pauseOnly ? ["It missed its scheduled time by more than a day while publishing was paused.", ...gate.reasons] : gate.reasons;
    await updatePublication(q, pub.id, { status: "needs_attention", lastError: `Not sent: ${reasons.join(" ")}` });
    await moveItem(q, tenantId, item, { type: "unschedule" }, { reason: reasons });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.blocked", entityType: "publication", entityId: pub.id, after: { reasons } });
    return { kind: "done", outcome: "blocked" };
  }

  if (gate.decision === "dry_run") {
    await updatePublication(q, pub.id, { status: "dry_run", lastError: `Dry run — nothing was sent. ${gate.reasons.join(" ")}` });
    await moveItem(q, tenantId, item, { type: "unschedule" }, { dryRun: true });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.dry_run", entityType: "publication", entityId: pub.id, after: { reasons: gate.reasons, text: composeCaption(post) } });
    return { kind: "done", outcome: "dry_run" };
  }

  // Live. Decrypt (bound to this tenant + integration), then commit "publishing" before sending.
  let secret: unknown;
  try {
    secret = JSON.parse(await decryptSecret(credential!, { tenantId, integrationId: integration!.id }, deps.keks));
  } catch (err) {
    deps.log?.("[publisher] credential decryption failed", err);
    await updatePublication(q, pub.id, { status: "needs_attention", lastError: "Not sent: the stored credentials couldn't be read. Reconnect the account, then retry." });
    await moveItem(q, tenantId, item, { type: "unschedule" }, { reason: ["credential unreadable"] });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.blocked", entityType: "publication", entityId: pub.id, after: { reasons: ["credential unreadable"] } });
    return { kind: "done", outcome: "blocked" };
  }
  await updatePublication(q, pub.id, { status: "publishing", attemptsIncrement: true, lastError: null, nextAttemptAt: null });
  await moveItem(q, tenantId, item, { type: "start_publish" }, { publicationId: pub.id });
  await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.started", entityType: "publication", entityId: pub.id, after: { channel: item.channel, attempt: pub.attempts + 1 } });
  return { kind: "send", publicationId: pub.id, itemId: item.id, integrationId: integration!.id, channel: item.channel as PublishableChannel, attempts: pub.attempts + 1, post: publishablePost(post, pub.idempotencyKey), credential: secret };
}

/** Backoff for retryable failures: the platform's Retry-After if longer, else 1, 2, 4, 8 minutes (max 1 hour). */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
  return Math.min(60 * 60_000, Math.max(base, retryAfterMs ?? 0));
}

async function record(q: QueryClient, tenantId: string, p: Extract<Prepared, { kind: "send" }>, result: { externalId: string; permalink: string | null } | null, error: PublishError | null, now: Date): Promise<string> {
  const pub = await lockPublication(q, p.publicationId, { skipLocked: false });
  const item = await lockContentItem(q, p.itemId);
  if (!pub || !item) return "missing";
  if (result) {
    await updatePublication(q, pub.id, { status: "published", externalId: result.externalId, permalink: result.permalink, published: true, lastError: null });
    // "failed" here means the stranded-send handler gave up on it while the call was still running.
    if (item.state === "publishing" || item.state === "failed") await moveItem(q, tenantId, item, { type: "publish_succeeded", externalId: result.externalId });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.succeeded", entityType: "publication", entityId: pub.id, after: { externalId: result.externalId, permalink: result.permalink } });
    return "published";
  }
  const e = error!;
  if (e.kind === "transient" && p.attempts < MAX_ATTEMPTS) {
    const at = new Date(now.getTime() + retryDelayMs(p.attempts, e.retryAfterMs)).toISOString();
    await updatePublication(q, pub.id, { status: "queued", nextAttemptAt: at, lastError: `${e.message} (attempt ${p.attempts} of ${MAX_ATTEMPTS}; retrying automatically)` });
    if (item.state === "publishing") await moveItem(q, tenantId, item, { type: "publish_failed", error: e.message, permanent: false });
    await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.retry_scheduled", entityType: "publication", entityId: pub.id, after: { error: e.message, nextAttemptAt: at } });
    return "retrying";
  }
  const advice: Record<PublishError["kind"], string> = {
    transient: "It kept failing; try again later.",
    auth: "Reconnect the account on the Connections page, then retry.",
    permission: "The account doesn't allow posting; check its roles and permissions, then retry.",
    permanent: "The platform rejected the post; change it and send it for approval again.",
    ambiguous: "It may have posted. Check the account before retrying, or mark it as posted.",
  };
  await updatePublication(q, pub.id, { status: "needs_attention", lastError: `${e.message} ${advice[e.kind]}`.slice(0, 1000) });
  if (item.state === "publishing") await moveItem(q, tenantId, item, { type: "publish_failed", error: e.message, permanent: true });
  if (e.kind === "auth") await setIntegrationStatus(q, p.integrationId, "needs_reauth");
  await appendAudit(q, tenantId, { actorType: "system", actorId: SYSTEM.id, action: "publish.failed", entityType: "publication", entityId: pub.id, after: { kind: e.kind, error: e.message, platformCode: e.platformCode ?? null } });
  return `failed_${e.kind}`;
}

/** One dispatcher pass: find due work across tenants (ids only), then process each in its tenant scope. */
export async function dispatchDue(deps: PublisherDeps, limit = 20): Promise<Array<{ id: string; outcome: string }>> {
  const now = deps.now?.() ?? new Date();
  const due = await inAnonymous(deps.publisherDb, (q) => findDuePublications(q, now, limit));
  const out: Array<{ id: string; outcome: string }> = new Array(due.length);
  // A few at a time, so one slow customer host can't hold up every other tenant's posts.
  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const i = next++;
      const d = due[i]!;
      try {
        out[i] = { id: d.id, outcome: await processPublication(deps, { tenantId: d.tenantId, publicationId: d.id }) };
      } catch (err) {
        deps.log?.(`[publisher] publication ${d.id} failed to process`, err);
        out[i] = { id: d.id, outcome: "error" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DISPATCH_CONCURRENCY, due.length) }, worker));
  return out;
}

/** Runs dispatchDue on an interval, never overlapping. Returns a stop function. */
export function startDispatcher(deps: PublisherDeps, intervalMs = 30_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await dispatchDue(deps);
      await runRequestedChecks(deps);
    } catch (err) {
      deps.log?.("[publisher] dispatch pass failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// Connection checks (read the credential, so they run on the publisher connection)
// ---------------------------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  message: string;
}

/** Test a connection with its stored credentials. `userId` is who asked (absent: the worker's own health check). */
export async function checkIntegration(deps: PublisherDeps, args: { tenantId: string; integrationId: string; userId?: string }): Promise<CheckResult> {
  const loaded = await inTenant(deps.publisherDb, { tenantId: args.tenantId }, async (q) => {
    const integration = await getIntegration(q, args.integrationId);
    if (!integration || integration.status === "revoked") return null;
    const rec = await readCredential(q, integration.id);
    if (!rec) return { integration, secret: null };
    return { integration, secret: JSON.parse(await decryptSecret(rec, { tenantId: args.tenantId, integrationId: integration.id }, deps.keks)) as unknown };
  });
  if (!loaded) {
    await inTenant(deps.publisherDb, { tenantId: args.tenantId }, (q) => clearCheckRequest(q, args.integrationId));
    return { ok: false, message: "That connection no longer exists." };
  }
  if (!loaded.secret) {
    await inTenant(deps.publisherDb, { tenantId: args.tenantId }, (q) => clearCheckRequest(q, args.integrationId));
    return { ok: false, message: "No stored credentials; reconnect the account." };
  }
  const { integration, secret } = loaded;
  let result: CheckResult;
  let accountName = integration.displayName;
  let status: IntegrationRow["status"] = integration.status;
  try {
    if (integration.channel === "bluesky") accountName = (await deps.adapters.bluesky.check(secret as BlueskyCredential)).accountName;
    else if (integration.channel === "facebook") {
      if (!deps.adapters.facebook) throw new PublishError("permanent", "Facebook isn't configured on this server.");
      accountName = (await deps.adapters.facebook.check(secret as FacebookPageCredential)).accountName;
    } else if (integration.channel === "wordpress") {
      const h = await new WordPressClient(secret as WordPressCredential, deps.safeFetch).health();
      accountName = (secret as WordPressCredential).siteUrl;
      if (!h.ok) throw new PublishError("permanent", "The plugin answered but reported a problem.");
    } else throw new PublishError("permanent", "Unknown channel.");
    status = "connected";
    result = { ok: true, message: `Connected as ${accountName}.` };
  } catch (err) {
    const e = err instanceof PublishError ? err : new PublishError("transient", err instanceof Error ? err.message : String(err));
    if (e.kind === "auth") status = "needs_reauth";
    else if (e.kind === "permission" || e.kind === "permanent") status = "error";
    result = { ok: false, message: e.message.slice(0, 300) };
  }
  await inTenant(deps.publisherDb, { tenantId: args.tenantId }, async (q) => {
    await clearCheckRequest(q, integration.id);
    if (result.ok) await markIntegrationChecked(q, integration.id, accountName);
    else if (status !== integration.status) await setIntegrationStatus(q, integration.id, status);
    await appendAudit(q, args.tenantId, { actorType: args.userId ? "user" : "system", actorId: args.userId ?? SYSTEM.id, action: "integration.checked", entityType: "integration", entityId: integration.id, after: { ok: result.ok, status, message: result.message } });
  });
  return result;
}

/** Connection checks requested from the web tier (which can't read credentials itself). */
export async function runRequestedChecks(deps: PublisherDeps, limit = 20): Promise<number> {
  const pending = await inAnonymous(deps.publisherDb, (q) => findRequestedChecks(q, limit));
  for (const p of pending) {
    try {
      await checkIntegration(deps, { tenantId: p.tenantId, integrationId: p.id });
    } catch (err) {
      deps.log?.(`[publisher] connection check ${p.id} failed`, err);
      await inTenant(deps.publisherDb, { tenantId: p.tenantId }, (q) => clearCheckRequest(q, p.id)).catch(() => undefined);
    }
  }
  return pending.length;
}
