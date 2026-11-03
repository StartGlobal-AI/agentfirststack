import type { Session } from "./env";
import { type SafeHtml, csrfField, fmtDay, fmtNum, html } from "./html";
import type { Resources } from "./services";

/** Pieces of HTML shared by the claim page and the dashboard. */

/**
 * Something to say to your agent instead of clicking around. public/dashboard.js adds a Copy
 * button; without scripts, one click still selects the whole prompt (user-select: all).
 */
export const askText = (text: string) => html`<q class="ask-q">${text}</q>`;

/** "Ask your agent: “…”" as one quiet line (lead null: just the prompt). */
export const askLine = (text: string, lead: string | null = "Ask your agent") =>
  html`<p class="ask-line">${lead === null ? "" : html`<span class="ask-lead">${lead}</span>`}${askText(text)}</p>`;

const unavailable = html`<p class="muted small">Couldn't load this service right now.</p>`;

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const SERVICES = {
  analytics: { cls: "svc-analytics", title: "Analytics", one: "site", many: "sites" },
  tags: { cls: "svc-tags", title: "Tags", one: "container", many: "containers" },
  mail: { cls: "svc-mail", title: "Mail", one: "inbox", many: "inboxes" },
} as const;

/**
 * A project's sites, tag containers and inboxes as three tiles. With `share`, each site gets an
 * "Open analytics dashboard" button (a POST that creates or reuses the site's share link).
 * `visitors` holds unique visitors over the last 7 days per site id, where analytics answered.
 */
export function resourcesView(
  r: Resources,
  share?: { projectId: string; session: Session },
  visitors: Map<string, number> = new Map(),
): SafeHtml {
  const tile = (svc: keyof typeof SERVICES, list: unknown[] | null, body: SafeHtml, empty: SafeHtml) => {
    const s = SERVICES[svc];
    return html`<section class="tile resource ${s.cls}">
  <div class="tile-head">
    <h2><span class="swatch" aria-hidden="true"></span>${s.title}</h2>
    ${list === null ? "" : html`<p class="tile-count"><b>${list.length}</b> ${list.length === 1 ? s.one : s.many}</p>`}
  </div>
  ${list === null ? unavailable : list.length ? body : empty}
</section>`;
  };

  const sites = tile(
    "analytics",
    r.sites,
    html`<ul class="items">${(r.sites ?? []).map((s) => {
      const v = visitors.get(s.id);
      return html`<li>
      <div class="item-main"><b>${s.domain}</b>${
        v === undefined ? "" : html`<span class="item-stat"><b>${fmtNum(v)}</b> ${v === 1 ? "visitor" : "visitors"}, 7 days</span>`
      }</div>
      <span class="item-meta"><code>${s.id}</code><span>Added ${fmtDay(s.created_at)}</span></span>
      ${
        share
          ? html`<form method="post" action="/dashboard/projects/${share.projectId}/sites/${s.id}/share">${csrfField(share.session)}<button class="btn btn-primary btn-small btn-open" type="submit">Open analytics dashboard</button></form>`
          : ""
      }
    </li>`;
    })}</ul>`,
    html`<p class="muted small">No sites yet.</p>${share ? askLine("Add analytics to my website.", "Ask your agent") : ""}`,
  );
  const containers = tile(
    "tags",
    r.containers,
    html`<ul class="items">${(r.containers ?? []).map(
      (t) => html`<li>
      <div class="item-main"><b>${t.domain}</b><span class="state ${t.live_version ? "is-live" : ""}">${
        t.live_version ? `version ${t.live_version} live` : "not published yet"
      }</span></div>
      <span class="item-meta"><code>${t.id}</code><span>Added ${fmtDay(t.created_at)}</span></span>
    </li>`,
    )}</ul>`,
    html`<p class="muted small">No tag containers yet.</p>${share ? askLine("Track sign-ups as Meta and Google Ads conversions.") : ""}`,
  );
  const inboxes = tile(
    "mail",
    r.inboxes,
    html`<ul class="items">${(r.inboxes ?? []).map(
      (i) => html`<li>
      <div class="item-main"><b>${i.address}</b></div>
      <span class="item-meta"><code>${i.id}</code><span>Last mail ${fmtDay(i.last_message_at)}</span></span>
    </li>`,
    )}</ul>`,
    html`<p class="muted small">No inboxes yet.</p>${share ? askLine("Create an inbox for our sign-up emails.") : ""}`,
  );
  return html`<div class="bento resources">
  ${sites}
  ${containers}
  ${inboxes}
</div>`;
}

/**
 * "1 site, 1 container, 1 inbox" as three small coloured cells: the mark's three bars as data.
 * A service that couldn't be reached shows "?".
 */
export function resourceCounts(r: Resources): SafeHtml {
  const cell = (svc: keyof typeof SERVICES, list: unknown[] | null) => {
    const s = SERVICES[svc];
    if (list === null)
      return html`<li class="count ${s.cls} is-unknown"><b>?</b> ${s.many}<span class="sr-only">, couldn't load</span></li>`;
    return html`<li class="count ${s.cls}${list.length ? "" : " is-zero"}"><b>${list.length}</b> ${list.length === 1 ? s.one : s.many}</li>`;
  };
  return html`<ul class="counts" aria-label="Resources">
    ${cell("analytics", r.sites)}
    ${cell("tags", r.containers)}
    ${cell("mail", r.inboxes)}
  </ul>`;
}
