import { CHANNELS, DEFAULT_TIMEZONE, PLATFORM_LIMITS, addDays, composeCaption, localDate, measureLength, type Finding, type PostDraft } from "@jat/core";
import type { ApprovalRow, CampaignRow, ChannelSetting, ContentItemRow, PublicationRow, SlotRow, WorkRun } from "@jat/db";
import { html, type Html } from "../html.ts";
import { csrfField, notice, page, when, type Shell } from "./layout.ts";
import { modeNotice, pubTag, type PublishingStatus } from "./publishing.ts";

export const CHANNEL_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  threads: "Threads",
  bluesky: "Bluesky",
  x: "X",
  pinterest: "Pinterest",
  tiktok: "TikTok",
  youtube: "YouTube",
  google_business_profile: "Google Business Profile",
  wordpress: "WordPress",
};
const ch = (c: string) => CHANNEL_LABELS[c] ?? c;

export const STATE_LABELS: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  exported: "Exported",
  failed: "Failed",
  paused: "Paused",
  archived: "Archived",
};
const stateTag = (s: string) => html`<span class="tag st-${s}">${STATE_LABELS[s] ?? s}</span>`;
const riskTag = (r: string | null) => (r ? html`<span class="tag risk-${r}">${r === "high" ? "High risk" : r === "medium" ? "Medium risk" : "Low risk"}</span>` : "");

const TZ = DEFAULT_TIMEZONE;
const localTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ });
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });

// ---------------------------------------------------------------------------
// Plan page: channels, plan generator, campaigns, calendar
// ---------------------------------------------------------------------------
export interface PlanPageData {
  website: string | null;
  channels: ChannelSetting[];
  campaigns: Array<CampaignRow & { slotCount: number; undrafted: number }>;
  runs: WorkRun[];
  month: string; // YYYY-MM
  slots: SlotRow[];
  canManage: boolean;
  hasActiveDna: boolean;
  defaultStart: string;
  flash?: { kind: "ok" | "error"; message: string } | undefined;
}

const CAMPAIGN_STATUS: Record<string, string> = { proposed: "Proposed", approved: "Approved", active: "Active", completed: "Completed", cancelled: "Cancelled" };

export function planPage(shell: Shell, d: PlanPageData): Html {
  const w = shell.workspace!;
  const enabled = d.channels.filter((c) => c.enabled && c.postsPerWeek > 0);
  const setting = (c: string) => d.channels.find((x) => x.channel === c);
  const organic = CHANNELS.filter((c) => c !== "wordpress");
  return page(
    shell,
    html`<div class="page-head"><div><h1>Plan</h1><p class="muted">Channels, campaigns and the posting calendar. Posts are delivered as an export until a channel is connected.</p></div></div>
${d.flash ? notice(d.flash.kind, d.flash.message) : ""}
${!d.hasActiveDna ? notice("warn", html`Approve the <a href="/w/${w.id}/brand">Brand DNA</a> before planning. Plans and posts are written from the approved version.`) : ""}
<div class="grid-2">
<section class="panel">
  <h2>Channels</h2>
  ${
    d.canManage
      ? html`<form method="post" action="/w/${w.id}/plan/channels">${csrfField(shell.csrf)}
    <div class="field"><label for="site">Website for links <span class="hint">Posts link here with tracking tags</span></label><input id="site" name="website_url" type="url" value="${d.website ?? ""}" placeholder="https://"></div>
    <table class="compact"><thead><tr><th>Channel</th><th>Posts per week</th></tr></thead><tbody>
    ${organic.map((c) => {
      const s = setting(c);
      return html`<tr><td><label class="inline"><input type="checkbox" name="on_${c}" ${s?.enabled && (s?.postsPerWeek ?? 0) > 0 ? html`checked` : ""}> ${ch(c)}</label></td>
        <td><input class="narrow" type="number" name="ppw_${c}" min="0" max="21" value="${String(s?.postsPerWeek ?? defaultCadence(c))}" aria-label="${ch(c)} posts per week"></td></tr>`;
    })}
    </tbody></table>
    <button type="submit">Save channels</button></form>`
      : enabled.length
        ? html`<ul>${enabled.map((c) => html`<li>${ch(c.channel)}: ${c.postsPerWeek} per week</li>`)}</ul>`
        : html`<p class="muted">No channels set up yet.</p>`
  }
</section>
<section class="panel">
  <h2>Plan the next weeks</h2>
  ${
    d.canManage && d.hasActiveDna && enabled.length
      ? html`<form method="post" action="/w/${w.id}/plan/generate">${csrfField(shell.csrf)}
    <div class="row">
      <div class="field"><label for="start">Start date</label><input id="start" name="start_date" type="text" value="${d.defaultStart}" pattern="\\d{4}-\\d{2}-\\d{2}" required></div>
      <div class="field"><label for="days">Length</label><select id="days" name="days"><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option></select></div>
    </div>
    <div class="field"><label for="goals">Goals <span class="hint">What should this period achieve?</span></label><textarea id="goals" name="goals" rows="3" maxlength="2000" placeholder="Book 15 furnace tune-ups; grow local awareness in Shrewsbury"></textarea></div>
    <div class="field"><label for="events">Events and promotions <span class="hint">Optional. Only these are used; nothing is invented.</span></label><textarea id="events" name="events" rows="2" maxlength="2000"></textarea></div>
    <button type="submit">Draft a plan</button></form>`
      : html`<p class="muted">${!d.hasActiveDna ? "Needs approved Brand DNA." : !enabled.length ? "Turn on at least one channel first." : "Only operators and owners can create plans."}</p>`
  }
</section>
</div>
${d.runs.length ? runsPanel(w.id, d.runs) : ""}
<section class="panel">
  <h2>Campaigns</h2>
  ${
    d.campaigns.length
      ? html`<table><thead><tr><th>Campaign</th><th>Dates</th><th>Posts</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead><tbody>
    ${d.campaigns.map(
      (c) => html`<tr><td><a href="/w/${w.id}/campaigns/${c.id}">${c.name}</a><div class="small muted">${c.objective}</div></td>
      <td class="small">${c.startsOn} – ${c.endsOn}</td><td>${c.slotCount}</td><td><span class="tag camp-${c.status}">${CAMPAIGN_STATUS[c.status]}</span></td>
      <td><div class="row">${
        d.canManage && c.status === "proposed"
          ? html`<form method="post" action="/w/${w.id}/campaigns/${c.id}/approve">${csrfField(shell.csrf)}<button class="secondary" type="submit">Approve plan</button></form>`
          : ""
      }${
        d.canManage && (c.status === "approved" || c.status === "active") && c.undrafted > 0
          ? html`<form method="post" action="/w/${w.id}/campaigns/${c.id}/draft">${csrfField(shell.csrf)}<button type="submit">Draft ${c.undrafted} post${c.undrafted === 1 ? "" : "s"}</button></form>`
          : ""
      }</div></td></tr>`,
    )}
  </tbody></table>`
      : html`<p class="muted">No campaigns yet.</p>`
  }
</section>
${calendar(w.id, d.month, d.slots)}`,
  );
}

function defaultCadence(c: string): number {
  return ({ facebook: 3, instagram: 3, linkedin: 2, google_business_profile: 1 } as Record<string, number>)[c] ?? 0;
}

const RUN_KIND: Record<string, string> = { plan: "Planning", draft: "Drafting posts" };
const RUN_STATUS: Record<string, string> = { queued: "Queued", running: "Working", done: "Done", failed: "Failed" };

function runsPanel(tenantId: string, runs: WorkRun[]): Html {
  return html`<section class="panel"><h2>Recent jobs</h2><table><thead><tr><th>Started</th><th>Job</th><th>Status</th><th>Result</th></tr></thead><tbody>
  ${runs.map(
    (r) => html`<tr><td class="small"><a href="/w/${tenantId}/runs/${r.id}">${when(r.createdAt)}</a></td><td>${RUN_KIND[r.kind]}</td>
    <td><span class="tag ${r.status === "done" ? "ready" : r.status === "failed" ? "failed" : "running"}">${RUN_STATUS[r.status]}</span></td>
    <td class="small">${r.error ?? r.progress.message ?? (r.progress.total ? `${r.progress.done ?? 0} of ${r.progress.total}` : "")}</td></tr>`,
  )}</tbody></table></section>`;
}

export function workRunPage(shell: Shell, r: WorkRun): Html {
  const w = shell.workspace!;
  const running = r.status === "queued" || r.status === "running";
  return page(
    shell,
    html`<div class="page-head"><div><h1>${RUN_KIND[r.kind]}</h1><p class="muted">Started ${when(r.createdAt)}</p></div><span class="tag ${r.status === "done" ? "ready" : r.status === "failed" ? "failed" : "running"}">${RUN_STATUS[r.status]}</span></div>
${running ? notice("warn", "Working… this page refreshes every few seconds.") : ""}
${r.status === "failed" ? notice("error", r.error ?? "The job failed.") : ""}
${r.status === "done" ? notice("ok", r.progress.message ?? "Done.") : ""}
${r.progress.total ? html`<p>${r.progress.done ?? 0} of ${r.progress.total} done${r.progress.failed ? `, ${r.progress.failed} failed` : ""}.</p>` : ""}
<div class="row">${r.campaignId ? html`<a href="/w/${w.id}/campaigns/${r.campaignId}">Open the campaign</a>` : ""}${r.kind === "draft" && r.status === "done" ? html`<a href="/w/${w.id}/approvals">Go to approvals</a>` : ""}<a href="/w/${w.id}/plan">Back to plan</a></div>`,
    running ? { refreshSeconds: 3 } : {},
  );
}

function monthDays(month: string): string[] {
  const first = `${month}-01`;
  const out: string[] = [];
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) out.push(d);
  return out;
}

function calendar(tenantId: string, month: string, slots: SlotRow[]): Html {
  const days = monthDays(month);
  const lead = new Date(`${days[0]}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const byDay = new Map<string, SlotRow[]>();
  for (const s of slots) {
    const k = localDate(new Date(s.publishAt), TZ);
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  const prev = addDays(`${month}-01`, -1).slice(0, 7);
  const next = addDays(days.at(-1)!, 1).slice(0, 7);
  const label = new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const cells: Html[] = [];
  for (let i = 0; i < lead; i++) cells.push(html`<div class="cal-cell empty" aria-hidden="true"></div>`);
  for (const d of days) {
    const items = byDay.get(d) ?? [];
    cells.push(html`<div class="cal-cell${items.length ? " has" : ""}"><div class="cal-date">${Number(d.slice(8))}</div>
      ${items.map((s) => html`<a class="cal-item ch-${s.channel}" href="${s.contentItemId ? `/w/${tenantId}/content/${s.contentItemId}` : `/w/${tenantId}/campaigns/${s.campaignId}#slot-${s.id}`}">
        <span class="cal-meta">${localTime(s.publishAt)} ${ch(s.channel)}${s.contentState ? html`, ${(STATE_LABELS[s.contentState] ?? "").toLowerCase()}` : ""}</span>${s.topic}</a>`)}
    </div>`);
  }
  return html`<section class="panel">
  <div class="cal-head"><h2>${label}</h2><nav class="row small" aria-label="Month"><a href="?month=${prev}">Previous month</a><a href="?month=${next}">Next month</a></nav></div>
  <div class="cal" role="grid" aria-label="${label} posting calendar">
    ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => html`<div class="cal-dow" role="columnheader">${d}</div>`)}
    ${cells}
  </div>
  ${slots.length ? "" : html`<p class="muted">Nothing scheduled this month.</p>`}
</section>`;
}

// ---------------------------------------------------------------------------
// Campaign detail
// ---------------------------------------------------------------------------
export function campaignPage(shell: Shell, d: { campaign: CampaignRow; slots: SlotRow[]; canManage: boolean; flash?: { kind: "ok" | "error"; message: string } | undefined }): Html {
  const w = shell.workspace!;
  const c = d.campaign;
  const editable = d.canManage && (c.status === "proposed" || c.status === "approved");
  return page(
    shell,
    html`<div class="page-head"><div><h1>${c.name}</h1><p class="muted">${c.startsOn} – ${c.endsOn}, objective: ${c.objective}</p></div><span class="tag camp-${c.status}">${CAMPAIGN_STATUS[c.status]}</span></div>
${d.flash ? notice(d.flash.kind, d.flash.message) : ""}
${c.description ? html`<p>${c.description}</p>` : ""}
${
  (c.planNotes.assumptions?.length ?? 0) + (c.planNotes.risks?.length ?? 0)
    ? html`<div class="grid-2">
  ${c.planNotes.assumptions?.length ? html`<section class="panel"><h2>Assumptions</h2><ul>${c.planNotes.assumptions.map((a) => html`<li>${a}</li>`)}</ul></section>` : ""}
  ${c.planNotes.risks?.length ? html`<section class="panel"><h2>Risks</h2><ul>${c.planNotes.risks.map((a) => html`<li>${a}</li>`)}</ul></section>` : ""}
</div>`
    : ""
}
<section class="panel"><h2>Posts</h2>
<table><thead><tr><th>When</th><th>Channel</th><th>Topic</th><th>Pillar and persona</th><th>Status</th>${editable ? html`<th><span class="visually-hidden">Actions</span></th>` : ""}</tr></thead><tbody>
${d.slots.map(
  (s) => html`<tr id="slot-${s.id}"><td class="small">${localDay(s.publishAt)}<br>${localTime(s.publishAt)}</td><td>${ch(s.channel)}<div class="small muted">${s.format}</div></td>
  <td>${s.topic}${s.offerClaimId ? html`<div class="small muted">Promotion</div>` : ""}</td><td class="small">${s.pillarId}<br>${s.personaId}</td>
  <td>${s.contentItemId ? html`<a href="/w/${w.id}/content/${s.contentItemId}">${stateTag(s.contentState ?? "draft")}</a>` : html`<span class="tag pending">Not drafted</span>`}</td>
  ${
    editable
      ? html`<td>${
          !s.contentItemId
            ? html`<details class="edit"><summary>Change</summary>
    <form method="post" action="/w/${w.id}/slots/${s.id}/move">${csrfField(shell.csrf)}
      <div class="row"><input class="narrow-date" name="date" type="text" value="${localDate(new Date(s.publishAt), TZ)}" pattern="\\d{4}-\\d{2}-\\d{2}" aria-label="Date"><input class="narrow" name="time" type="text" value="${new Date(s.publishAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ })}" pattern="\\d{2}:\\d{2}" aria-label="Time (24h)"></div>
      <div class="field"><input name="topic" type="text" value="${s.topic}" maxlength="300" aria-label="Topic"></div>
      <button type="submit" class="secondary">Save</button>
    </form>
    <form method="post" action="/w/${w.id}/slots/${s.id}/cancel">${csrfField(shell.csrf)}<button class="danger" type="submit">Remove from plan</button></form></details>`
            : ""
        }</td>`
      : ""
  }</tr>`,
)}
</tbody></table></section>
<div class="row">
${editable && c.status === "proposed" ? html`<form method="post" action="/w/${w.id}/campaigns/${c.id}/approve">${csrfField(shell.csrf)}<button type="submit">Approve plan</button></form>` : ""}
${d.canManage && (c.status === "approved" || c.status === "active") && d.slots.some((s) => !s.contentItemId) ? html`<form method="post" action="/w/${w.id}/campaigns/${c.id}/draft">${csrfField(shell.csrf)}<button type="submit">Draft posts</button></form>` : ""}
${d.slots.some((s) => s.contentState === "approved") ? html`<a class="button secondary" href="/w/${w.id}/export.csv?campaign=${c.id}">Download approved posts (CSV)</a>` : ""}
<a href="/w/${w.id}/plan">Back to plan</a>
</div>`,
  );
}

// ---------------------------------------------------------------------------
// Content list, item, approvals
// ---------------------------------------------------------------------------
export function contentListPage(shell: Shell, d: { items: ContentItemRow[]; filter: string }): Html {
  const w = shell.workspace!;
  const filters: Array<[string, string]> = [["", "All"], ["draft", "Drafts"], ["in_review", "In review"], ["approved", "Approved"], ["exported", "Exported"]];
  return page(
    shell,
    html`<div class="page-head"><div><h1>Content</h1><p class="muted">Every drafted post, newest schedule first.</p></div>
  <a class="button secondary" href="/w/${w.id}/export.csv">Download approved posts (CSV)</a></div>
<nav class="row small filters" aria-label="Filter">${filters.map(([v, l]) => html`<a href="?state=${v}" ${d.filter === v ? html`aria-current="page"` : ""}>${l}</a>`)}</nav>
<section class="panel">${
      d.items.length
        ? html`<table><thead><tr><th>When</th><th>Channel</th><th>Post</th><th>Risk</th><th>Status</th></tr></thead><tbody>
  ${d.items.map((i) => {
    const p = i.body as PostDraft | null;
    return html`<tr><td class="small">${i.publishAt ? html`${localDay(i.publishAt)}<br>${localTime(i.publishAt)}` : ""}</td><td>${ch(i.channel)}</td>
    <td><a href="/w/${w.id}/content/${i.id}">${p?.hook ?? i.topic ?? "Untitled"}</a>${i.findings.some((f) => f.severity === "blocker") ? html`<div class="small finding">Needs fixes before review</div>` : ""}</td>
    <td>${riskTag(i.riskClass)}</td><td>${stateTag(i.state)}</td></tr>`;
  })}
</tbody></table>`
        : html`<p class="muted">No posts here yet. Draft posts from an approved plan on the <a href="/w/${w.id}/plan">Plan</a> page.</p>`
    }</section>`,
  );
}

export interface ItemPageData {
  item: ContentItemRow;
  approvals: ApprovalRow[];
  canEdit: boolean;
  canApprove: boolean;
  approverLabel: string;
  canExport: boolean;
  canRecheck: boolean;
  lintNow: Finding[];
  flash?: { kind: "ok" | "error"; message: string } | undefined;
  publishing?: {
    status: PublishingStatus;
    publications: PublicationRow[];
    /** Why this post can't be published automatically, or null. */
    blocker: string | null;
    accountName: string | null;
    canSchedule: boolean;
    defaultAt: { date: string; time: string };
  };
}

function publishingPanel(shell: Shell, i: ContentItemRow, pb: NonNullable<ItemPageData["publishing"]>): Html {
  const w = shell.workspace!;
  const live = pb.publications.find((p) => p.status === "queued" || p.status === "publishing");
  const last = pb.publications[0];
  const show = ["approved", "scheduled", "publishing", "published", "failed"].includes(i.state) || pb.publications.length > 0;
  if (!show) return html``;
  const ambiguous = last?.status === "needs_attention" && /may have posted|may or may not|lost track/i.test(last.lastError ?? "");
  return html`<section class="panel" id="publishing"><h2>Publishing</h2>
${i.state === "approved" || i.state === "scheduled" ? modeNotice(pb.status) : ""}
${
  i.state === "approved" && pb.canSchedule
    ? pb.blocker
      ? html`<p class="muted">${pb.blocker}</p>`
      : html`<p class="small muted">Publishes to <strong>${pb.accountName ?? ""}</strong>. Every check runs again right before sending.</p>
<form method="post" action="/w/${w.id}/content/${i.id}/schedule" class="row schedule-form">${csrfField(shell.csrf)}<input type="hidden" name="fingerprint" value="${i.contentHash ?? ""}">
  <div class="field"><label for="sd">Date</label><input id="sd" name="date" type="text" value="${pb.defaultAt.date}" pattern="\\d{4}-\\d{2}-\\d{2}" required></div>
  <div class="field"><label for="st">Time <span class="hint">US Eastern, 24-hour</span></label><input id="st" name="time" type="text" value="${pb.defaultAt.time}" pattern="\\d{2}:\\d{2}" required></div>
  <button type="submit">Schedule</button>
</form>
<form method="post" action="/w/${w.id}/content/${i.id}/schedule" class="row">${csrfField(shell.csrf)}<input type="hidden" name="fingerprint" value="${i.contentHash ?? ""}"><input type="hidden" name="now" value="1"><span class="small muted">or</span><button class="secondary" type="submit">Publish now</button></form>`
    : ""
}
${
  i.state === "scheduled" && live
    ? html`<p>Scheduled for <strong>${when(live.scheduledFor)}</strong>${live.nextAttemptAt ? html` (next try ${when(live.nextAttemptAt)})` : ""}.${live.lastError ? html` <span class="small muted">${live.lastError}</span>` : ""}</p>
${pb.canSchedule ? html`<form method="post" action="/w/${w.id}/content/${i.id}/unschedule">${csrfField(shell.csrf)}<button class="secondary" type="submit">Unschedule</button></form>` : ""}`
    : ""
}
${
  i.state === "failed" && pb.canSchedule
    ? html`${ambiguous ? notice("warn", "The last attempt may have posted. Check the account before retrying, or mark it as posted.") : ""}
<div class="row">${pb.blocker ? html`<p class="muted">${pb.blocker}</p>` : html`<form method="post" action="/w/${w.id}/content/${i.id}/retry">${csrfField(shell.csrf)}<button type="submit">Retry now</button></form>`}</div>`
    : ""
}
${
  pb.publications.length
    ? html`<table><thead><tr><th>Attempt</th><th>Status</th><th>Details</th></tr></thead><tbody>
${pb.publications.map(
  (p) => html`<tr><td class="small">${when(p.publishedAt ?? p.scheduledFor ?? p.createdAt)}</td><td>${pubTag(p.status)}</td>
  <td class="small">${p.permalink && /^https:\/\//.test(p.permalink) ? html`<a href="${p.permalink}" rel="noopener noreferrer" target="_blank">View post</a>` : ""}${p.lastError ? html`<div class="muted">${p.lastError}</div>` : ""}${p.attempts > 1 ? html`<div class="muted">${p.attempts} attempts</div>` : ""}</td></tr>`,
)}</tbody></table>`
    : ""
}
</section>`;
}

function findingList(findings: readonly Finding[] | ContentItemRow["findings"]): Html {
  if (!findings.length) return html`<p class="muted small">No issues found.</p>`;
  const order = { blocker: 0, warning: 1, info: 2 } as Record<string, number>;
  return html`<ul class="findings">${[...findings]
    .sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3))
    .map((f) => html`<li class="f-${f.severity}"><span class="tag ${f.severity === "blocker" ? "blocker" : f.severity === "warning" ? "guess" : "missing"}">${f.severity === "blocker" ? "Must fix" : f.severity === "warning" ? "Check" : "Note"}</span> ${f.message}${f.span ? html` <q>${f.span}</q>` : ""}${f.code.startsWith("ai.") ? html` <span class="small muted">(AI review)</span>` : ""}</li>`)}</ul>`;
}

export function contentItemPage(shell: Shell, d: ItemPageData): Html {
  const w = shell.workspace!;
  const i = d.item;
  const p = i.body as PostDraft;
  const caption = composeCaption(p);
  const limits = PLATFORM_LIMITS[p.channel];
  const len = measureLength(caption, limits.countBy);
  const editable = d.canEdit && ["draft", "in_review", "approved"].includes(i.state);
  const blockers = i.findings.filter((f) => f.severity === "blocker").length;
  const fromAi = (i.revisionCreatedBy ?? "").startsWith("work_run:");
  return page(
    shell,
    html`<div class="page-head"><div><h1>${ch(i.channel)} post</h1><p class="muted">${i.publishAt ? `${localDay(i.publishAt)}, ${localTime(i.publishAt)}` : ""}${i.topic ? ` — ${i.topic}` : ""}</p></div>
  <div class="row">${riskTag(i.riskClass)} ${stateTag(i.state)}</div></div>
${d.flash ? notice(d.flash.kind, d.flash.message) : ""}
<div class="post-layout">
  <section class="panel post-preview" aria-label="Preview">
    <h2>Preview</h2>
    <div class="caption">${caption}</div>
    <p class="small muted">${len} of ${limits.maxChars === Number.MAX_SAFE_INTEGER ? "∞" : limits.maxChars} ${limits.countBy}${linkLine(p.link?.url)}</p>
    <dl class="facts small post-facts">
    ${
      p.creative_brief
        ? html`<dt>Graphic headline</dt><dd>${p.creative_brief.headline}</dd>${p.creative_brief.supporting_text ? html`<dt>Graphic text</dt><dd>${p.creative_brief.supporting_text}</dd>` : ""}${p.creative_brief.image_subject ? html`<dt>Image</dt><dd>${p.creative_brief.image_subject}</dd>` : ""}<dt>Alt text</dt><dd>${p.alt_text ?? html`<span class="finding">Missing</span>`}</dd>`
        : ""
    }
    <dt>Pillar</dt><dd>${p.pillar_id}</dd><dt>Persona</dt><dd>${p.persona_id}</dd><dt>Objective</dt><dd>${p.objective}</dd><dt>Success measure</dt><dd>${p.expected_kpi.metric}${p.expected_kpi.target ? ` (target ${p.expected_kpi.target})` : ""}</dd>
    <dt>Facts used</dt><dd>${p.claim_ids_used.length ? `${p.claim_ids_used.length} verified claim(s)` : "None"}</dd><dt>Version</dt><dd>${i.revision} (${fromAi ? "AI draft" : "edited by a person"})</dd></dl>
  </section>
  <section class="panel">
    <h2>Checks</h2>
    ${findingList(i.findings)}
    ${i.review?.summary ? html`<p class="small muted">AI reviewer: ${i.review.summary}</p>` : !fromAi ? html`<p class="small muted">The AI review ran on an earlier version; the automatic checks above ran on this one. The approver should read the post closely.</p>` : ""}
  </section>
</div>
${
  editable
    ? html`<details class="panel edit" ${blockers && i.state === "draft" ? html`open` : ""}><summary><strong>Edit post</strong></summary>
<form method="post" action="/w/${w.id}/content/${i.id}/edit">${csrfField(shell.csrf)}<input type="hidden" name="base_hash" value="${i.contentHash ?? ""}">
  <div class="field"><label for="hook">Opening line</label><input id="hook" name="hook" type="text" value="${p.hook}" maxlength="500" required></div>
  <div class="field"><label for="body">Body</label><textarea id="body" name="body" rows="6" maxlength="5000">${p.body}</textarea></div>
  <div class="field"><label for="cta">Call to action</label><input id="cta" name="cta" type="text" value="${p.cta}" maxlength="300"></div>
  <div class="field"><label for="tags">Hashtags <span class="hint">Space-separated, without #</span></label><input id="tags" name="hashtags" type="text" value="${p.hashtags.join(" ")}" maxlength="500"></div>
  ${p.creative_brief ? html`<div class="field"><label for="alt">Alt text</label><input id="alt" name="alt_text" type="text" value="${p.alt_text ?? ""}" maxlength="400"></div>` : ""}
  <p class="small muted">Saving creates a new version and sends the post back to draft. Any earlier approval no longer applies.</p>
  <button type="submit">Save changes</button>
</form></details>`
    : ""
}
<div class="sticky-actions">
  ${
    d.canEdit && i.state === "draft"
      ? html`<form method="post" action="/w/${w.id}/content/${i.id}/submit">${csrfField(shell.csrf)}<button type="submit" ${blockers ? html`disabled` : ""}>Send for approval</button></form>`
      : ""
  }
  ${
    d.canApprove && i.state === "in_review"
      ? html`<form method="post" action="/w/${w.id}/content/${i.id}/approve">${csrfField(shell.csrf)}<input type="hidden" name="fingerprint" value="${i.contentHash ?? ""}"><button type="submit">Approve</button></form>
  <details class="inline-details"><summary class="button secondary">Request changes</summary>
    <form method="post" action="/w/${w.id}/content/${i.id}/changes">${csrfField(shell.csrf)}<label for="cm" class="visually-hidden">What should change?</label><textarea id="cm" name="comment" rows="3" maxlength="2000" required placeholder="What should change?"></textarea><button type="submit" class="secondary">Send back</button></form></details>`
      : ""
  }
  ${d.canRecheck && i.state === "draft" && !fromAi ? html`<form method="post" action="/w/${w.id}/content/${i.id}/recheck">${csrfField(shell.csrf)}<button class="secondary" type="submit">Re-check with AI</button></form>` : ""}
  ${d.canExport && (i.state === "approved" || i.state === "failed") ? html`<form method="post" action="/w/${w.id}/content/${i.id}/exported">${csrfField(shell.csrf)}<button class="secondary" type="submit">${i.state === "failed" ? "It did post — mark as posted" : "Mark as posted manually"}</button></form>` : ""}
  <span class="small muted">${
    i.state === "draft" && blockers ? `Fix ${blockers} issue${blockers === 1 ? "" : "s"} marked "Must fix" before sending for approval.` : i.state === "in_review" && !d.canApprove ? `Waiting for ${d.approverLabel}.` : i.state === "approved" ? "Approved. Schedule it below, or use the CSV export to post it by hand." : ""
  }</span>
</div>
${d.publishing ? publishingPanel(shell, i, d.publishing) : ""}
${
  d.approvals.length
    ? html`<section class="panel"><h2>Decisions</h2><ul>${d.approvals.map((a) => html`<li>${when(a.decidedAt)}: ${a.decision === "approved" ? "Approved" : a.decision === "rejected" ? "Rejected" : "Changes requested"}${a.contentHash !== i.contentHash ? html` <span class="small muted">(an earlier version)</span>` : ""}${a.comment ? html` — <q>${a.comment}</q>` : ""}</li>`)}</ul></section>`
    : ""
}`,
  );
}

function linkLine(url: string | undefined): Html | "" {
  if (!url) return "";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  return html`. Link: <a href="${u.toString()}" rel="noopener noreferrer" target="_blank">${u.host}${u.pathname}</a> (with tracking tags)`;
}

export function approvalsPage(shell: Shell, d: { items: ContentItemRow[]; canApprove: (risk: string | null) => boolean; flash?: { kind: "ok" | "error"; message: string } | undefined }): Html {
  const w = shell.workspace!;
  const batchable = d.items.filter((i) => i.riskClass !== "high" && d.canApprove(i.riskClass));
  return page(
    shell,
    html`<div class="page-head"><div><h1>Approvals</h1><p class="muted">Posts waiting for a decision. High-risk posts must be opened and approved one at a time.</p></div></div>
${d.flash ? notice(d.flash.kind, d.flash.message) : ""}
${
  d.items.length
    ? html`<form method="post" action="/w/${w.id}/approvals/batch">${csrfField(shell.csrf)}
<section class="panel"><table><thead><tr><th><span class="visually-hidden">Select</span></th><th>When</th><th>Channel</th><th>Post</th><th>Risk</th></tr></thead><tbody>
${d.items.map((i) => {
  const p = i.body as PostDraft;
  const can = i.riskClass !== "high" && d.canApprove(i.riskClass);
  return html`<tr><td>${can ? html`<input type="checkbox" name="item" value="${i.id}:${i.contentHash}" aria-label="Select post">` : ""}</td>
  <td class="small">${i.publishAt ? html`${localDay(i.publishAt)}<br>${localTime(i.publishAt)}` : ""}</td><td>${ch(i.channel)}</td>
  <td><a href="/w/${w.id}/content/${i.id}">${p.hook}</a><div class="small muted clamp">${p.body}</div></td><td>${riskTag(i.riskClass)}</td></tr>`;
})}
</tbody></table></section>
${batchable.length ? html`<div class="sticky-actions"><button type="submit">Approve selected</button><span class="small muted">Approval applies to the exact version shown; anything edited since is skipped.</span></div>` : ""}
</form>`
    : html`<section class="panel"><p class="muted">Nothing is waiting for approval.</p></section>`
}`,
  );
}
