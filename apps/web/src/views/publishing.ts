import type { IntegrationRow, PublicationRow } from "@jat/db";
import { html, type Html } from "../html.ts";
import { CHANNEL_LABELS } from "./content.ts";
import { csrfField, notice, page, when, type Shell } from "./layout.ts";

export const PUBLICATION_LABELS: Record<string, string> = {
  queued: "Scheduled",
  publishing: "Sending",
  published: "Published",
  failed: "Failed",
  needs_attention: "Needs attention",
  exported: "Posted manually",
  deleted: "Deleted",
  dry_run: "Dry run (not sent)",
  cancelled: "Cancelled",
};
const PUB_TAG: Record<string, string> = { queued: "scheduled", publishing: "publishing", published: "published", needs_attention: "failed", failed: "failed", dry_run: "draft", cancelled: "archived", exported: "exported", deleted: "archived" };
export const pubTag = (s: string): Html => html`<span class="tag st-${PUB_TAG[s] ?? "draft"}">${PUBLICATION_LABELS[s] ?? s}</span>`;

const INTEGRATION_LABELS: Record<IntegrationRow["status"], string> = { connected: "Connected", needs_reauth: "Reconnect needed", error: "Check failed / not set up", revoked: "Disconnected" };
const intTag = (s: IntegrationRow["status"]) => html`<span class="tag ${s === "connected" ? "verified" : "pending"}">${INTEGRATION_LABELS[s]}</span>`;

export interface PublishingStatus {
  configured: boolean;
  mode: "live" | "dry_run";
  tenantPublishingEnabled: boolean;
  tenantPausedAt: string | null;
  globalPaused: boolean;
}

/** One line explaining whether scheduled posts will actually be sent. */
export function modeNotice(s: PublishingStatus): Html {
  if (!s.configured) return notice("warn", "Publishing isn't configured on this server. Approved posts can still be exported as CSV.");
  if (s.globalPaused) return notice("error", "All publishing is paused by the platform operator. Nothing will be sent.");
  if (s.tenantPausedAt) return notice("error", html`Publishing is paused for this client since ${when(s.tenantPausedAt)}. Scheduled posts wait; posts more than a day late will need a decision.`);
  if (s.mode !== "live") return notice("warn", "Dry-run mode: scheduled posts go through every check at their time, but nothing is sent to any platform (PUBLISH_MODE is not \"live\").");
  if (!s.tenantPublishingEnabled) return notice("warn", "Dry-run mode for this client: a platform admin hasn't enabled live publishing yet. Scheduled posts are checked but not sent.");
  return notice("ok", "Live: scheduled posts are sent to the connected accounts at their time.");
}

export interface ConnectionsData {
  status: PublishingStatus;
  integrations: IntegrationRow[];
  publications: PublicationRow[];
  canManage: boolean;
  facebookConfigured: boolean;
  flash?: { kind: "ok" | "error"; message: string } | undefined;
}

const CONNECTABLE: Array<{ channel: string; blurb: string }> = [
  { channel: "facebook", blurb: "Posts to a Facebook Page you manage. You'll sign in with Facebook and pick the Page." },
  { channel: "bluesky", blurb: "Posts with an app password (Bluesky → Settings → Privacy and security → App passwords). Never use your main password." },
  { channel: "wordpress", blurb: "Connects the JAT Connector plugin for SEO changes and blog drafts. Needs a WordPress application password." },
];

export function connectionsPage(shell: Shell, d: ConnectionsData): Html {
  const w = shell.workspace!;
  const byChannel = new Map(d.integrations.map((i) => [i.channel, i]));
  const attention = d.publications.filter((p) => p.status === "needs_attention");
  return page(
    shell,
    html`<div class="page-head"><div><h1>Connections</h1><p class="muted">Accounts this client publishes to, and the switches that stop publishing.</p></div></div>
${d.flash ? notice(d.flash.kind, d.flash.message) : ""}
${modeNotice(d.status)}
${attention.length ? notice("error", `${attention.length} post${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} attention. See "Recent publishing" below.`) : ""}
<section class="panel"><h2>Pause publishing</h2>
  ${
    d.status.tenantPausedAt
      ? html`<p>Paused since ${when(d.status.tenantPausedAt)}. Nothing is sent for this client until you resume.</p>
  ${d.canManage ? html`<form method="post" action="/w/${w.id}/connections/pause">${csrfField(shell.csrf)}<input type="hidden" name="paused" value="0"><button type="submit">Resume publishing</button></form>` : ""}`
      : html`<p class="muted">Stops every scheduled post for this client immediately, on all channels. Use it if something looks wrong.</p>
  ${d.canManage ? html`<form method="post" action="/w/${w.id}/connections/pause">${csrfField(shell.csrf)}<input type="hidden" name="paused" value="1"><div class="field"><label for="pr">Reason <span class="hint">Optional</span></label><input id="pr" name="reason" type="text" maxlength="300"></div><button class="danger" type="submit">Pause all publishing</button></form>` : ""}`
  }
</section>
${CONNECTABLE.map(({ channel, blurb }) => {
  const i = byChannel.get(channel);
  return html`<section class="panel" id="ch-${channel}"><h2>${CHANNEL_LABELS[channel] ?? channel}</h2>
  ${
    i
      ? html`<dl class="facts small"><dt>Account</dt><dd>${i.displayName}</dd><dt>Status</dt><dd>${intTag(i.status)}${i.channelPaused ? html` <span class="tag pending">Paused</span>` : ""}</dd><dt>Last checked</dt><dd>${when(i.lastHealthCheckAt) || "Never"}</dd><dt>Connected</dt><dd>${when(i.createdAt)}</dd></dl>
  ${
    d.canManage
      ? html`<div class="row">
    <form method="post" action="/w/${w.id}/connections/${i.id}/check">${csrfField(shell.csrf)}<button class="secondary" type="submit">Test connection</button></form>
    ${channel !== "wordpress" ? html`<form method="post" action="/w/${w.id}/connections/${i.id}/${i.channelPaused ? "resume" : "pause"}">${csrfField(shell.csrf)}<button class="secondary" type="submit">${i.channelPaused ? "Resume this channel" : "Pause this channel"}</button></form>` : ""}
    <form method="post" action="/w/${w.id}/connections/${i.id}/disconnect">${csrfField(shell.csrf)}<button class="danger" type="submit">Disconnect</button></form>
  </div>`
      : ""
  }`
      : html`<p class="muted">${blurb}</p>`
  }
  ${d.canManage ? connectForm(shell, w.id, channel, !!i, d.facebookConfigured) : ""}
</section>`;
})}
<section class="panel"><h2>Recent publishing</h2>
${
  d.publications.length
    ? html`<table><thead><tr><th>Post</th><th>Channel</th><th>When</th><th>Status</th></tr></thead><tbody>
  ${d.publications.map(
    (p) => html`<tr><td><a href="/w/${w.id}/content/${p.contentItemId}">${p.hook ?? "Post"}</a>${p.lastError && p.status !== "published" ? html`<div class="small muted">${p.lastError}</div>` : ""}</td>
    <td>${CHANNEL_LABELS[p.channel ?? ""] ?? p.channel}</td><td class="small">${when(p.publishedAt ?? p.scheduledFor)}</td>
    <td>${pubTag(p.status)}${p.permalink ? html` <a class="small" href="${safeHttps(p.permalink)}" rel="noopener noreferrer" target="_blank">View</a>` : ""}</td></tr>`,
  )}</tbody></table>`
    : html`<p class="muted">Nothing scheduled or published yet. Schedule an approved post from its page.</p>`
}
</section>`,
  );
}

function connectForm(shell: Shell, tenantId: string, channel: string, connected: boolean, facebookConfigured: boolean): Html {
  const label = connected ? "Connect a different account" : "Connect";
  if (channel === "facebook") {
    if (!facebookConfigured) return html`<p class="small muted">Facebook isn't configured on this server (FACEBOOK_APP_ID / FACEBOOK_APP_SECRET).</p>`;
    return html`<form method="post" action="/w/${tenantId}/connections/facebook/start">${csrfField(shell.csrf)}<button ${connected ? html`class="secondary"` : ""} type="submit">${connected ? "Reconnect or switch Page" : "Connect with Facebook"}</button></form>`;
  }
  if (channel === "bluesky") {
    return html`<details class="inline-details" ${connected ? "" : html`open`}><summary class="button ${connected ? "secondary" : ""}">${label}</summary>
<form method="post" action="/w/${tenantId}/connections/bluesky" autocomplete="off">${csrfField(shell.csrf)}
  <div class="field"><label for="bh">Handle</label><input id="bh" name="identifier" type="text" maxlength="253" required placeholder="yourbusiness.bsky.social"></div>
  <div class="field"><label for="bp">App password</label><input id="bp" name="app_password" type="password" maxlength="64" required autocomplete="new-password"></div>
  <button type="submit">Check and connect</button>
</form></details>`;
  }
  return html`<details class="inline-details" ${connected ? "" : html`open`}><summary class="button ${connected ? "secondary" : ""}">${label}</summary>
<form method="post" action="/w/${tenantId}/connections/wordpress" autocomplete="off">${csrfField(shell.csrf)}
  <div class="field"><label for="ws">Site address</label><input id="ws" name="site_url" type="url" maxlength="300" required placeholder="https://www.example.com"></div>
  <div class="field"><label for="wu">WordPress username</label><input id="wu" name="username" type="text" maxlength="60" required></div>
  <div class="field"><label for="wp">Application password <span class="hint">Users → Profile → Application Passwords</span></label><input id="wp" name="app_password" type="password" maxlength="64" required autocomplete="new-password"></div>
  <button type="submit">Save and get the signing secret</button>
</form></details>`;
}

const safeHttps = (u: string): string => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" ? x.toString() : "#";
  } catch {
    return "#";
  }
};

export function facebookPickPage(shell: Shell, d: { key: string; pages: Array<{ id: string; name: string; canPost: boolean }> }): Html {
  const w = shell.workspace!;
  const usable = d.pages.filter((p) => p.canPost);
  return page(
    shell,
    html`<div class="page-head"><div><h1>Choose a Facebook Page</h1><p class="muted">Posts will go to the Page you pick. You can change it later.</p></div></div>
${
  usable.length
    ? html`<form method="post" action="/w/${w.id}/connections/facebook/pick" class="panel">${csrfField(shell.csrf)}<input type="hidden" name="k" value="${d.key}">
  <fieldset><legend>Pages you can post to</legend>
  ${usable.map((p, n) => html`<div><label><input type="radio" name="page_id" value="${p.id}" ${n === 0 ? html`checked` : ""}> ${p.name}</label></div>`)}
  </fieldset>
  <button type="submit">Connect this Page</button>
</form>`
    : notice("error", "Facebook didn't return any Pages you can post to. You need a role on the Page that allows creating content.")
}
${d.pages.length > usable.length ? html`<p class="small muted">Not listed: ${d.pages.filter((p) => !p.canPost).map((p) => p.name).join(", ")} (your role there can't create posts).</p>` : ""}
<p><a href="/w/${w.id}/connections">Cancel</a></p>`,
  );
}

export function wordpressSecretPage(shell: Shell, d: { siteUrl: string; secret: string }): Html {
  const w = shell.workspace!;
  return page(
    shell,
    html`<div class="page-head"><div><h1>Finish connecting WordPress</h1><p class="muted">${d.siteUrl}</p></div></div>
${notice("warn", "Copy this signing secret now. It is shown only once.")}
<section class="panel">
  <ol>
    <li>Install and activate the <strong>JAT Connector</strong> plugin on the site.</li>
    <li>In WordPress, open <strong>Settings → JAT Connector</strong> and paste this signing secret:
      <p><code class="secret">${d.secret}</code></p></li>
    <li>Come back to Connections and click <strong>Test connection</strong>.</li>
  </ol>
</section>
<p><a class="button" href="/w/${w.id}/connections#ch-wordpress">Done — back to Connections</a></p>`,
  );
}
