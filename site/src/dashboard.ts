import { ApiError, assertCanCreateKey, cleanName, createApiKey } from "@afs/shared";
import { type Context, Hono } from "hono";
import { type OpenLink, createClaimLink, listOpenLinks, revokeOpenLink } from "./claims";
import type { SiteEnv } from "./env";
import { siteBase } from "./google";
import { dashPage, projectHeader, projectId, projectName } from "./dashboard-frame";
import { csrfField, fmtDate, fmtDay, html, htmlErrorHandler, page } from "./html";
import {
  type DeletedProject,
  type Project,
  deleteUser,
  listDeletedProjects,
  listMembers,
  listProjects,
  projectNotFound,
  removeMember,
  requireProject,
  revokeGrant,
} from "./identity";
import { RESTORE_DAYS, cleanupPrompt, deleteProject, exportPrompt, restoreProject } from "./project-deletion";
import { recentEmails, waitUntilOf } from "./email";
import {
  emailAccountDeleted,
  emailMemberRemoved,
  emailProjectDeleted,
  emailProjectRestored,
  attackPrompt,
  limitLine,
  limitsPrompt,
} from "./email-messages";
import { type LimitHit, attackItems, limitHits, projectUsage } from "./project-health";
import { analyticsDashboard } from "./analytics-dashboard";
import { serviceViews } from "./service-views";
import { type BuildKind, buildPrompt, finishPrompt } from "./dashboard-prompt";
import { callService, projectResources } from "./services";
import { readSetupState } from "./notices";
import { itemsAfter } from "./setup-catalog";
import { setupReport } from "./setup-check";
import { clearSessionCookie, readForm, redirect, requireSession } from "./session";
import { askLine, askText, attacksView, forwardView, plural, resourceCounts, resourcesView, setupView } from "./views";

/**
 * /dashboard: server-rendered pages for signed-in people. Every project route goes through
 * requireProject(), so a user only ever sees projects they're a member of (others are a 404).
 * Every form is a POST with a CSRF token; pages send frame-ancestors 'none' (see html.ts).
 */

export const dashboard = new Hono<SiteEnv>();
dashboard.use("*", requireSession);

dashboard.onError(htmlErrorHandler);

/**
 * Keys and invites are access to the project, so only its owner hands them out or takes them
 * back. Members see the lists.
 */
function requireOwner(p: Project, what: string) {
  if (p.role === "owner") return;
  throw new ApiError(
    403,
    "forbidden",
    `Only the project's owner can ${what}.`,
    "Ask the owner. If the project has no owner, ask your agent for a claim link: claiming it makes you the owner.",
  );
}

const notice = (msg: string | undefined, kind: "error" | "ok" = "error") =>
  msg ? html`<p class="notice ${kind === "ok" ? "notice-ok" : "notice-error"}" role="status">${msg}</p>` : "";

/**
 * What starts a new project: the agent reads the manual and does the rest. Short on purpose; the
 * manual (llms.txt) has every step, and the landing page's longer prompt says the same.
 */
const SETUP_PROMPT =
  "Set up AgentFirstStack for this project, completely, and verify it yourself. First look at what the site uses today (Google Analytics, Tag Manager, Plausible, DataFast, ad pixels, any replay tool) without changing anything, then ask me once and wait for my answer: should the project's inbox email be forwarded to me as each one arrives, or as one daily digest (at what time, in my time zone)? And if you found other tools, shall you bring their setup and history over, using my browser where I'm signed in if you need to export it? If I can't answer, forward each one and bring over whatever needs no help from me. Then read https://agentfirststack.com/llms.txt and the Acceptable Use Policy (https://agentfirststack.com/acceptable-use), and follow the manual's Full setup section from start to finish: if this project's .env already has AGENTFIRSTSTACK_API_KEY, use it (and read AGENTFIRSTSTACK.md); otherwise get this project its own key. Map the site's main pages, buttons, links, forms and conversions, then set up an inbox, analytics (goals, server events, AI crawler reporting if the site has a server, payments if the business takes them, a weekly report and alerts), tags (an event for every main action, the conversions) and replay (linked, masked, consent where the law requires it), deploy, then test it end to end: the setup test (POST https://agentfirststack.com/v1/setup/test), its browser plan in a real browser, and the setup check (GET https://agentfirststack.com/v1/setup) until it says ready. Apart from that message, don't stop to ask me; list what only I can give (ad platform IDs and tokens) at the end. Note what you set up in AGENTFIRSTSTACK.md at the repo root (ids and env var names, never key values), add the manual's AgentFirstStack block to AGENTS.md, and commit both. Show me the tables of what's set up and what passed, say what you brought over from other tools (leave them installed until I agree to remove them), and send me a claim link for the project.";

/** The screens an agent can build for a project, one prompt each (see dashboard-prompt.ts). */
const BUILDS: { kind: BuildKind; title: string; what: string }[] = [
  { kind: "analytics", title: "Analytics dashboard", what: "Traffic, sources, revenue and funnels, with period comparisons." },
  {
    kind: "tags",
    title: "Conversion tracking",
    what: "Delivery health per ad platform, what's live, and safe edits with preview, publish and rollback.",
  },
  { kind: "mail", title: "Inboxes", what: "A small mail client: read, search, reply, with codes and links pulled out." },
  {
    kind: "replay",
    title: "Session review",
    what: "The most frustrated sessions first, readable transcripts, JS errors and heatmaps, with a Watch button.",
  },
];

/** Things people ask their agent instead of opening this dashboard, and the service that answers. */
const ASKS: { text: string; svc: "analytics" | "tags" | "mail" | "projects"; label: string }[] = [
  { text: "How many visitors did my site get this week, and from which countries?", svc: "analytics", label: "Analytics" },
  { text: "Did any Meta conversions fail yesterday?", svc: "tags", label: "Tags" },
  { text: "What's the latest email in my signups inbox?", svc: "mail", label: "Mail" },
  { text: "Make an invite link so my teammate can see this project.", svc: "projects", label: "Projects" },
];

// ---------- projects ----------

/** Projects page: the owner's deleted projects, restorable until their purge. */
function deletedView(deleted: DeletedProject[], csrf: ReturnType<typeof csrfField>, justDeleted?: string) {
  return html`<section class="deleted-projects" aria-labelledby="deleted-title">
  <div class="section-head"><h2 id="deleted-title">Deleted projects</h2><p class="muted small">Restore one before its data is erased.</p></div>
  <ul class="deleted-list">${deleted.map(
    (d) => html`<li class="tile deleted-item">
    <div class="deleted-copy">
      <h3>${projectName(d)}</h3>
      <p class="muted small">Deleted ${fmtDate(d.deleted_at)}. Its data is erased on ${fmtDate(d.purge_after)}.</p>
    </div>
    <form method="post" action="/dashboard/projects/${d.id}/restore">${csrf}<button class="btn btn-quiet" type="submit">Restore</button></form>
    ${
      d.id === justDeleted
        ? html`<div class="deleted-cleanup">${askLine(cleanupPrompt(projectName(d)), "Now take it out of the site's code. Ask your agent")}</div>`
        : html`<details class="deleted-cleanup"><summary class="small">Take it out of the site's code</summary>${askLine(cleanupPrompt(projectName(d)), null)}</details>`
    }
  </li>`,
  )}</ul>
</section>`;
}

async function projectsPage(c: Context<SiteEnv>) {
  const s = c.var.session;
  const [projects, deleted] = await Promise.all([listProjects(c.env.DB, s.user.id), listDeletedProjects(c.env.DB, s.user.id)]);
  const justDeleted = deleted.find((d) => d.id === c.req.query("deleted"));
  // Resources for the first 20 projects (each is four service calls); the cards' numbers and
  // charts are filled in by /dashboard-app.js from the analytics API.
  const shown = projects.slice(0, 20);
  const resources = await Promise.all(shown.map((p) => projectResources(c.env, p.id)));
  const card = (p: Project, i: number) => {
    const r = resources[i];
    return html`<li><a class="afa-card pcard" href="/dashboard/projects/${p.id}" data-pcard="${p.id}" data-sites="${JSON.stringify(
      (r?.sites ?? []).map((x) => x.id),
    )}">
      <span class="pcard-top">
        <span class="afa-favicon" aria-hidden="true">${projectName(p).charAt(0).toUpperCase()}</span>
        <span class="pcard-name">${projectName(p)}</span>
        <span class="role">${p.role}</span>
      </span>
      <span class="pcard-spark" aria-hidden="true"></span>
      <span class="pcard-stat">${r?.sites?.length ? html`<b data-visitors>–</b> visitors in the last 30 days` : html`<span class="muted">No analytics yet</span>`}</span>
      <span class="pcard-foot">${r ? resourceCounts(r) : html`<span class="muted small">Couldn't load what's set up.</span>`}</span>
    </a></li>`;
  };
  return dashPage(c, {
    title: "Projects",
    nav: "projects",
    scripts: ["/dashboard-app.js"],
    styles: ["/dashboard-app.css"],
    body: html`${justDeleted ? notice(`${projectName(justDeleted)} is deleted. You can restore it until ${fmtDate(justDeleted.purge_after)}; then its data is erased.`, "ok") : ""}<div class="page-head home-head">
  <div>
    <h1>Projects</h1>
    <p class="lead">${
      projects.length
        ? `${plural(projects.length, "project", "projects")} your agents set up. Open one for its analytics, tags, replay and mail.`
        : "When your agent sets AgentFirstStack up, it sends you a claim link. Open it and the project shows up here."
    }</p>
  </div>
  <details class="newproj">
    <summary class="btn btn-primary">Set up a new project</summary>
    <section class="tile add newproj-panel" aria-label="Set up a new project">
      <p class="muted small">Open your agent in the new project's folder and paste this. It gets the project its own key, sets up what it needs, checks each step, and sends you a claim link that adds it here.</p>
      ${askLine(SETUP_PROMPT, null)}
      <p class="muted small add-also">Already set up by an agent? Ask it:</p>
      ${askLine("Send me a claim link for our AgentFirstStack project.", null)}
    </section>
  </details>
</div>
<div class="afa" id="afa" data-view="home">
${
  projects.length
    ? html`<ul class="pcards">${shown.map(card)}</ul>${
        projects.length > shown.length ? html`<p class="fine">Showing the first ${shown.length} of ${projects.length} projects.</p>` : ""
      }`
    : html`<div class="tile empty">
  <h3>No projects yet</h3>
  <p>When your agent has set something up, ask it for a claim link and open it: the project shows up here.</p>
  <p class="muted small">Agents create claim links with <code>POST /v1/claim-link</code> or the <code>afs_create_claim_link</code> tool.</p>
</div>`
}
</div>
${deleted.length ? deletedView(deleted, csrfField(s), justDeleted?.id) : ""}
<section class="tile hero home-asks" aria-labelledby="asks-title">
  <div class="hero-copy">
    <h2 id="asks-title">Or just ask your agent.</h2>
    <p>Everything here, your agent can read back to you, in plain words.</p>
  </div>
  <ul class="asks">${ASKS.map(
    (a) =>
      html`<li class="ask ask-${a.svc}">${askText(a.text)}<span class="ask-tag"><span class="swatch" aria-hidden="true"></span>${a.label}</span></li>`,
  )}</ul>
  <p class="hero-hint" data-js-text="Copy a question, then paste it into your agent.">Click a question to select it, then copy it into your agent.</p>
</section>`,
  });
}

dashboard.get("/", (c) => projectsPage(c));
dashboard.route("/", analyticsDashboard);
dashboard.route("/", serviceViews);

dashboard.get("/projects/:id", async (c) => {
  const s = c.var.session;
  const p = await requireProject(c.env.DB, s.user.id, projectId(c));
  const resources = await projectResources(c.env, p.id);
  const [setup, setupState, usage] = await Promise.all([
    // Rate-limited or failed: the page still renders, without the tile.
    setupReport(c.env, p.id, { base: siteBase(c), resources }).catch(() => null),
    readSetupState(c.env.DB, p.id),
    projectUsage(c.env, p.id).catch(() => null),
  ]);
  const limits = usage ? limitHits(usage) : [];
  const attacks = usage ? attackItems(usage) : [];
  const project = { id: p.id, name: projectName(p) };
  const ids = {
    sites: (resources.sites ?? []).map((x) => x.id),
    containers: (resources.containers ?? []).map((x) => x.id),
    inboxes: (resources.inboxes ?? []).map((x) => x.id),
    replay: (resources.replaySites ?? []).map((x) => x.id),
  };
  return dashPage(c, {
    title: projectName(p),
    project: p,
    tab: "overview",
    scripts: ["/dashboard-app.js"],
    styles: ["/dashboard-app.css"],
    body: html`${projectHeader(p, "overview")}
${
  attacks.length
    ? html`<div class="bento attack-bento">${attacksView(attacks, {
        name: projectName(p),
        prompt: attackPrompt(siteBase(c), projectName(p), attacks),
        projectId: p.id,
      })}</div>`
    : ""
}
<div class="afa afa-week" id="afa" data-view="project-overview" data-project="${p.id}" data-ids="${JSON.stringify(ids)}"></div>
${limits.length ? html`<div class="bento">${limitsView(limits, limitsPrompt(siteBase(c), projectName(p), limits))}</div>` : ""}
${
  setup
    ? html`<div class="bento">${setupView(setup, finishPrompt(siteBase(c)), {
        never: !setupState,
        labels: itemsAfter(setupState?.catalog_version ?? 0).map((i) => i.label),
        prompt: `Run the AgentFirstStack setup check (GET ${siteBase(c)}/v1/setup) and apply what it lists.`,
      })}</div>`
    : ""
}
${(resources.inboxes ?? []).some((i) => i.forward) ? html`<div class="bento">${forwardView(p.id, resources.inboxes, { owner: p.role === "owner", csrf: csrfField(s) })}</div>` : ""}
${resourcesView(resources, { asks: true, projectId: p.id })}
<div class="bento">
<section class="tile build-own" aria-labelledby="build-title">
  <div class="build-copy">
    <h2 id="build-title">Want these screens in your own app? Have your agent build them.</h2>
    <p>Paste one of these into Claude, Cursor or any coding agent. It builds the screen from the API inside your app, already pointed at this project.</p>
  </div>
  <ul class="builds">${BUILDS.map(
    (b) => html`<li class="build svc-${b.kind}">
    <h3><span class="swatch" aria-hidden="true"></span>${b.title}</h3>
    <p>${b.what}</p>
    <details><summary>See the prompt</summary><pre class="prompt-block select">${buildPrompt(b.kind, project, resources, siteBase(c))}</pre></details>
  </li>`,
  )}</ul>
</section>
</div>`,
  });
});

/** The caps the project is at 80% of or past (the same lines as the limit warning email). */
function limitsView(hits: LimitHit[], prompt: string) {
  const reached = hits.some((h) => h.level === "reached");
  return html`<section class="tile limits-tile" id="limits" aria-labelledby="limits-title">
  <h2 id="limits-title">${reached ? "This project reached a fair-use limit" : "This project is close to a fair-use limit"}</h2>
  <ul class="limit-list">${hits.slice(0, 12).map((h) => html`<li class="${h.level}">${limitLine(h)}</li>`)}</ul>
  <p class="small">${hits.some((h) => h.resets_at !== null) ? "Daily limits reset at 00:00 UTC. " : ""}Your agent can see what's using ${hits.length === 1 ? "it" : "them"} up and cut what isn't needed.</p>
  ${askLine(prompt, "Ask your agent")}
</section>`;
}

// Settings: General (rename, the project's facts); API keys and Members are their own pages.
dashboard.get("/projects/:id/settings", async (c) => {
  const s = c.var.session;
  const p = await requireProject(c.env.DB, s.user.id, projectId(c));
  const [keys, members] = await Promise.all([
    c.env.DB.prepare("SELECT count(*) AS n FROM api_keys WHERE account_id = ? AND revoked_at IS NULL AND oauth_grant_id IS NULL")
      .bind(p.id)
      .first<number>("n"),
    c.env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE account_id = ?").bind(p.id).first<number>("n"),
  ]);
  return dashPage(c, {
    title: `Settings · ${projectName(p)}`,
    project: p,
    tab: "settings",
    settingsTab: "general",
    body: html`${projectHeader(p, "settings", "general")}
<div class="bento project-more">
  <form class="tile stack rename" method="post" action="/dashboard/projects/${p.id}/rename">
    <h2>Project name</h2>
    ${csrfField(s)}
    <div class="inline-fields">
      <label class="field"><span>Name</span><input type="text" name="name" maxlength="200" value="${p.name ?? ""}" placeholder="acme.com"></label>
      <button class="btn btn-quiet" type="submit">Save</button>
    </div>
    ${askLine("Rename our AgentFirstStack project.", "Or ask your agent")}
  </form>
  <section class="tile account">
    <h2>About this project</h2>
    <dl class="facts">
      <div><dt>Project id</dt><dd><code>${p.id}</code></dd></div>
      <div><dt>Your role</dt><dd>${p.role === "owner" ? "Owner" : "Member"}</dd></div>
      <div><dt>Created</dt><dd>${fmtDate(p.created_at)}</dd></div>
      <div><dt>You joined</dt><dd>${fmtDate(p.joined_at)}</dd></div>
    </dl>
  </section>
  <a class="tile stat-tile" href="/dashboard/projects/${p.id}/keys">
    <span class="stat-num">${keys ?? 0}</span>
    <span class="stat-label">${keys === 1 ? "active API key" : "active API keys"}</span>
    <span class="stat-go">Manage keys</span>
  </a>
  <a class="tile stat-tile" href="/dashboard/projects/${p.id}/members">
    <span class="stat-num">${members ?? 0}</span>
    <span class="stat-label">${members === 1 ? "person can see this" : "people can see this"}</span>
    <span class="stat-go">Members and invites</span>
  </a>
  ${p.role === "owner" ? deleteTile(p, csrfField(s)) : ""}
</div>`,
  });
});

/** Settings, General: deleting the project (its owner only). */
function deleteTile(p: Project, csrf: ReturnType<typeof csrfField>) {
  const name = projectName(p);
  return html`<form class="tile stack danger-zone delete-project" method="post" action="/dashboard/projects/${p.id}/delete">
  <h2>Delete project</h2>
  <p class="small">Every key, connected app and invite link stops at once, and so do the project's tracking, recording and inbound mail. Its members lose access. For ${RESTORE_DAYS} days you can restore it from your projects page; after that its analytics, tags, recordings and mail are erased. Inbox addresses that received mail stay reserved for good, so nobody else can receive this project's email.</p>
  ${askLine(exportPrompt(name), "First, to keep a copy, ask your agent")}
  ${csrf}
  <label class="field"><span>Type <b>${name}</b> to confirm</span><input type="text" name="confirm" required autocomplete="off" spellcheck="false"></label>
  <p class="row"><button class="btn btn-danger" type="submit">Delete project</button></p>
</form>`;
}

dashboard.post("/projects/:id/delete", async (c) => {
  const form = await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  requireOwner(p, "delete it");
  if ((form.confirm ?? "").trim() !== projectName(p))
    throw new ApiError(400, "not_confirmed", "The project was not deleted.", `Type its name, ${projectName(p)}, in the box to confirm.`);
  const d = await deleteProject(c.env, p.id, c.var.session.user.id);
  if (!d.existing)
    await emailProjectDeleted(c.env, siteBase(c), waitUntilOf(c), {
      accountId: p.id,
      name: p.name,
      byUserId: c.var.session.user.id,
      deletedAt: d.deleted_at,
      purgeAfter: d.purge_after,
    });
  return redirect(`/dashboard?deleted=${p.id}`);
});

dashboard.post("/projects/:id/restore", async (c) => {
  await readForm(c);
  const id = projectId(c);
  const mine = (await listDeletedProjects(c.env.DB, c.var.session.user.id)).find((d) => d.id === id);
  if (!mine) throw projectNotFound();
  const r = await restoreProject(c.env, id);
  if (r.restored)
    await emailProjectRestored(c.env, siteBase(c), waitUntilOf(c), {
      accountId: id,
      name: mine.name,
      byUserId: c.var.session.user.id,
      deletedAt: mine.deleted_at,
    });
  return redirect(`/dashboard/projects/${id}`);
});

// Where an inbox's email goes (the mail service's PATCH /v1/inboxes/:id {forward}, as this project).
dashboard.post("/projects/:id/inboxes/:inbox/forward", async (c) => {
  const form = await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  requireOwner(p, "change where the inbox's email goes");
  const inbox = c.req.param("inbox");
  if (!/^inb_[0-9a-z]{4,40}$/.test(inbox)) throw new ApiError(404, "not_found", "No such inbox in this project.");
  const mode = form.mode === "each" || form.mode === "digest" || form.mode === "off" ? form.mode : null;
  const hour = Number(form.digest_hour);
  if (!mode || !Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new ApiError(
      400,
      "bad_request",
      "Choose what to send and a digest hour.",
      "Each email, a daily digest, or nothing; the hour is 00-23.",
    );
  const timezone =
    String(form.timezone ?? "")
      .trim()
      .slice(0, 64) || "UTC";
  const res = await callService<{ error?: { message?: string; hint?: string } }>(c.env, "mail", p.id, `/v1/inboxes/${inbox}`, {
    method: "PATCH",
    body: { forward: { mode, digest_hour: hour, timezone } },
  });
  if (!res.ok)
    throw new ApiError(
      res.status === 404 ? 404 : res.status < 500 ? 400 : 502,
      "forward_not_saved",
      res.json?.error?.message ?? "The mail service didn't save it.",
      res.json?.error?.hint ?? "Try again in a minute.",
    );
  return redirect(`/dashboard/projects/${p.id}`);
});

dashboard.post("/projects/:id/rename", async (c) => {
  const form = await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  await c.env.DB.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(cleanName(form.name, 200), p.id).run();
  return redirect(`/dashboard/projects/${p.id}/settings`);
});

// ---------- keys ----------

interface KeyRow {
  id: string;
  name: string | null;
  prefix: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  created_by_email: string | null;
}

interface KeysPageExtra {
  created?: { key: string; name: string | null; scopes: string };
  error?: { message: string; status: number };
}

async function keysPage(c: Context<SiteEnv>, p: Project, extra: KeysPageExtra = {}) {
  const s = c.var.session;
  const { created } = extra;
  const owner = p.role === "owner";
  // OAuth access tokens are listed as connected apps, not here. Keys without a person behind them
  // came from the API: the signup, or an agent's POST /v1/keys.
  const { results: keys } = await c.env.DB.prepare(
    `SELECT k.id, k.name, k.prefix, k.scopes, k.created_at, k.last_used_at, u.email AS created_by_email
       FROM api_keys k LEFT JOIN users u ON u.id = k.created_by_user_id
      WHERE k.account_id = ? AND k.revoked_at IS NULL AND k.oauth_grant_id IS NULL ORDER BY k.created_at`,
  )
    .bind(p.id)
    .all<KeyRow>();
  const createdBy = (k: KeyRow) => (k.created_by_email ? k.created_by_email : html`<span class="muted">An agent (API)</span>`);
  const access = (scopes: string) =>
    scopes === "*" ? html`<span class="tag tag-full">Full access</span>` : html`<span class="tag">Read only</span>`;
  return dashPage(c, {
    title: `API keys · ${projectName(p)}`,
    project: p,
    tab: "settings",
    settingsTab: "keys",
    status: created ? 201 : (extra.error?.status ?? 200),
    body: html`${projectHeader(p, "settings", "keys")}
${notice(extra.error?.message)}
<div class="bento">
${
  created
    ? html`<section class="tile secret-tile" role="status">
  <h2>New key${created.name ? html`: ${created.name}` : ""}</h2>
  <p>Copy it now. It isn't shown again.</p>
  <pre class="secret">${created.key}</pre>
  <p class="secret-note">${created.scopes === "*" ? "Full access" : "Read only"}. Send it as <code>Authorization: Bearer &lt;key&gt;</code> to any AgentFirstStack service.</p>
</section>`
    : ""
}
<section class="tile tile-flush">
  <div class="tile-head">
    <h2>API keys</h2>
    <p class="tile-count"><b>${keys.length}</b> active</p>
  </div>
  ${
    keys.length
      ? html`<table class="table">
    <thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Access</th><th scope="col">Created by</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Revoke</span></th></tr></thead>
    <tbody>${keys.map(
      (k) => html`<tr>
      <td data-label="Name"><b>${k.name || "unnamed"}</b></td><td data-label="Key"><code>${k.prefix}…</code></td><td data-label="Access">${access(k.scopes)}</td>
      <td data-label="Created by">${createdBy(k)}</td>
      <td data-label="Created">${fmtDate(k.created_at)}</td><td data-label="Last used">${fmtDate(k.last_used_at)}</td>
      <td class="cell-action">${
        owner
          ? html`<form method="post" action="/dashboard/projects/${p.id}/keys/${k.id}/revoke">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">Revoke</button></form>`
          : ""
      }</td>
    </tr>`,
    )}</tbody>
  </table>`
      : html`<p class="tile-body muted">No active keys.</p>`
  }
  <p class="tile-foot">Revoking a key stops it at once, including for any agent that uses it. Keys someone created here are revoked when they leave the project. Chat apps you connected are under <a href="/dashboard/apps">Connected apps</a>.</p>
</section>
${
  owner
    ? html`<form class="tile stack create-key" method="post" action="/dashboard/projects/${p.id}/keys">
  <h2>Create a key</h2>
  ${csrfField(s)}
  <div class="inline-fields">
    <label class="field"><span>Name</span><input type="text" name="name" maxlength="100" placeholder="ci"></label>
    <label class="field field-narrow"><span>Access</span><select name="scope"><option value="*">Full access</option><option value="read">Read only</option></select></label>
    <button class="btn btn-primary" type="submit">Create key</button>
  </div>
  ${askLine("Create a read-only AgentFirstStack key for our CI.", "Or ask your agent")}
</form>`
    : html`<section class="tile stack create-key">
  <h2>Create a key</h2>
  <p class="muted small">Only the project's owner can create and revoke keys here.</p>
  ${askLine("Create a read-only AgentFirstStack key for our CI.", "Or ask your agent")}
</section>`
}
</div>`,
  });
}

dashboard.get("/projects/:id/keys", async (c) => {
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  return keysPage(c, p);
});

dashboard.post("/projects/:id/keys", async (c) => {
  const form = await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  requireOwner(p, "create keys");
  const scope = form.scope === "read" ? "read" : "*";
  const name = cleanName(form.name, 100);
  // The same per-account cap and rate limits as POST /v1/keys.
  try {
    await assertCanCreateKey(c.env, p.id);
  } catch (e) {
    if (e instanceof ApiError)
      return keysPage(c, p, { error: { message: [e.message, e.hint].filter(Boolean).join(" "), status: e.status } });
    throw e;
  }
  const k = await createApiKey(c.env.DB, p.id, {
    keyPrefix: c.env.KEY_PREFIX || "afs",
    name,
    scope,
    createdByUserId: c.var.session.user.id,
  });
  return keysPage(c, p, { created: { key: k.key, name, scopes: k.scopes } });
});

dashboard.post("/projects/:id/keys/:key/revoke", async (c) => {
  await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  requireOwner(p, "revoke keys");
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), c.req.param("key"), p.id)
    .run();
  return redirect(`/dashboard/projects/${p.id}/keys`);
});

// ---------- members ----------

async function membersPage(c: Context<SiteEnv>, p: Project, invite?: { url: string; expires_at: number }) {
  const s = c.var.session;
  const owner = p.role === "owner";
  const [members, links] = await Promise.all([listMembers(c.env.DB, p.id), owner ? listOpenLinks(c.env.DB, p.id) : Promise.resolve([])]);
  const madeBy = (l: OpenLink) =>
    l.created_by_email
      ? html`${l.created_by_email}`
      : l.created_by_key_prefix
        ? html`An agent (key <code>${l.created_by_key_prefix}…</code>)`
        : html`<span class="muted">Unknown</span>`;
  return dashPage(c, {
    title: `Members · ${projectName(p)}`,
    project: p,
    tab: "settings",
    settingsTab: "members",
    status: invite ? 201 : 200,
    body: html`${projectHeader(p, "settings", "members")}
<div class="bento">
${
  invite
    ? html`<section class="tile secret-tile" role="status">
  <h2>Invite link</h2>
  <p>Send this to your teammate. It works once and expires ${fmtDate(invite.expires_at)}.</p>
  <pre class="secret">${invite.url}</pre>
</section>`
    : ""
}
<section class="tile tile-flush members">
  <div class="tile-head">
    <h2>Members</h2>
    <p class="tile-count"><b>${members.length}</b> ${members.length === 1 ? "person" : "people"}</p>
  </div>
  <table class="table">
    <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span class="sr-only">Remove</span></th></tr></thead>
    <tbody>${members.map((m) => {
      const self = m.user_id === s.user.id;
      const canRemove = self || p.role === "owner";
      return html`<tr>
      <td data-label="Person"><span class="person">${m.name ? html`<b>${m.name}</b> <span class="muted">${m.email}</span>` : html`<b>${m.email}</b>`}${self ? html` <span class="tag">you</span>` : ""}</span></td>
      <td>${m.role}</td><td data-label="Joined">${fmtDate(m.created_at)}</td>
      <td class="cell-action">${
        canRemove
          ? html`<form method="post" action="/dashboard/projects/${p.id}/members/${m.user_id}/remove">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">${self ? "Leave" : "Remove"}</button></form>`
          : ""
      }</td>
    </tr>`;
    })}</tbody>
  </table>
  <p class="tile-foot">Removing someone (or leaving) disconnects the chat apps they connected to this project, revokes the API keys they created here and deletes their unused invite links.</p>
</section>
${
  owner
    ? html`<section class="tile tile-flush invites">
  <div class="tile-head">
    <h2>Open invite and claim links</h2>
    <p class="tile-count"><b>${links.length}</b> unused</p>
  </div>
  ${
    links.length
      ? html`<table class="table">
    <thead><tr><th scope="col">Created by</th><th scope="col">Created</th><th scope="col">Expires</th><th scope="col"><span class="sr-only">Revoke</span></th></tr></thead>
    <tbody>${links.map(
      (l) => html`<tr>
      <td data-label="Created by">${madeBy(l)}</td><td data-label="Created">${fmtDate(l.created_at)}</td><td data-label="Expires">${fmtDate(l.expires_at)}</td>
      <td class="cell-action"><form method="post" action="/dashboard/projects/${p.id}/invites/${l.ref}/revoke">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">Revoke</button></form></td>
    </tr>`,
    )}</tbody>
  </table>`
      : html`<p class="tile-body muted">No unused links.</p>`
  }
  <p class="tile-foot">Anyone who opens one of these and signs in joins the project. Revoke the ones you didn't mean to send.</p>
</section>
<form class="tile stack invite" method="post" action="/dashboard/projects/${p.id}/members/invite">
  <h2>Invite someone</h2>
  <p class="muted small">Creates a single-use link. Whoever opens it and signs in joins this project as a member.</p>
  ${csrfField(s)}
  <p class="row"><button class="btn btn-primary" type="submit">Create invite link</button></p>
</form>`
    : html`<section class="tile stack invite">
  <h2>Invite someone</h2>
  <p class="muted small">Only the project's owner can invite people.</p>
</section>`
}
</div>`,
  });
}

dashboard.get("/projects/:id/members", async (c) => {
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  return membersPage(c, p);
});

dashboard.post("/projects/:id/members/invite", async (c) => {
  await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  requireOwner(p, "invite people");
  const link = await createClaimLink(c.env.DB, siteBase(c), p.id, { userId: c.var.session.user.id });
  return membersPage(c, p, link);
});

dashboard.post("/projects/:id/invites/:ref/revoke", async (c) => {
  await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  requireOwner(p, "revoke invite links");
  if (!(await revokeOpenLink(c.env.DB, p.id, c.req.param("ref")))) {
    throw new ApiError(404, "not_found", "That link was already used, revoked or expired.");
  }
  return redirect(`/dashboard/projects/${p.id}/members`);
});

dashboard.post("/projects/:id/members/:user/remove", async (c) => {
  await readForm(c);
  const me = c.var.session.user.id;
  const p = await requireProject(c.env.DB, me, projectId(c));
  const target = c.req.param("user");
  if (target !== me && p.role !== "owner") throw new ApiError(403, "forbidden", "Only the project's owner can remove other members.");
  await removeMember(c.env.DB, p.id, target);
  if (target !== me)
    await emailMemberRemoved(c.env, siteBase(c), waitUntilOf(c), { accountId: p.id, name: p.name, userId: target, at: Date.now() });
  return redirect(target === me ? "/dashboard" : `/dashboard/projects/${p.id}/members`);
});

// ---------- connected apps (OAuth grants) ----------

interface GrantRow {
  id: string;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  client_name: string;
  redirect_uris: string;
  account_id: string;
  account_name: string | null;
}

export const redirectHosts = (json: string) => {
  try {
    return [...new Set((JSON.parse(json) as string[]).map((u) => new URL(u).host))].join(", ");
  } catch {
    return "";
  }
};

dashboard.get("/apps", async (c) => {
  const s = c.var.session;
  const { results: grants } = await c.env.DB.prepare(
    `SELECT g.id, g.scope, g.created_at, g.last_used_at, oc.name AS client_name, oc.redirect_uris, a.id AS account_id, a.name AS account_name
       FROM oauth_grants g JOIN oauth_clients oc ON oc.id = g.client_id JOIN accounts a ON a.id = g.account_id
      WHERE g.user_id = ? AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
  )
    .bind(s.user.id)
    .all<GrantRow>();
  return dashPage(c, {
    title: "Connected apps",
    nav: "apps",
    body: html`<div class="page-head">
  <h1>Connected apps</h1>
  <p class="lead">Chat apps and other tools you allowed to use a project over OAuth, such as Claude or ChatGPT connectors.</p>
</div>
<div class="bento">
<section class="tile tile-flush">
  <div class="tile-head">
    <h2>Apps</h2>
    <p class="tile-count"><b>${grants.length}</b> connected</p>
  </div>
  ${
    grants.length
      ? html`<table class="table">
    <thead><tr><th scope="col">App</th><th scope="col">Sends you back to</th><th scope="col">Project</th><th scope="col">Access</th><th scope="col">Connected</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Disconnect</span></th></tr></thead>
    <tbody>${grants.map(
      (g) => html`<tr>
      <td data-label="App"><b>${g.client_name}</b></td><td data-label="Sends you back to"><code>${redirectHosts(g.redirect_uris)}</code></td>
      <td data-label="Project"><a href="/dashboard/projects/${g.account_id}">${g.account_name || g.account_id}</a></td>
      <td data-label="Access">${g.scope === "*" ? html`<span class="tag tag-full">Full access</span>` : html`<span class="tag">Read only</span>`}</td><td data-label="Connected">${fmtDate(g.created_at)}</td><td data-label="Last used">${fmtDate(g.last_used_at)}</td>
      <td class="cell-action"><form method="post" action="/dashboard/apps/${g.id}/revoke">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">Disconnect</button></form></td>
    </tr>`,
    )}</tbody>
  </table>`
      : html`<div class="tile-body">
    <p>No connected apps. To connect one, add this URL as a custom connector in Claude or ChatGPT:</p>
    <p class="url-chip"><code class="select">${siteBase(c)}/mcp</code></p>
  </div>`
  }
</section>
</div>`,
  });
});

dashboard.post("/apps/:grant/revoke", async (c) => {
  await readForm(c);
  const grant = await c.env.DB.prepare("SELECT id FROM oauth_grants WHERE id = ? AND user_id = ?")
    .bind(c.req.param("grant"), c.var.session.user.id)
    .first<{ id: string }>();
  if (!grant) throw new ApiError(404, "not_found", "Connected app not found.");
  await revokeGrant(c.env.DB, grant.id);
  return redirect("/dashboard/apps");
});

// ---------- account ----------

dashboard.get("/account", async (c) => {
  const s = c.var.session;
  const [prefs, emails] = await Promise.all([
    c.env.DB.prepare("SELECT email_updates, email_alerts FROM users WHERE id = ?")
      .bind(s.user.id)
      .first<{ email_updates: number; email_alerts: number }>(),
    recentEmails(c.env.DB, s.user.id),
  ]);
  const saved = c.req.query("emails") === "saved";
  return dashPage(c, {
    title: "Account",
    nav: "account",
    body: html`<div class="page-head"><h1>Account</h1></div>
<div class="bento">
<section class="tile account">
  <h2>Your sign-in</h2>
  <dl class="facts">
    <div><dt>Name</dt><dd>${s.user.name ?? "not set"}</dd></div>
    <div><dt>Email</dt><dd>${s.user.email}</dd></div>
    <div><dt>Signed up</dt><dd>${fmtDate(s.user.created_at)}</dd></div>
  </dl>
  <form method="post" action="/auth/signout" class="row">${csrfField(s)}<button class="btn btn-quiet" type="submit">Sign out</button></form>
</section>
<form class="tile stack account-emails" id="emails" method="post" action="/dashboard/account/emails">
  <h2>Emails</h2>
  ${saved ? notice("Saved.", "ok") : ""}
  <p class="small">We email ${s.user.email} when something happens to your projects: you claim one, someone joins or is removed, you connect an app, a project is deleted or suspended. Those always go out.</p>
  ${csrfField(s)}
  <label class="check"><input type="checkbox" name="alerts" value="on"${prefs?.email_alerts === 0 ? "" : html` checked`}> <span>Alert me when a site stops sending analytics data or gets suspicious traffic, or a project gets close to a fair-use limit</span></label>
  <label class="check"><input type="checkbox" name="updates" value="on"${prefs?.email_updates === 0 ? "" : html` checked`}> <span>Tell me when there's something new to set up in my projects</span></label>
  <p class="row"><button class="btn btn-quiet" type="submit">Save</button></p>
  ${
    emails.length
      ? html`<details class="recent-emails"><summary class="small">Emails we sent you recently</summary><ul class="email-list">${emails.map(
          (m) =>
            html`<li><span>${m.subject}</span><span class="muted small">${fmtDate(m.sent_at ?? m.created_at)}${m.status === "sent" ? "" : ` · ${m.status}`}</span></li>`,
        )}</ul></details>`
      : ""
  }
</form>
<form class="tile stack danger-zone" method="post" action="/dashboard/account/delete">
  <h2>Delete my account</h2>
  <p class="small">This deletes your sign-in, your project memberships, your sessions and every app you connected. Your projects and their agent keys keep working; a project with no members left becomes unclaimed again. See the <a href="/privacy">privacy policy</a>.</p>
  ${csrfField(s)}
  <label class="field"><span>Type <b>delete</b> to confirm</span><input type="text" name="confirm" required autocomplete="off"></label>
  <p class="row"><button class="btn btn-danger" type="submit">Delete my account</button></p>
</form>
</div>`,
  });
});

dashboard.post("/account/emails", async (c) => {
  const form = await readForm(c);
  await c.env.DB.prepare("UPDATE users SET email_updates = ?, email_alerts = ? WHERE id = ?")
    .bind(form.updates === "on" ? 1 : 0, form.alerts === "on" ? 1 : 0, c.var.session.user.id)
    .run();
  return redirect("/dashboard/account?emails=saved#emails");
});

dashboard.post("/account/delete", async (c) => {
  const form = await readForm(c);
  if ((form.confirm ?? "").trim().toLowerCase() !== "delete") {
    throw new ApiError(400, "not_confirmed", "Your account was not deleted.", "Type delete in the box to confirm.");
  }
  const user = c.var.session.user;
  await emailAccountDeleted(c.env, siteBase(c), { userId: user.id, email: user.email });
  await deleteUser(c.env.DB, user.id);
  return page({
    title: "Account deleted",
    headers: { "set-cookie": clearSessionCookie(c) },
    body: html`<section class="solo"><div class="tile solo-card"><h1>Account deleted</h1><p class="lead">Your sign-in, memberships, sessions and connected apps are gone. Projects keep working for their agents.</p><p class="row"><a class="btn btn-quiet" href="/">Home</a></p></div></section>`,
  });
});
