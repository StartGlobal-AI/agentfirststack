import type { Session } from "./env";
import { type SafeHtml, csrfField, fmtDate, html } from "./html";
import type { Resources } from "./services";

/** Pieces of HTML shared by the claim page and the dashboard. */

const unavailable = html`<p class="muted small">Couldn't load this service right now.</p>`;

/**
 * A project's sites, tag containers and inboxes. With `share`, each site gets an "Open analytics
 * dashboard" button (a POST that creates or reuses the site's share link).
 */
export function resourcesView(r: Resources, share?: { projectId: string; session: Session }): SafeHtml {
  const sites =
    r.sites === null
      ? unavailable
      : r.sites.length
        ? html`<ul class="items">${r.sites.map(
            (s) =>
              html`<li><div><b>${s.domain}</b><span class="muted"><code>${s.id}</code> · added ${fmtDate(s.created_at)}</span></div>${
                share
                  ? html`<form method="post" action="/dashboard/projects/${share.projectId}/sites/${s.id}/share">${csrfField(share.session)}<button class="btn btn-quiet btn-small" type="submit">Open analytics dashboard</button></form>`
                  : ""
              }</li>`,
          )}</ul>`
        : html`<p class="muted small">No sites yet.</p>`;
  const containers =
    r.containers === null
      ? unavailable
      : r.containers.length
        ? html`<ul class="items">${r.containers.map(
            (t) =>
              html`<li><div><b>${t.domain}</b><span class="muted"><code>${t.id}</code> · ${
                t.live_version ? `version ${t.live_version} live` : "not published yet"
              }</span></div></li>`,
          )}</ul>`
        : html`<p class="muted small">No tag containers yet.</p>`;
  const inboxes =
    r.inboxes === null
      ? unavailable
      : r.inboxes.length
        ? html`<ul class="items">${r.inboxes.map(
            (i) =>
              html`<li><div><b>${i.address}</b><span class="muted"><code>${i.id}</code> · last mail ${fmtDate(i.last_message_at)}</span></div></li>`,
          )}</ul>`
        : html`<p class="muted small">No inboxes yet.</p>`;
  return html`<div class="resources">
  <section class="card svc-analytics"><h2><span class="dot" aria-hidden="true"></span>Analytics</h2>${sites}</section>
  <section class="card svc-tags"><h2><span class="dot" aria-hidden="true"></span>Tags</h2>${containers}</section>
  <section class="card svc-mail"><h2><span class="dot" aria-hidden="true"></span>Mail</h2>${inboxes}</section>
</div>`;
}

/** "3 sites · 1 container · 2 inboxes" for the project list. */
export function resourceCounts(r: Resources): string {
  const n = (list: unknown[] | null, one: string, many: string) =>
    list === null ? `${many}: unavailable` : `${list.length} ${list.length === 1 ? one : many}`;
  return [n(r.sites, "site", "sites"), n(r.containers, "container", "containers"), n(r.inboxes, "inbox", "inboxes")].join(" · ");
}
