import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { BrandDnaSchema, approvalRequirement, canonicalJson, type BrandDna, type Role } from "@jat/core";
import {
  StaleVersionError,
  activateDna,
  activeOnboardingRun,
  appendAudit,
  bumpSessionEpoch,
  lockDnaVersion,
  assertUuid,
  consumeLoginToken,
  createBrand,
  createOnboardingRun,
  currentRole,
  getBrand,
  getCurrentTenant,
  getDnaVersion,
  getOnboardingRun,
  getUser,
  inAnonymous,
  inTenant,
  inUser,
  insertClaim,
  issueLoginToken,
  listBrands,
  listClaims,
  listDnaVersions,
  listOnboardingRuns,
  listSourceIds,
  listWorkspaces,
  recentAudit,
  rejectProposedDna,
  runForVersion,
  setClaimStatus,
  updateOnboardingRun,
  updateProposedDna,
  type ClaimEvidence,
  type Database,
  type MemberRole,
  type QueryClient,
} from "@jat/db";
import { applyFieldAction, fieldSpec, parseEditorInput, versionIssues } from "./brand-fields.ts";
import { HttpError, Router, htmlResponse, parseCookies, readForm, redirect, send, serializeCookie, text, type Req, type Res } from "./http.ts";
import type { JobRunner } from "./jobs.ts";
import { runOnboarding, type OnboardingDeps } from "./onboarding.ts";
import {
  RateLimiter,
  SECURITY_HEADERS,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  assertCsrf,
  assertSameOrigin,
  assertSecret,
  csrfToken,
  newLoginToken,
  sha256Hex,
  signSession,
  verifySession,
  type Session,
} from "./security.ts";
import { ROLE_LABELS, type Shell } from "./views/layout.ts";
import * as V from "./views/pages.ts";

export interface Mailer {
  sendLoginLink(email: string, url: string): Promise<void>;
}

export interface AppDeps {
  db: Database;
  sessionSecret: Buffer;
  baseUrl: string;
  mailer: Mailer;
  jobs: JobRunner;
  onboarding: Omit<OnboardingDeps, "db">;
  /** Show the sign-in link on screen (development only; refused in production). */
  devShowLoginLinks?: boolean;
  production?: boolean;
  /** Number of reverse proxies in front of the app; used to read the client IP from X-Forwarded-For. */
  trustedProxies?: number;
  log?: (msg: string, err?: unknown) => void;
}

const LOGIN_TTL_MINUTES = 15;

// Who may do what. Approval rights come from the core approval policy, not from here.
const ROLES = {
  manageBrand: ["agency_operator", "client_owner"],
  editDna: ["agency_operator", "client_owner", "client_editor"],
  rejectDna: ["agency_operator", "client_owner"],
  addClaim: ["agency_operator", "client_owner", "client_editor"],
  rejectClaim: ["agency_operator", "client_owner"],
} satisfies Record<string, MemberRole[]>;
const can = (role: MemberRole, list: readonly MemberRole[]) => list.includes(role);
const canApproveAction = (role: MemberRole, action: "activate_brand_dna" | "verify_claim") =>
  approvalRequirement({ mode: "manual", action }).approverRoles.includes(role as Role);

const FLASH: Record<string, { kind: "ok" | "error"; message: string }> = {
  saved: { kind: "ok", message: "Saved." },
  confirmed: { kind: "ok", message: "Confirmed." },
  activated: { kind: "ok", message: "Brand DNA approved. All new content will use this version." },
  rejected: { kind: "ok", message: "Proposal rejected." },
  claim_added: { kind: "ok", message: "Claim added. The owner needs to verify it before content can use it." },
  claim_verified: { kind: "ok", message: "Claim verified. Content can now use it." },
  claim_rejected: { kind: "ok", message: "Claim rejected." },
  stale: { kind: "error", message: "This proposal changed or was already decided. Reload and try again." },
};
const flashFrom = (req: Req) => {
  const k = req.url.searchParams.get("m") ?? "";
  return Object.hasOwn(FLASH, k) ? FLASH[k] : undefined;
};

/** Fingerprint of a version's content, embedded in the approve form so the owner approves exactly what they saw. */
const dataFingerprint = (data: unknown): string => createHash("sha256").update(canonicalJson(data)).digest("hex");

export function createApp(deps: AppDeps) {
  assertSecret(deps.sessionSecret);
  const base = new URL(deps.baseUrl);
  const secureCookies = base.protocol === "https:";
  if (deps.production && deps.devShowLoginLinks) throw new Error("devShowLoginLinks must not be enabled in production");
  const log = deps.log ?? ((m, e) => console.error(m, e ?? ""));
  const db = deps.db;
  const loginLimiter = new RateLimiter(10, 60_000);
  const cssPath = fileURLToPath(new URL("../public/app.css", import.meta.url));
  let cssCache: Buffer | null = null;
  const router = new Router();

  // ------------------------------------------------------------------------- helpers
  const sessionOf = (req: Req): Session | null => verifySession(deps.sessionSecret, req.cookies[SESSION_COOKIE]);

  /** Valid signature, not expired, and not revoked by a later sign-out (session epoch). */
  async function requireSession(req: Req): Promise<Session> {
    const s = sessionOf(req);
    if (!s) throw new HttpError(401, "Sign in required");
    const user = await inUser(db, s.userId, (tx) => getUser(tx, s.userId));
    if (!user || user.sessionEpoch !== s.epoch) throw new HttpError(401, "Sign in required");
    return s;
  }

  async function shellFor(s: Session, workspace?: { id: string; name: string; role: MemberRole }, active?: Shell["active"]): Promise<Shell> {
    const user = await inUser(db, s.userId, (tx) => getUser(tx, s.userId));
    if (!user) throw new HttpError(401, "Sign in required");
    return {
      title: workspace?.name ?? "Clients",
      csrf: csrfToken(deps.sessionSecret, s),
      user,
      ...(workspace ? { workspace: { id: workspace.id, name: workspace.name, roleLabel: ROLE_LABELS[workspace.role] ?? workspace.role } } : {}),
      ...(active ? { active } : {}),
    };
  }

  interface Ctx {
    s: Session;
    tenantId: string;
    role: MemberRole;
    tenantName: string;
    shell: (active: Shell["active"], title?: string) => Promise<Shell>;
    tx: <T>(fn: (tx: QueryClient) => Promise<T>) => Promise<T>;
  }

  /** Authenticated, tenant-scoped request context. Non-members get 404 (no existence leak). */
  async function workspace(req: Req): Promise<Ctx> {
    const s = await requireSession(req);
    const tenantId = req.params.tenantId ?? "";
    try {
      assertUuid(tenantId);
    } catch {
      throw new HttpError(404, "That workspace doesn't exist or you don't have access.");
    }
    const tx = <T>(fn: (tx: QueryClient) => Promise<T>) => inTenant(db, { tenantId, userId: s.userId }, fn);
    const { role, tenant } = await tx(async (q) => ({ role: await currentRole(q, s.userId), tenant: await getCurrentTenant(q) }));
    if (!role || !tenant) throw new HttpError(404, "That workspace doesn't exist or you don't have access.");
    return {
      s,
      tenantId,
      role,
      tenantName: tenant.name,
      tx,
      shell: async (active, title) => ({ ...(await shellFor(s, { id: tenantId, name: tenant.name, role }, active)), ...(title ? { title } : {}) }),
    };
  }

  const forbid = (msg = "Your role doesn't allow this action.") => {
    throw new HttpError(403, msg);
  };

  function idParam(req: Req, name: string): string {
    const v = req.params[name] ?? "";
    try {
      return assertUuid(v);
    } catch {
      throw new HttpError(404, "Not found");
    }
  }

  async function primaryBrand(ctx: Ctx) {
    return (await ctx.tx(listBrands))[0] ?? null;
  }

  // ------------------------------------------------------------------------- static + health
  router.get("/healthz", async () => text("ok"));
  router.get("/static/app.css", async () => {
    cssCache ??= await readFile(cssPath);
    return { status: 200, headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=300" }, body: cssCache };
  });

  // ------------------------------------------------------------------------- auth
  router.get("/login", async (req) => (sessionOf(req) ? redirect("/") : htmlResponse(V.loginPage())));

  router.post("/login", async (req) => {
    const email = (req.form.get("email") ?? "").trim().slice(0, 320);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return htmlResponse(V.loginPage({ error: "Enter a valid email address.", email }), 400);
    if (!loginLimiter.allow(`ip:${req.ip}`)) return htmlResponse(V.loginPage({ error: "Too many sign-in attempts. Wait a minute and try again.", email }), 429);
    const { token, hash } = newLoginToken();
    const issued = await inAnonymous(db, (tx) => issueLoginToken(tx, email, hash, LOGIN_TTL_MINUTES));
    const link = new URL(`/login/verify?token=${encodeURIComponent(token)}`, base).toString();
    if (issued) {
      // Deliver in the background so response time doesn't reveal whether the account exists.
      try {
        deps.jobs.enqueue("login-mail", () => deps.mailer.sendLoginLink(email, link).catch((err) => log("[login] mail delivery failed", err)));
      } catch (err) {
        log("[login] mail queue full", err);
      }
    }
    // Same response whether or not the account exists.
    return htmlResponse(V.loginSentPage(email, deps.devShowLoginLinks && issued ? link : undefined));
  });

  // GET shows a confirm button so link scanners in mail clients can't burn the token.
  router.get("/login/verify", async (req) => {
    const token = req.url.searchParams.get("token") ?? "";
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return htmlResponse(V.loginPage({ error: "That sign-in link isn't valid. Request a new one." }), 400);
    // Note: "no-referrer" here would make browsers send `Origin: null` on the confirm POST.
    // The page loads no third-party resources, and the global policy is same-origin.
    return htmlResponse(V.verifyPage(token));
  });

  router.post("/login/verify", async (req) => {
    const token = req.form.get("token") ?? "";
    const userId = /^[A-Za-z0-9_-]{20,100}$/.test(token) ? await inAnonymous(db, (tx) => consumeLoginToken(tx, sha256Hex(token))) : null;
    if (!userId) return htmlResponse(V.loginPage({ error: "That sign-in link has expired or was already used. Request a new one." }), 400);
    const user = await inUser(db, userId, (tx) => getUser(tx, userId));
    if (!user) return htmlResponse(V.loginPage({ error: "That account no longer exists." }), 400);
    const { value } = signSession(deps.sessionSecret, userId, user.sessionEpoch);
    return redirect("/", { "set-cookie": serializeCookie(SESSION_COOKIE, value, { maxAgeSeconds: SESSION_TTL_SECONDS, secure: secureCookies }) });
  });

  // Signing out revokes every session for this person (all devices).
  router.post("/logout", async (req) => {
    const s = sessionOf(req);
    if (s) await inUser(db, s.userId, (tx) => bumpSessionEpoch(tx, s.userId));
    return redirect("/login", { "set-cookie": serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: secureCookies }) });
  });

  // ------------------------------------------------------------------------- workspaces
  router.get("/", async (req) => {
    const s = await requireSession(req);
    const workspaces = await inUser(db, s.userId, (tx) => listWorkspaces(tx, s.userId));
    if (workspaces.length === 1) return redirect(`/w/${workspaces[0]!.tenantId}`);
    return htmlResponse(V.workspacesPage(await shellFor(s, undefined, "workspaces"), workspaces));
  });

  router.get("/w/:tenantId", async (req) => {
    const ctx = await workspace(req);
    const d = await ctx.tx(async (tx) => {
      const tenant = (await getCurrentTenant(tx))!;
      const brand = (await listBrands(tx))[0] ?? null;
      const versions = brand ? await listDnaVersions(tx, brand.id) : [];
      return {
        tenant,
        brand,
        activeVersion: versions.find((v) => v.status === "active") ?? null,
        proposed: versions.filter((v) => v.status === "proposed"),
        claims: brand ? await listClaims(tx, brand.id) : [],
        audit: await recentAudit(tx, 15),
      };
    });
    return htmlResponse(V.overviewPage(await ctx.shell("overview"), { ...d, canManage: can(ctx.role, ROLES.manageBrand) }));
  });

  router.post("/w/:tenantId/brands", async (req) => {
    const ctx = await workspace(req);
    if (!can(ctx.role, ROLES.manageBrand)) forbid();
    const name = (req.form.get("name") ?? "").trim().slice(0, 120);
    if (!name) throw new HttpError(400, "Brand name is required.");
    await ctx.tx(async (tx) => {
      if ((await listBrands(tx)).length) return; // MVP: one brand per workspace
      const id = await createBrand(tx, ctx.tenantId, name);
      await appendAudit(tx, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "brand.created", entityType: "brand", entityId: id, after: { name } });
    });
    return redirect(`/w/${ctx.tenantId}/brand`);
  });

  // ------------------------------------------------------------------------- brand
  async function renderBrand(ctx: Ctx, error?: string, status = 200): Promise<Res> {
    const brand = await primaryBrand(ctx);
    if (!brand) return htmlResponse(V.noBrandPage(await ctx.shell("brand")));
    const d = await ctx.tx(async (tx) => ({ versions: await listDnaVersions(tx, brand.id), runs: await listOnboardingRuns(tx, brand.id) }));
    return htmlResponse(V.brandPage(await ctx.shell("brand", "Brand"), { brand, ...d, canStart: can(ctx.role, ROLES.manageBrand), tenantName: ctx.tenantName, ...(error ? { error } : {}) }), status);
  }

  router.get("/w/:tenantId/brand", async (req) => renderBrand(await workspace(req)));

  router.post("/w/:tenantId/brand/onboarding", async (req) => {
    const ctx = await workspace(req);
    if (!can(ctx.role, ROLES.manageBrand)) forbid();
    const brand = await primaryBrand(ctx);
    if (!brand) throw new HttpError(400, "Create the brand first.");
    const rawUrl = (req.form.get("website_url") ?? "").trim();
    let websiteUrl: string | null = null;
    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
        websiteUrl = u.toString();
      } catch {
        return renderBrand(ctx, "Enter a full website address starting with https://", 400);
      }
    }
    const notes = (req.form.get("notes") ?? "").trim().slice(0, 20_000);
    if (!websiteUrl && !notes) return renderBrand(ctx, "Add the client's website, notes, or both.", 400);
    const business = {
      name: (req.form.get("business_name") ?? ctx.tenantName).trim().slice(0, 160) || ctx.tenantName,
      industry: (req.form.get("industry") ?? "").trim().slice(0, 160),
      locations: (req.form.get("locations") ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50),
      notes,
    };
    const existing = await ctx.tx((tx) => activeOnboardingRun(tx, brand.id));
    if (existing) return redirect(`/w/${ctx.tenantId}/brand/runs/${existing.id}`);
    const runId = await ctx.tx(async (tx) => {
      const id = await createOnboardingRun(tx, { tenantId: ctx.tenantId, brandId: brand.id, websiteUrl, business, startedBy: ctx.s.userId });
      await appendAudit(tx, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "onboarding.started", entityType: "onboarding_run", entityId: id, after: { websiteUrl } });
      return id;
    });
    try {
      deps.jobs.enqueue(`onboarding:${runId}`, () => runOnboarding({ db, ...deps.onboarding }, { tenantId: ctx.tenantId, runId }));
    } catch {
      await ctx.tx((tx) => updateOnboardingRun(tx, runId, { status: "failed", error: "The server is busy. Try again in a few minutes.", finished: true }));
    }
    return redirect(`/w/${ctx.tenantId}/brand/runs/${runId}`);
  });

  router.get("/w/:tenantId/brand/runs/:runId", async (req) => {
    const ctx = await workspace(req);
    const run = await ctx.tx((tx) => getOnboardingRun(tx, idParam(req, "runId")));
    if (!run) throw new HttpError(404, "Not found");
    return htmlResponse(V.runPage(await ctx.shell("brand", "Onboarding run"), run));
  });

  async function renderVersion(ctx: Ctx, versionId: string, flash?: { kind: "ok" | "error"; message: string }, status = 200): Promise<Res> {
    const d = await ctx.tx(async (tx) => {
      const version = await getDnaVersion(tx, versionId);
      if (!version) return null;
      const run = await runForVersion(tx, versionId);
      return { version, run, sources: await listSourceIds(tx, version.brandId, run?.id ?? null) };
    });
    if (!d) throw new HttpError(404, "Not found");
    const parsed = BrandDnaSchema.safeParse(d.version.data);
    if (!parsed.success) throw new HttpError(500, "This Brand DNA version doesn't match the current schema.");
    const dna = parsed.data;
    const issues = versionIssues(dna, new Set(d.sources.map((s) => s.evidenceId)));
    return htmlResponse(
      V.versionPage(await ctx.shell("brand", `Brand DNA v${d.version.version}`), {
        version: d.version,
        dna,
        run: d.run,
        activationIssues: issues,
        canEdit: can(ctx.role, ROLES.editDna),
        canActivate: canApproveAction(ctx.role, "activate_brand_dna"),
        canReject: can(ctx.role, ROLES.rejectDna),
        sourceUris: new Map(d.sources.map((s) => [s.evidenceId, s.uri])),
        fingerprint: dataFingerprint(d.version.data),
        ...(flash ? { flash } : {}),
      }),
      status,
    );
  }

  router.get("/w/:tenantId/brand/versions/:versionId", async (req) => {
    const ctx = await workspace(req);
    return renderVersion(ctx, idParam(req, "versionId"), flashFrom(req));
  });

  router.post("/w/:tenantId/brand/versions/:versionId/field", async (req) => {
    const ctx = await workspace(req);
    if (!can(ctx.role, ROLES.editDna)) forbid();
    const versionId = idParam(req, "versionId");
    const path = req.form.get("path") ?? "";
    const action = req.form.get("action");
    if (!fieldSpec(path) || (action !== "edit" && action !== "confirm")) throw new HttpError(400, "Unknown field or action.");
    let fieldAction: Parameters<typeof applyFieldAction>[2];
    if (action === "edit") {
      const p = parseEditorInput(path, req.form.get("value") ?? "");
      if (!p.ok) return renderVersion(ctx, versionId, { kind: "error", message: `Couldn't save: ${p.error}` }, 400);
      fieldAction = { type: "edit", value: p.value };
    } else fieldAction = { type: "confirm" };

    const result = await ctx.tx(async (tx) => {
      const v = await lockDnaVersion(tx, versionId);
      if (!v || v.status !== "proposed") return "stale" as const;
      const before = BrandDnaSchema.parse(v.data);
      const after = applyFieldAction(before, path, fieldAction, ctx.s.userId);
      BrandDnaSchema.parse(after);
      if (!(await updateProposedDna(tx, versionId, after))) return "stale" as const;
      const [sec, key] = path.split(".") as [keyof BrandDna & string, string];
      await appendAudit(tx, ctx.tenantId, {
        actorType: "user",
        actorId: ctx.s.userId,
        action: action === "edit" ? "brand_dna.field_edited" : "brand_dna.field_confirmed",
        entityType: "brand_dna_version",
        entityId: versionId,
        before: { path, field: (before as unknown as Record<string, Record<string, unknown>>)[sec]![key] },
        after: { path, field: (after as unknown as Record<string, Record<string, unknown>>)[sec]![key] },
      });
      return "ok" as const;
    });
    return redirect(`/w/${ctx.tenantId}/brand/versions/${versionId}?m=${result === "ok" ? (action === "edit" ? "saved" : "confirmed") : "stale"}#f-${encodeURIComponent(path)}`);
  });

  router.post("/w/:tenantId/brand/versions/:versionId/activate", async (req) => {
    const ctx = await workspace(req);
    if (!canApproveAction(ctx.role, "activate_brand_dna")) forbid("Only the business owner can approve Brand DNA.");
    const versionId = idParam(req, "versionId");
    const seen = req.form.get("fingerprint") ?? "";
    const outcome = await ctx.tx(async (tx) => {
      // Row lock: no concurrent edit, reject or activation can interleave from here to commit.
      const v = await lockDnaVersion(tx, versionId);
      if (!v || v.status !== "proposed") return { kind: "stale" as const };
      if (dataFingerprint(v.data) !== seen) return { kind: "changed" as const };
      const dna = BrandDnaSchema.parse(v.data);
      const run = await runForVersion(tx, versionId);
      const issues = versionIssues(dna, new Set((await listSourceIds(tx, v.brandId, run?.id ?? null)).map((s) => s.evidenceId)));
      if (issues.length) return { kind: "blocked" as const, count: issues.length };
      // Throws StaleVersionError if anything changed, which rolls the transaction back.
      await activateDna(tx, { brandId: v.brandId, versionId, userId: ctx.s.userId });
      await appendAudit(tx, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "brand_dna.activated", entityType: "brand_dna_version", entityId: versionId, after: { version: v.version, fingerprint: seen } });
      return { kind: "ok" as const };
    }).catch((err) => {
      if (err instanceof StaleVersionError) return { kind: "stale" as const };
      throw err;
    });
    if (outcome.kind === "changed") return renderVersion(ctx, versionId, { kind: "error", message: "This proposal changed while you were reviewing it. Review the current version below, then approve again." }, 409);
    if (outcome.kind === "blocked") return renderVersion(ctx, versionId, { kind: "error", message: `Can't approve yet: ${outcome.count} issue${outcome.count === 1 ? "" : "s"} must be resolved.` }, 409);
    return redirect(`/w/${ctx.tenantId}/brand/versions/${versionId}?m=${outcome.kind === "ok" ? "activated" : "stale"}`);
  });

  router.post("/w/:tenantId/brand/versions/:versionId/reject", async (req) => {
    const ctx = await workspace(req);
    if (!can(ctx.role, ROLES.rejectDna)) forbid();
    const versionId = idParam(req, "versionId");
    const ok = await ctx.tx(async (tx) => {
      if (!(await rejectProposedDna(tx, versionId))) return false;
      await appendAudit(tx, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "brand_dna.rejected", entityType: "brand_dna_version", entityId: versionId });
      return true;
    });
    return redirect(`/w/${ctx.tenantId}/brand/versions/${versionId}?m=${ok ? "rejected" : "stale"}`);
  });

  // ------------------------------------------------------------------------- claims
  async function renderClaims(ctx: Ctx, flash?: { kind: "ok" | "error"; message: string }, status = 200): Promise<Res> {
    const brand = await primaryBrand(ctx);
    if (!brand) return htmlResponse(V.noBrandPage(await ctx.shell("claims")));
    const claims = await ctx.tx((tx) => listClaims(tx, brand.id));
    return htmlResponse(
      V.claimsPage(await ctx.shell("claims", "Claims"), {
        brand,
        claims,
        canAdd: can(ctx.role, ROLES.addClaim),
        canVerify: canApproveAction(ctx.role, "verify_claim"),
        canReject: can(ctx.role, ROLES.rejectClaim),
        ...(flash ? { flash } : {}),
      }),
      status,
    );
  }

  router.get("/w/:tenantId/claims", async (req) => {
    const ctx = await workspace(req);
    return renderClaims(ctx, flashFrom(req));
  });

  router.post("/w/:tenantId/claims", async (req) => {
    const ctx = await workspace(req);
    if (!can(ctx.role, ROLES.addClaim)) forbid();
    const brand = await primaryBrand(ctx);
    if (!brand) throw new HttpError(400, "Create the brand first.");
    const claimText = (req.form.get("text") ?? "").trim();
    const category = req.form.get("category") ?? "";
    const kind = req.form.get("evidence_kind") ?? "";
    const reference = (req.form.get("evidence_reference") ?? "").trim();
    const expiresOn = (req.form.get("expires_on") ?? "").trim();
    const errors: string[] = [];
    if (!claimText || claimText.length > 500) errors.push("Write the claim (up to 500 characters).");
    if (!["credential", "history", "offer", "statistic", "testimonial", "award", "service", "other"].includes(category)) errors.push("Choose a claim type.");
    if (!["url", "document", "license_lookup", "operator_attestation", "customer_consent"].includes(kind)) errors.push("Choose an evidence type.");
    if (!reference || reference.length > 500) errors.push("Add an evidence reference.");
    if (expiresOn && !isRealDate(expiresOn)) errors.push("Use a real date in YYYY-MM-DD format for the expiry date.");
    if (errors.length) return renderClaims(ctx, { kind: "error", message: errors.join(" ") }, 400);
    await ctx.tx(async (tx) => {
      const evidence: ClaimEvidence[] = [{ kind: kind as ClaimEvidence["kind"], reference, captured_at: new Date().toISOString() }];
      const id = await insertClaim(tx, { tenantId: ctx.tenantId, brandId: brand.id, text: claimText, category, evidence, expiresAt: expiresOn ? `${expiresOn}T23:59:59Z` : null });
      await appendAudit(tx, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: "claim.added", entityType: "claim", entityId: id, after: { text: claimText, category } });
    });
    return redirect(`/w/${ctx.tenantId}/claims?m=claim_added`);
  });

  for (const op of ["verify", "reject"] as const) {
    router.post(`/w/:tenantId/claims/:claimId/${op}`, async (req) => {
      const ctx = await workspace(req);
      if (op === "verify" ? !canApproveAction(ctx.role, "verify_claim") : !can(ctx.role, ROLES.rejectClaim)) forbid(op === "verify" ? "Only the business owner can verify claims." : undefined);
      const claimId = idParam(req, "claimId");
      const ok = await ctx.tx(async (tx) => {
        if (!(await setClaimStatus(tx, { claimId, status: op === "verify" ? "verified" : "rejected", userId: ctx.s.userId }))) return false;
        await appendAudit(tx, ctx.tenantId, { actorType: "user", actorId: ctx.s.userId, action: op === "verify" ? "claim.verified" : "claim.rejected", entityType: "claim", entityId: claimId });
        return true;
      });
      if (!ok) return renderClaims(ctx, { kind: "error", message: "That claim can't be changed (it may already be decided)." }, 409);
      return redirect(`/w/${ctx.tenantId}/claims?m=${op === "verify" ? "claim_verified" : "claim_rejected"}`);
    });
  }

  // ------------------------------------------------------------------------- dispatcher
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", base);
    } catch {
      send(res, text("Bad request", 400), SECURITY_HEADERS);
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    const r: Req = { method, url, headers: req.headers, params: {}, cookies, ip: clientIp(req, deps.trustedProxies ?? 0), form: new URLSearchParams() };
    let out: Res;
    try {
      const m = router.match(method, url.pathname);
      if (m === null) throw new HttpError(404, "That page doesn't exist.");
      if (m === "method_not_allowed") throw new HttpError(405, "Method not allowed");
      r.params = m.params;
      if (method === "POST") {
        assertSameOrigin(r, base);
        r.form = await readForm(req);
        // Every POST except sign-in requires a session-bound CSRF token.
        if (url.pathname !== "/login" && url.pathname !== "/login/verify") {
          const s = sessionOf(r);
          if (!s) throw new HttpError(401, "Sign in required");
          assertCsrf(deps.sessionSecret, s, r.form.get("_csrf"));
        }
      }
      out = await m.handler(r);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 401) out = method === "GET" ? redirect("/login") : htmlResponse(V.errorPage(401, "Your session ended. Sign in again."), 401);
        else out = htmlResponse(V.errorPage(err.status, err.message), err.status);
      } else {
        log(`[http] ${method} ${url.pathname} failed`, err);
        out = htmlResponse(V.errorPage(500, "The server hit an unexpected error. It has been logged."), 500);
      }
    }
    const headers: Record<string, string> = { ...SECURITY_HEADERS };
    if (secureCookies) headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
    if (!url.pathname.startsWith("/static/")) headers["cache-control"] = "no-store";
    send(res, method === "HEAD" ? { ...out, body: "" } : out, headers);
    if (process.env.JAT_ACCESS_LOG === "1") console.log(`${method} ${url.pathname} ${out.status} ${Date.now() - started}ms`);
  };
}

/** YYYY-MM-DD that exists on the calendar (rejects 2026-02-31, which Date.parse rolls over). */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Client IP: the socket address, or the Nth-from-last X-Forwarded-For hop when behind N trusted proxies. */
export function clientIp(req: IncomingMessage, trustedProxies: number): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (trustedProxies <= 0) return socketIp;
  const header = req.headers["x-forwarded-for"];
  const hops = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - trustedProxies] ?? socketIp;
}
