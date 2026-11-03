import { type SafeHtml, html } from "./html";
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
 * What a project has set up, as three tiles: where analytics is installed, which tag containers
 * exist, which inboxes it uses. No numbers or reports on purpose: those are for the owner's agent
 * to fetch (or to build into a dashboard of their own, see dashboard-prompt.ts).
 * With `asks`, empty tiles suggest what to ask the agent.
 */
export function resourcesView(r: Resources, opts: { asks?: boolean } = {}): SafeHtml {
  const tile = <T>(svc: keyof typeof SERVICES, list: T[] | null, line: (x: T) => { main: string; id: string }, empty: SafeHtml) => {
    const s = SERVICES[svc];
    return html`<section class="tile resource ${s.cls}">
  <h2><span class="swatch" aria-hidden="true"></span>${s.title}</h2>
  ${
    list === null
      ? unavailable
      : list.length
        ? html`<ul class="items">${list.map((x) => {
            const l = line(x);
            return html`<li><b>${l.main}</b><code>${l.id}</code></li>`;
          })}</ul>`
        : empty
  }
</section>`;
  };
  const none = (what: string, ask: string) =>
    html`<p class="muted small">No ${what} yet.</p>${opts.asks ? askLine(ask, "Ask your agent") : ""}`;
  return html`<div class="bento resources">
  ${tile("analytics", r.sites, (s) => ({ main: s.domain, id: s.id }), none("sites", "Add analytics to my website."))}
  ${tile("tags", r.containers, (t) => ({ main: t.domain, id: t.id }), none("tag containers", "Track sign-ups as Meta and Google Ads conversions."))}
  ${tile("mail", r.inboxes, (i) => ({ main: i.address, id: i.id }), none("inboxes", "Create an inbox for our sign-up emails."))}
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
