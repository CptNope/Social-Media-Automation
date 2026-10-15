import { html, type Html } from "../html.ts";

export interface Shell {
  title: string;
  csrf: string;
  user: { email: string; name: string | null };
  workspace?: { id: string; name: string; roleLabel: string };
  active?: "overview" | "brand" | "claims" | "plan" | "content" | "approvals" | "connections" | "workspaces";
}

export const ROLE_LABELS: Record<string, string> = {
  agency_operator: "Agency operator",
  client_owner: "Owner",
  client_editor: "Editor",
  reviewer: "Reviewer",
};

export function page(shell: Shell, body: Html, opts: { refreshSeconds?: number } = {}): Html {
  const w = shell.workspace;
  const navLink = (key: Shell["active"], href: string, label: string) => html`<a href="${href}" ${shell.active === key ? html`aria-current="page"` : ""}>${label}</a>`;
  return html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${opts.refreshSeconds ? html`<meta http-equiv="refresh" content="${opts.refreshSeconds}">` : ""}
<title>${shell.title} – JAT Marketing OS</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<div class="shell">
  <aside class="side">
    <a class="brandmark" href="/">JAT Marketing OS<span>Jeremy Anderson Tech</span></a>
    ${
      w
        ? html`<div>
      <div class="workspace-name">${w.name}</div>
      <div class="small muted">${w.roleLabel}</div>
    </div>
    <nav class="nav" aria-label="Workspace">
      ${navLink("overview", `/w/${w.id}`, "Overview")}
      ${navLink("brand", `/w/${w.id}/brand`, "Brand")}
      ${navLink("claims", `/w/${w.id}/claims`, "Claims")}
      ${navLink("plan", `/w/${w.id}/plan`, "Plan")}
      ${navLink("content", `/w/${w.id}/content`, "Content")}
      ${navLink("approvals", `/w/${w.id}/approvals`, "Approvals")}
      ${navLink("connections", `/w/${w.id}/connections`, "Connections")}
      ${navLink("workspaces", "/", "All clients")}
    </nav>`
        : html`<nav class="nav" aria-label="Main">${navLink("workspaces", "/", "Clients")}</nav>`
    }
    <div class="side-foot">
      ${shell.user.name ?? shell.user.email}
      <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${shell.csrf}"><button class="link" type="submit">Sign out</button></form>
    </div>
  </aside>
  <main class="main" id="main">
${body}
  </main>
</div>
</body>
</html>`;
}

export function bare(title: string, body: Html): Html {
  return html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} – JAT Marketing OS</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<main class="auth">
${body}
</main>
</body>
</html>`;
}

export const csrfField = (token: string): Html => html`<input type="hidden" name="_csrf" value="${token}">`;

export function notice(kind: "error" | "warn" | "ok", message: string | Html, items: string[] = []): Html {
  return html`<div class="notice ${kind}" role="${kind === "error" ? "alert" : "status"}">${message}${items.length ? html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` : ""}</div>`;
}

export function when(d: string | null | undefined): string {
  if (!d) return "";
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  // MVP: Jeremy Anderson Tech operates in US Eastern time; per-tenant time zones come later.
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
}
