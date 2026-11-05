import { type SafeHtml, html } from "./html";
import type { Resources } from "./services";
import type { CheckStatus, SetupCheck, SetupReport } from "./setup-check";

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
  replay: { cls: "svc-replay", title: "Replay", one: "replay site", many: "replay sites" },
} as const;

/**
 * What a project has set up, as four tiles: where analytics is installed, which tag containers
 * exist, which inboxes it uses, where replay records. No numbers or reports on purpose: those are
 * for the owner's agent to fetch (or to build into a dashboard of their own, see
 * dashboard-prompt.ts). With `asks`, empty tiles suggest what to ask the agent.
 */
export function resourcesView(r: Resources, opts: { asks?: boolean } = {}): SafeHtml {
  const tile = <T>(
    svc: keyof typeof SERVICES,
    list: T[] | null,
    line: (x: T) => { main: string; id: string; note?: string },
    empty: SafeHtml,
  ) => {
    const s = SERVICES[svc];
    return html`<section class="tile resource ${s.cls}">
  <h2><span class="swatch" aria-hidden="true"></span>${s.title}</h2>
  ${
    list === null
      ? unavailable
      : list.length
        ? html`<ul class="items">${list.map((x) => {
            const l = line(x);
            return html`<li><b>${l.main}</b>${l.note ? html`<span class="item-note">${l.note}</span>` : ""}<code>${l.id}</code></li>`;
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
  ${tile(
    "replay",
    r.replaySites,
    (s) => ({ main: s.domain, id: s.id, note: s.enabled === false ? "paused" : undefined }),
    none("replay sites", "Turn on session replay for my website."),
  )}
</div>`;
}

/**
 * "1 site, 1 container, 1 inbox, 1 replay site" as small coloured cells, one per service.
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
    ${cell("replay", r.replaySites)}
  </ul>`;
}

const CHECK_LABEL: Record<CheckStatus, string> = {
  ok: "Done",
  missing: "Missing",
  failing: "Not working",
  warning: "Worth a look",
  waiting_on_owner: "Waiting on you",
  unavailable: "Couldn't check",
};

const checkItem = (c: SetupCheck) =>
  html`<li class="check is-${c.status}"><span class="check-status">${CHECK_LABEL[c.status]}</span><span class="check-body"><span class="check-title">${c.title}${
    c.domain ? html` <span class="check-domain">${c.domain}</span>` : ""
  }</span><span class="check-detail">${c.detail}</span></span></li>`;

/**
 * The setup check (src/setup-check.ts) for the owner: what still needs doing first, what's done
 * folded away, and the prompt that has their agent finish it. Fixes are API calls, so they're left
 * to the agent; the owner sees what and why.
 */
export function setupView(r: SetupReport, finishPrompt: string): SafeHtml {
  const open = r.checks.filter((c) => c.status !== "ok");
  const done = r.checks.filter((c) => c.status === "ok");
  const todo = r.checks.filter((c) => c.status === "missing" || c.status === "failing" || c.status === "unavailable").length;
  return html`<section class="tile setup-check" aria-labelledby="setup-title">
  <div class="tile-head"><h2 id="setup-title">Setup check</h2><span class="tile-count"><b>${done.length}</b> of ${r.checks.length} done</span></div>
  <p class="setup-summary">${
    r.ready
      ? "Everything in the full setup is in place."
      : `${plural(todo, "thing", "things")} to finish for the full setup (analytics, tags, email and replay). Your agent can do ${todo === 1 ? "it" : "them"}: open it in the project's folder and paste the prompt below.`
  }</p>
  ${open.length ? html`<ul class="checks">${open.map(checkItem)}</ul>` : ""}
  ${done.length ? html`<details class="checks-done"><summary>${plural(done.length, "check", "checks")} done</summary><ul class="checks">${done.map(checkItem)}</ul></details>` : ""}
  ${r.ready ? "" : askLine(finishPrompt, null)}
</section>`;
}
