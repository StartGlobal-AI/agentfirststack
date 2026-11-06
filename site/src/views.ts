import type { AttackItem } from "@afs/shared";
import { attackHeadline, attackLine, attackTabUrl } from "./email-messages";
import { type SafeHtml, html } from "./html";
import type { InboxItem, Resources } from "./services";
import { STATUS_MARK, STATUS_WORD, type SetupReport } from "./setup-check";

/** Pieces of HTML shared by the claim page and the dashboard. */

/**
 * Something to say to your agent instead of clicking around. public/dashboard.js adds a Copy
 * button; without scripts, one click still selects the whole prompt (user-select: all).
 */
export const askText = (text: string) => html`<q class="ask-q">${text}</q>`;

/** "Ask your agent: “…”" as one quiet line (lead null: just the prompt). */
export const askLine = (text: string, lead: string | null = "Ask your agent") =>
  html`<p class="ask-line">${lead === null ? "" : html`<span class="ask-lead">${lead}</span>`}${askText(text)}</p>`;

/**
 * Suspicious traffic a site or container set aside (project-health.ts attackItems), as a banner on
 * the Overview and the Analytics and Tags tabs: what was seen, what was done (the same lines as the
 * site_attack email), and the prompt to review it. An episode that ended (last 24 h) is quieter.
 * With `projectId`, each line links to its tab (except `current`, the page it's on).
 */
export function attacksView(items: AttackItem[], o: { name: string; prompt: string; projectId?: string; current?: string }): SafeHtml {
  const active = items.some((a) => a.state !== "ended");
  return html`<section class="tile attack-tile${active ? "" : " ended"}" id="attacks" aria-labelledby="attacks-title">
  <h2 id="attacks-title">${attackHeadline(items, o.name)}</h2>
  <ul class="attack-list">${items
    .slice(0, 8)
    .map(
      (a) =>
        html`<li class="${a.state}">${attackLine(a)}${
          o.projectId && a.resource_id !== o.current
            ? html` <a href="${attackTabUrl("", o.projectId, a)}">Open ${a.service === "analytics" ? "analytics" : "tags"}</a>`
            : ""
        }</li>`,
    )}</ul>
  <p class="small">${
    active
      ? "What was set aside is kept for 7 days for review, out of your reports and the daily budget. These measures end by themselves an hour after the last sign of it."
      : "What was set aside stays out of your reports. Your agent can still review it and release what's real."
  }</p>
  ${askLine(o.prompt, "Ask your agent")}
</section>`;
}

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
 * exist, which inboxes it uses, where replay records. No numbers here: with `projectId`, each site
 * links to its analytics dashboard (analytics-dashboard.ts); the rest is for the owner's agent to
 * fetch, or to build into a dashboard of their own (dashboard-prompt.ts). With `asks`, empty tiles
 * suggest what to ask the agent.
 */
export function resourcesView(r: Resources, opts: { asks?: boolean; projectId?: string } = {}): SafeHtml {
  const tile = <T>(
    svc: keyof typeof SERVICES,
    list: T[] | null,
    line: (x: T) => { main: string; id: string; note?: string; href?: string },
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
            return html`<li>${l.href ? html`<a class="item-link" href="${l.href}"><b>${l.main}</b></a>` : html`<b>${l.main}</b>`}${l.note ? html`<span class="item-note">${l.note}</span>` : ""}<code>${l.id}</code></li>`;
          })}</ul>`
        : empty
  }
</section>`;
  };
  const none = (what: string, ask: string) =>
    html`<p class="muted small">No ${what} yet.</p>${opts.asks ? askLine(ask, "Ask your agent") : ""}`;
  return html`<div class="bento resources">
  ${tile(
    "analytics",
    r.sites,
    (s) => ({
      main: s.domain,
      id: s.id,
      href: opts.projectId ? `/dashboard/projects/${opts.projectId}/analytics/${s.id}` : undefined,
    }),
    none("sites", "Add analytics to my website."),
  )}
  ${tile(
    "tags",
    r.containers,
    (t) => ({ main: t.domain, id: t.id, href: opts.projectId ? `/dashboard/projects/${opts.projectId}/tags/${t.id}` : undefined }),
    none("tag containers", "Track sign-ups as Meta and Google Ads conversions."),
  )}
  ${tile(
    "mail",
    r.inboxes,
    (i) => ({ main: i.address, id: i.id, href: opts.projectId ? `/dashboard/projects/${opts.projectId}/mail/${i.id}` : undefined }),
    none("inboxes", "Create an inbox for our sign-up emails."),
  )}
  ${tile(
    "replay",
    r.replaySites,
    (s) => ({
      main: s.domain,
      id: s.id,
      note: s.enabled === false ? "paused" : undefined,
      href: opts.projectId ? `/dashboard/projects/${opts.projectId}/replay/${s.id}` : undefined,
    }),
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

/**
 * The setup check (src/setup-check.ts) for the owner: one row per part of the setup with a check
 * mark, what's there, and what's left; the prompt that has their agent finish it. Fixes are API
 * calls, so they're left to the agent: the owner sees what and why.
 */
export function setupView(r: SetupReport, finishPrompt: string, news?: { never: boolean; labels: string[]; prompt: string }): SafeHtml {
  const todo = r.counts.missing + r.counts.failing + r.counts.unavailable;
  const multi = new Set(r.rows.map((x) => x.domain).filter(Boolean)).size > 1;
  return html`<section class="tile setup-check" aria-labelledby="setup-title">
  <div class="tile-head"><h2 id="setup-title">What's set up</h2><span class="tile-count"><b>${r.checks.length - todo}</b> of ${r.checks.length} checks pass</span></div>
  <p class="setup-summary">${
    r.ready
      ? "Everything in the full setup is in place."
      : `${plural(todo, "thing", "things")} to finish for the full setup (analytics, tags, email and replay). Your agent can do ${todo === 1 ? "it" : "them"}: open it in the project's folder and paste the prompt below.`
  }</p>
  ${news && (news.never || news.labels.length) ? newsView(news) : ""}
  <div class="table-wrap"><table class="setup-table">
    <thead><tr><th scope="col">Status</th><th scope="col">Part</th><th scope="col">What's set up</th></tr></thead>
    <tbody>${r.rows.map(
      (row) =>
        html`<tr class="is-${row.status}"><td class="row-status"><span class="mark" aria-hidden="true">${STATUS_MARK[row.status]}</span> ${STATUS_WORD[row.status]}</td><th scope="row">${row.part}${
          multi && row.domain ? html` <span class="check-domain">${row.domain}</span>` : ""
        }</th><td class="row-details">${row.details}</td></tr>`,
    )}</tbody>
  </table></div>
  ${r.ready ? "" : askLine(finishPrompt, null)}
</section>`;
}

/** New setup items the project's agent hasn't seen (src/setup-catalog.ts), with what to ask it. */
function newsView(news: { never: boolean; labels: string[]; prompt: string }): SafeHtml {
  return html`<div class="setup-news" role="note">
    <p><b>${news.never ? "Your agent hasn't run the setup check on this project yet." : "New since your agent last checked this project:"}</b>${
      news.labels.length ? html` ${news.never ? "New in AgentFirstStack: " : ""}${news.labels.join("; ")}.` : ""
    }</p>
    ${askLine(news.prompt, "Ask your agent")}
  </div>`;
}

const HOURS = Array.from({ length: 24 }, (_, h) => h);

/**
 * Where each inbox's email goes once the agent stops reading it: each email as it arrives, one
 * daily digest, or nowhere. The owner changes it here (same as PATCH /v1/inboxes/:id {forward}).
 */
export function forwardView(projectId: string, inboxes: InboxItem[] | null, opts: { owner: boolean; csrf: SafeHtml }): SafeHtml {
  const withSetting = (inboxes ?? []).filter((i) => i.forward);
  if (!withSetting.length) return html``;
  return html`<section class="tile forward-tile" id="forwarding" aria-labelledby="forward-title">
  <div class="tile-head"><h2 id="forward-title">Email from your inbox</h2></div>
  <p class="muted small">Your agent uses ${withSetting.length === 1 ? "this inbox" : "these inboxes"} for sign-ups and codes. Its email comes to everyone on this project, as each one arrives or as one daily digest.</p>
  ${withSetting.map((i) => {
    const f = i.forward!;
    const state =
      f.mode === "off"
        ? "Not forwarded: nobody gets this mail once your agent stops."
        : f.mode === "each"
          ? "Each email is forwarded as it arrives."
          : `One digest a day at ${String(f.digest_hour).padStart(2, "0")}:00 (${f.timezone}).`;
    return opts.owner
      ? html`<form class="forward-form" method="post" action="/dashboard/projects/${projectId}/inboxes/${i.id}/forward">
    ${opts.csrf}
    <p><b>${i.address}</b> <span class="muted small">${state}</span></p>
    <div class="inline-fields">
      <label class="field"><span>Send me</span><select name="mode">
        <option value="each"${f.mode === "each" ? html` selected` : ""}>Each email as it arrives</option>
        <option value="digest"${f.mode === "digest" ? html` selected` : ""}>A daily digest</option>
        <option value="off"${f.mode === "off" ? html` selected` : ""}>Nothing</option>
      </select></label>
      <label class="field"><span>Digest at</span><select name="digest_hour">${HOURS.map(
        (h) => html`<option value="${String(h)}"${h === f.digest_hour ? html` selected` : ""}>${String(h).padStart(2, "0")}:00</option>`,
      )}</select></label>
      <label class="field"><span>Time zone</span><input type="text" name="timezone" value="${f.timezone}" maxlength="64" placeholder="Europe/Berlin" autocomplete="off"></label>
      <button class="btn btn-quiet" type="submit">Save</button>
    </div>
  </form>`
      : html`<p><b>${i.address}</b> <span class="muted small">${state} Only the project's owner can change it.</span></p>`;
  })}
</section>`;
}
