import type { BrandDna, Finding, Provenanced } from "@jat/core";
import type { AuditRow, BrandRow, ClaimRow, DnaVersion, DnaVersionSummary, OnboardingRun, TenantRow, Workspace } from "@jat/db";
import { html, type Html } from "../html.ts";
import { FIELD_LABELS, SECTION_LABELS, editorKind, editorValue } from "../brand-fields.ts";
import { BRAND_FIELD_PATHS } from "@jat/ai";
import { ROLE_LABELS, bare, csrfField, notice, page, when, type Shell } from "./layout.ts";

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------
export function loginPage(opts: { error?: string; email?: string } = {}): Html {
  return bare(
    "Sign in",
    html`<h1>Sign in</h1>
<p class="muted">We'll email you a one-time sign-in link. There are no passwords.</p>
${opts.error ? notice("error", opts.error) : ""}
<form class="panel" method="post" action="/login">
  <div class="field">
    <label for="email">Work email</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${opts.email ?? ""}">
  </div>
  <button type="submit">Email me a sign-in link</button>
</form>`,
  );
}

export function loginSentPage(email: string, devLink?: string): Html {
  return bare(
    "Check your email",
    html`<h1>Check your email</h1>
<p>If <strong>${email}</strong> has an account, a sign-in link is on its way. The link works once and expires in 15 minutes.</p>
${devLink ? notice("warn", html`Development mode: <a href="${devLink}">open the sign-in link</a>. This shortcut is disabled in production.`) : ""}
<p><a href="/login">Use a different email</a></p>`,
  );
}

export function verifyPage(token: string): Html {
  return bare(
    "Finish signing in",
    html`<h1>Finish signing in</h1>
<p class="muted">Confirm to sign in on this device.</p>
<form class="panel" method="post" action="/login/verify">
  <input type="hidden" name="token" value="${token}">
  <button type="submit">Sign in</button>
</form>`,
  );
}

export function errorPage(status: number, message: string): Html {
  const title = status === 404 ? "Not found" : status === 403 ? "Not allowed" : "Something went wrong";
  return bare(title, html`<h1>${title}</h1><p>${message}</p><p><a href="/">Go to your clients</a></p>`);
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------
export function workspacesPage(shell: Shell, workspaces: Workspace[]): Html {
  return page(
    shell,
    html`<div class="page-head"><div><h1>Clients</h1><p class="muted">Workspaces you can open.</p></div></div>
${
  workspaces.length
    ? html`<div class="panel"><table>
  <thead><tr><th>Client</th><th>Your role</th></tr></thead>
  <tbody>${workspaces.map((w) => html`<tr><td><a href="/w/${w.tenantId}">${w.name}</a></td><td>${ROLE_LABELS[w.role] ?? w.role}</td></tr>`)}</tbody>
</table></div>`
    : notice("warn", "You don't belong to any client workspace yet. Ask a Jeremy Anderson Tech admin to add you.")
}`,
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
const MODE_LABELS = { manual: "Manual — every action needs approval", assisted: "Assisted — routine work is prepared automatically", autonomous: "Autonomous — pre-approved low-risk posts publish automatically" };

export function overviewPage(
  shell: Shell,
  d: { tenant: TenantRow; brand: BrandRow | null; activeVersion: DnaVersionSummary | null; proposed: DnaVersionSummary[]; claims: ClaimRow[]; audit: AuditRow[]; canManage: boolean },
): Html {
  const w = shell.workspace!;
  const pendingClaims = d.claims.filter((c) => c.status === "pending").length;
  const verified = d.claims.filter((c) => c.status === "verified").length;
  const needs: Html[] = [];
  if (!d.brand) needs.push(html`<li>Set up the brand for this client.</li>`);
  for (const v of d.proposed) needs.push(html`<li><a href="/w/${w.id}/brand/versions/${v.id}">Review Brand DNA proposal v${v.version}</a></li>`);
  if (pendingClaims) needs.push(html`<li><a href="/w/${w.id}/claims">${pendingClaims} claim${pendingClaims === 1 ? "" : "s"} waiting for the owner to verify</a></li>`);

  return page(
    shell,
    html`<div class="page-head"><div><h1>${d.tenant.name}</h1><p class="muted">${MODE_LABELS[d.tenant.automationMode]}</p></div></div>
${d.tenant.pausedAt ? notice("warn", `All scheduled work for this client is paused (since ${when(d.tenant.pausedAt)}).`) : ""}
<div class="grid-2">
  <section class="panel">
    <h2>Needs you</h2>
    ${needs.length ? html`<ul>${needs}</ul>` : html`<p class="muted">Nothing is waiting on you.</p>`}
  </section>
  <section class="panel">
    <h2>Brand</h2>
    ${
      d.brand
        ? html`<dl class="facts">
      <dt>Brand DNA</dt><dd>${d.activeVersion ? html`Version ${d.activeVersion.version}, approved ${when(d.activeVersion.approvedAt)}` : html`<span class="tag pending">Not approved yet</span>`}</dd>
      <dt>Claims</dt><dd>${verified} verified, ${pendingClaims} pending</dd>
      <dt>Publishing</dt><dd>${d.tenant.publishingEnabled ? "Enabled" : "Off (dry run only)"}</dd>
    </dl>
    <p class="small"><a href="/w/${w.id}/brand">Open brand</a></p>`
        : d.canManage
          ? html`<form method="post" action="/w/${w.id}/brands">${csrfField(shell.csrf)}
      <div class="field"><label for="bname">Brand name</label><input id="bname" name="name" type="text" required maxlength="120" value="${d.tenant.name}"></div>
      <button type="submit">Create brand</button></form>`
          : html`<p class="muted">No brand has been set up yet.</p>`
    }
  </section>
</div>
<section class="panel">
  <h2>Recent activity</h2>
  ${
    d.audit.length
      ? html`<table><thead><tr><th>When</th><th>What</th><th>Who</th></tr></thead><tbody>
    ${d.audit.map((a) => html`<tr><td class="small">${when(a.createdAt)}</td><td>${describeAction(a.action)}</td><td class="small muted">${a.actorType === "agent" ? "AI agent" : a.actorType === "system" ? "System" : "Team member"}</td></tr>`)}
  </tbody></table>`
      : html`<p class="muted">No activity yet.</p>`
  }
</section>`,
  );
}

const ACTION_LABELS: Record<string, string> = {
  "brand.created": "Brand created",
  "onboarding.started": "Brand onboarding started",
  "brand_dna.proposed": "Brand DNA proposal created",
  "brand_dna.field_confirmed": "Brand DNA field confirmed",
  "brand_dna.field_edited": "Brand DNA field edited",
  "brand_dna.activated": "Brand DNA approved and activated",
  "brand_dna.rejected": "Brand DNA proposal rejected",
  "claim.added": "Claim added",
  "claim.verified": "Claim verified",
  "claim.rejected": "Claim rejected",
};
const describeAction = (a: string): string => ACTION_LABELS[a] ?? a;

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------
const RUN_LABELS: Record<OnboardingRun["status"], string> = { queued: "Queued", crawling: "Reading website", extracting: "Drafting Brand DNA", ready: "Ready for review", failed: "Failed" };
const runTag = (s: OnboardingRun["status"]) => html`<span class="tag ${s === "ready" ? "ready" : s === "failed" ? "failed" : "running"}">${RUN_LABELS[s]}</span>`;

export function brandPage(shell: Shell, d: { brand: BrandRow; versions: DnaVersionSummary[]; runs: OnboardingRun[]; canStart: boolean; tenantName: string; error?: string }): Html {
  const w = shell.workspace!;
  const active = d.versions.find((v) => v.status === "active");
  return page(
    shell,
    html`<div class="page-head"><div><h1>${d.brand.name}</h1><p class="muted">Brand DNA is the approved profile every piece of content is written from.</p></div>
  ${active ? html`<a class="button secondary" href="/w/${w.id}/brand/versions/${active.id}">View approved Brand DNA</a>` : ""}</div>
${d.error ? notice("error", d.error) : ""}
<section class="panel">
  <h2>Versions</h2>
  ${
    d.versions.length
      ? html`<table><thead><tr><th>Version</th><th>Status</th><th>Created</th><th>Approved</th></tr></thead><tbody>
    ${d.versions.map((v) => html`<tr><td><a href="/w/${w.id}/brand/versions/${v.id}">v${v.version}</a></td><td><span class="tag ${v.status}">${statusWord(v.status)}</span></td><td class="small">${when(v.createdAt)}</td><td class="small">${when(v.approvedAt)}</td></tr>`)}
  </tbody></table>`
      : html`<p class="muted">No Brand DNA yet. Start onboarding below to draft one from the client's website and your notes.</p>`
  }
</section>
${
  d.canStart
    ? html`<section class="panel">
  <h2>Draft Brand DNA</h2>
  <p class="muted">We read the website (respecting robots.txt), then draft a profile. Every value cites its source. Nothing is used until the owner approves it.</p>
  <form method="post" action="/w/${w.id}/brand/onboarding">${csrfField(shell.csrf)}
    <div class="field"><label for="url">Website <span class="hint">Public homepage, e.g. https://example.com</span></label><input id="url" name="website_url" type="url" placeholder="https://"></div>
    <div class="field"><label for="bn">Business name</label><input id="bn" name="business_name" type="text" maxlength="160" value="${d.tenantName}" required></div>
    <div class="field"><label for="ind">Industry <span class="hint">Optional</span></label><input id="ind" name="industry" type="text" maxlength="160"></div>
    <div class="field"><label for="loc">Locations or service areas <span class="hint">One per line, optional</span></label><textarea id="loc" name="locations" rows="3" maxlength="2000"></textarea></div>
    <div class="field"><label for="notes">Notes from the client <span class="hint">Facts and preferences they told you. Treated as a source and cited as "note:operator".</span></label><textarea id="notes" name="notes" rows="5" maxlength="20000"></textarea></div>
    <button type="submit">Draft Brand DNA</button>
  </form>
</section>`
    : ""
}
${
  d.runs.length
    ? html`<section class="panel"><h2>Onboarding runs</h2><table><thead><tr><th>Started</th><th>Website</th><th>Status</th></tr></thead><tbody>
  ${d.runs.map((r) => html`<tr><td class="small"><a href="/w/${w.id}/brand/runs/${r.id}">${when(r.createdAt)}</a></td><td class="small">${r.websiteUrl ?? "Notes only"}</td><td>${runTag(r.status)}</td></tr>`)}
</tbody></table></section>`
    : ""
}`,
  );
}

const statusWord = (s: string): string => ({ proposed: "Proposed", active: "Approved", superseded: "Superseded", rejected: "Rejected" })[s] ?? s;

export function runPage(shell: Shell, run: OnboardingRun): Html {
  const w = shell.workspace!;
  const running = run.status !== "ready" && run.status !== "failed";
  const cs = run.crawlSummary as { pages?: number; skipped?: number; robots?: string; colors?: string[]; fonts?: string[] };
  return page(
    shell,
    html`<div class="page-head"><div><h1>Onboarding run</h1><p class="muted">Started ${when(run.createdAt)}${run.websiteUrl ? ` for ${run.websiteUrl}` : ""}</p></div>${runTag(run.status)}</div>
${running ? notice("warn", "Working… this page refreshes every few seconds.") : ""}
${run.status === "failed" ? notice("error", run.error ?? "The run failed.") : ""}
${run.status === "ready" && run.dnaVersionId ? notice("ok", html`The Brand DNA proposal is ready. <a href="/w/${w.id}/brand/versions/${run.dnaVersionId}">Review it</a>.`) : ""}
<section class="panel"><h2>What we collected</h2>
<dl class="facts">
  <dt>Pages read</dt><dd>${cs.pages ?? 0}</dd>
  <dt>Pages skipped</dt><dd>${cs.skipped ?? 0}</dd>
  <dt>robots.txt</dt><dd>${cs.robots === "ok" ? "Found and followed" : cs.robots === "absent" ? "None found (all pages allowed)" : cs.robots === "unreachable" ? "Unreachable, so no pages were read" : "—"}</dd>
  <dt>AI cost</dt><dd>$${(run.costMicros / 1e6).toFixed(2)}</dd>
</dl></section>
${run.missingInfo.length ? html`<section class="panel"><h2>Ask the client</h2><p class="muted">The most useful facts we couldn't find.</p><ul>${run.missingInfo.map((m) => html`<li>${m}</li>`)}</ul></section>` : ""}
${run.conflicts.length ? html`<section class="panel"><h2>Conflicting sources</h2><ul>${run.conflicts.map((c) => html`<li><strong>${FIELD_LABELS[c.path] ?? c.path}</strong>: ${c.description} <span class="small muted">(${c.sources.join(", ")})</span></li>`)}</ul></section>` : ""}
<p><a href="/w/${w.id}/brand">Back to brand</a></p>`,
    running ? { refreshSeconds: 4 } : {},
  );
}

// ---------------------------------------------------------------------------
// Brand DNA review
// ---------------------------------------------------------------------------
type ProvClass = "sourced" | "guess" | "human" | "missing";

function provenanceOf(f: Provenanced<unknown>): { cls: ProvClass; label: string } {
  const empty = f.value === null || (Array.isArray(f.value) && f.value.length === 0);
  if (empty || f.status === "missing") return { cls: "missing", label: "Not found" };
  if (f.status === "operator") return { cls: "human", label: "Entered by a person" };
  if (f.status === "inferred") return f.confirmed_by ? { cls: "human", label: "Inferred, then confirmed" } : { cls: "guess", label: "Inferred — needs confirmation" };
  return { cls: "sourced", label: f.confirmed_by ? "From source, confirmed" : "From source" };
}

function renderValue(path: string, v: unknown): Html {
  if (v === null || v === undefined || (Array.isArray(v) && v.length === 0)) return html`<span class="empty">Nothing yet</span>`;
  if (path === "visual.colors" && Array.isArray(v)) {
    return html`<ul class="swatches">${(v as Array<{ name: string; hex: string; role: string }>).map(
      (c) => html`<li><svg width="22" height="22" aria-hidden="true"><rect width="22" height="22" fill="${/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : "#000000"}"/></svg><span>${c.name} <span class="muted small">${c.hex}, ${c.role}</span></span></li>`,
    )}</ul>`;
  }
  if (typeof v === "string" || typeof v === "number") return html`${String(v)}`;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return html`<ul class="chips">${(v as string[]).map((x) => html`<li>${x}</li>`)}</ul>`;
  if (Array.isArray(v)) {
    return html`<ul class="plain">${v.map((item) => {
      const o = item as Record<string, unknown>;
      const title = (o.name ?? o.label ?? o.family ?? "") as string;
      const desc = (o.description ?? o.address ?? (o.role ? `Role: ${o.role}` : "")) as string;
      return html`<li><strong>${title}</strong>${desc ? html` — ${desc}` : ""}</li>`;
    })}</ul>`;
  }
  return html`<pre class="value">${JSON.stringify(v, null, 2)}</pre>`;
}

function editor(path: string, value: unknown): Html {
  const k = editorKind(path);
  const id = `ed-${path.replace(".", "-")}`;
  const val = editorValue(path, value);
  if (k.kind === "text") return html`<input id="${id}" name="value" type="text" value="${val}">`;
  if (k.kind === "number") return html`<input id="${id}" name="value" type="number" value="${val}">`;
  if (k.kind === "select") return html`<select id="${id}" name="value"><option value="">Not set</option>${k.options.map((o) => html`<option ${o === val ? html`selected` : ""}>${o}</option>`)}</select>`;
  if (k.kind === "lines") return html`<textarea id="${id}" name="value" rows="4">${val}</textarea><span class="hint">One per line. Leave empty to mark as not found.</span>`;
  return html`<textarea id="${id}" name="value" class="code" rows="8">${val}</textarea><span class="hint">JSON. Leave empty to mark as not found.</span>`;
}

export function versionPage(
  shell: Shell,
  d: { version: DnaVersion; dna: BrandDna; run: OnboardingRun | null; activationIssues: Finding[]; canEdit: boolean; canActivate: boolean; canReject: boolean; flash?: { kind: "ok" | "error"; message: string }; sourceUris: Map<string, string>; fingerprint: string },
): Html {
  const w = shell.workspace!;
  const editable = d.version.status === "proposed";
  const findingsByField = new Map<string, Finding[]>();
  for (const f of d.run?.findings ?? []) if (f.field) findingsByField.set(f.field, [...(findingsByField.get(f.field) ?? []), f as Finding]);
  // Amber already marks unconfirmed inferences; the red outline is for other blockers.
  const blockerFields = new Set(d.activationIssues.filter((i) => i.code !== "brand.inferred_unconfirmed").map((i) => i.field));
  const needConfirm = d.activationIssues.filter((i) => i.code === "brand.inferred_unconfirmed").length;

  const sections = Object.keys(SECTION_LABELS).map((section) => {
    const rows = BRAND_FIELD_PATHS.filter((p) => p.startsWith(`${section}.`)).map((path) => {
      const [s, k] = path.split(".") as [string, string];
      const f = (d.dna as unknown as Record<string, Record<string, Provenanced<unknown>>>)[s]![k]!;
      const prov = provenanceOf(f);
      const fieldFindings = findingsByField.get(path) ?? [];
      const showConfirm = editable && d.canEdit && f.status === "inferred" && f.value !== null && !f.confirmed_by;
      return html`<div class="dna-row ${prov.cls}${prov.cls === "missing" ? " is-missing" : ""}${blockerFields.has(path) ? " has-blocker" : ""}" id="f-${path}">
  <div class="dna-label">${FIELD_LABELS[path] ?? path}</div>
  <div class="dna-value">
    ${renderValue(path, f.value)}
    ${fieldFindings.map((ff) => html`<div class="finding ${ff.severity}">${ff.message}</div>`)}
    ${
      editable && d.canEdit
        ? html`<details class="edit"><summary>Edit</summary>
      <form method="post" action="/w/${w.id}/brand/versions/${d.version.id}/field">${csrfField(shell.csrf)}
        <input type="hidden" name="path" value="${path}"><input type="hidden" name="action" value="edit">
        <label class="visually-hidden" for="ed-${path.replace(".", "-")}">${FIELD_LABELS[path] ?? path}</label>
        ${editor(path, f.value)}
        <div class="row"><button type="submit">Save</button></div>
      </form></details>`
        : ""
    }
  </div>
  <div class="dna-prov">
    <span class="tag ${prov.cls}">${prov.label}</span>
    ${f.sources.map((src) => {
      const uri = d.sourceUris.get(src);
      return html`<span class="src">${uri && /^https?:/.test(uri) ? html`<a href="${uri}" rel="noopener noreferrer" target="_blank">${src}</a>` : src}</span>`;
    })}
    ${f.value !== null ? html`<span class="src">Confidence: ${f.confidence}</span>` : ""}
    ${
      showConfirm
        ? html`<form method="post" action="/w/${w.id}/brand/versions/${d.version.id}/field">${csrfField(shell.csrf)}<input type="hidden" name="path" value="${path}"><input type="hidden" name="action" value="confirm"><button class="secondary" type="submit">Confirm</button></form>`
        : ""
    }
  </div>
</div>`;
    });
    return html`<h2 class="section-title">${SECTION_LABELS[section]}</h2>${rows}`;
  });

  return page(
    shell,
    html`<div class="page-head"><div><h1>Brand DNA v${d.version.version}</h1>
  <p class="muted">${editable ? "Proposal — review each field. Inferred values need a person to confirm or correct them." : d.version.status === "active" ? `Approved ${when(d.version.approvedAt)}. Approved versions can't change; draft a new version to update it.` : statusWord(d.version.status)}</p></div>
  <span class="tag ${d.version.status}">${statusWord(d.version.status)}</span></div>
${d.flash ? notice(d.flash.kind, d.flash.message) : ""}
${
  editable && d.activationIssues.length
    ? notice(
        "warn",
        needConfirm ? `${needConfirm} inferred field${needConfirm === 1 ? " needs" : "s need"} confirmation before this can be approved.` : "This proposal has issues to fix before it can be approved.",
        d.activationIssues.filter((i) => i.code !== "brand.inferred_unconfirmed").map((i) => i.message),
      )
    : ""
}
<div class="legend" aria-label="Legend"><span class="l-sourced">From a source</span><span class="l-guess">Inferred, needs confirmation</span><span class="l-human">Entered or confirmed by a person</span><span class="l-missing">Not found</span></div>
${sections}
${
  editable && (d.canActivate || d.canReject)
    ? html`<div class="sticky-actions">
  ${
    d.canActivate
      ? html`<form method="post" action="/w/${w.id}/brand/versions/${d.version.id}/activate">${csrfField(shell.csrf)}<input type="hidden" name="fingerprint" value="${d.fingerprint}"><button type="submit" ${d.activationIssues.length ? html`disabled aria-describedby="activate-help"` : ""}>Approve and activate</button></form>`
      : ""
  }
  ${d.canReject ? html`<form method="post" action="/w/${w.id}/brand/versions/${d.version.id}/reject">${csrfField(shell.csrf)}<button class="danger" type="submit">Reject proposal</button></form>` : ""}
  <span id="activate-help" class="small muted">${d.canActivate ? (d.activationIssues.length ? "Resolve the highlighted fields first." : "Activating replaces the current approved version.") : "Only the business owner can approve Brand DNA."}</span>
</div>`
    : ""
}`,
  );
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------
const CLAIM_STATUS: Record<ClaimRow["status"], string> = { pending: "Pending", verified: "Verified", rejected: "Rejected", expired: "Expired" };
const CLAIM_CATEGORIES = ["credential", "history", "offer", "statistic", "testimonial", "award", "service", "other"] as const;
const EVIDENCE_KINDS = [
  ["url", "Web page"],
  ["document", "Document"],
  ["license_lookup", "License lookup"],
  ["operator_attestation", "Client told us"],
  ["customer_consent", "Customer consent (testimonials)"],
] as const;

export function claimsPage(shell: Shell, d: { brand: BrandRow; claims: ClaimRow[]; canAdd: boolean; canVerify: boolean; canReject: boolean; flash?: { kind: "ok" | "error"; message: string } }): Html {
  const w = shell.workspace!;
  const groups: Array<[string, ClaimRow[]]> = [
    ["Waiting for verification", d.claims.filter((c) => c.status === "pending")],
    ["Verified", d.claims.filter((c) => c.status === "verified")],
    ["Rejected or expired", d.claims.filter((c) => c.status === "rejected" || c.status === "expired")],
  ];
  return page(
    shell,
    html`<div class="page-head"><div><h1>Claims</h1><p class="muted">Facts the business is allowed to state publicly. Content may only use verified claims, and only the owner can verify one.</p></div></div>
${d.flash ? notice(d.flash.kind, d.flash.message) : ""}
${groups.map(([title, rows]) =>
  rows.length
    ? html`<section class="panel"><h2>${title}</h2><table><thead><tr><th>Claim</th><th>Evidence</th><th>Status</th>${d.canVerify || d.canReject ? html`<th><span class="visually-hidden">Actions</span></th>` : ""}</tr></thead><tbody>
  ${rows.map(
    (c) => html`<tr><td>${c.text}<div class="small muted">${c.category}${c.expiresAt ? `, expires ${when(c.expiresAt)}` : ""}</div></td>
    <td class="small">${c.evidence.length ? c.evidence.map((e) => html`<div>${/^https?:/.test(e.reference) ? html`<a href="${e.reference}" rel="noopener noreferrer" target="_blank">${e.reference}</a>` : e.reference}${e.note ? html`<div class="muted">${e.note}</div>` : ""}</div>`) : html`<span class="muted">None — add evidence before verifying</span>`}</td>
    <td><span class="tag ${c.status}">${CLAIM_STATUS[c.status]}</span></td>
    ${
      d.canVerify || d.canReject
        ? html`<td><div class="row">
      ${d.canVerify && c.status === "pending" && c.evidence.length ? html`<form method="post" action="/w/${w.id}/claims/${c.id}/verify">${csrfField(shell.csrf)}<button class="secondary" type="submit">Verify</button></form>` : ""}
      ${d.canReject && c.status !== "rejected" ? html`<form method="post" action="/w/${w.id}/claims/${c.id}/reject">${csrfField(shell.csrf)}<button class="danger" type="submit">Reject</button></form>` : ""}
    </div></td>`
        : ""
    }</tr>`,
  )}
</tbody></table></section>`
    : "",
)}
${d.claims.length === 0 ? html`<p class="muted">No claims yet. Brand onboarding suggests claims it finds on the website; you can also add them here.</p>` : ""}
${
  d.canAdd
    ? html`<section class="panel"><h2>Add a claim</h2>
<form method="post" action="/w/${w.id}/claims">${csrfField(shell.csrf)}
  <div class="field"><label for="ct">Claim</label><input id="ct" name="text" type="text" maxlength="500" required placeholder="Licensed plumbing contractor in Massachusetts"></div>
  <div class="field"><label for="cc">Type</label><select id="cc" name="category">${CLAIM_CATEGORIES.map((c) => html`<option>${c}</option>`)}</select></div>
  <div class="field"><label for="ek">Evidence</label><select id="ek" name="evidence_kind">${EVIDENCE_KINDS.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></div>
  <div class="field"><label for="er">Evidence reference <span class="hint">A URL, license number or document name</span></label><input id="er" name="evidence_reference" type="text" maxlength="500" required></div>
  <div class="field"><label for="ex">Expires <span class="hint">Optional, for offers and time-limited facts</span></label><input id="ex" name="expires_on" type="text" placeholder="YYYY-MM-DD" pattern="\\d{4}-\\d{2}-\\d{2}"></div>
  <button type="submit">Add claim</button>
</form></section>`
    : ""
}`,
  );
}

export function noBrandPage(shell: Shell): Html {
  const w = shell.workspace!;
  return page(shell, html`<h1>No brand yet</h1><p>Create the brand from the <a href="/w/${w.id}">overview</a> first.</p>`);
}
