import { ApiError, assertCanCreateKey, cleanName, createApiKey } from "@afs/shared";
import { type Context, Hono } from "hono";
import { type OpenLink, createClaimLink, listOpenLinks, revokeOpenLink } from "./claims";
import type { SiteEnv } from "./env";
import { siteBase } from "./google";
import { type SafeHtml, csrfField, fmtDate, fmtDay, html, htmlErrorHandler, page } from "./html";
import { type Project, deleteUser, listMembers, listProjects, removeMember, requireProject, revokeGrant } from "./identity";
import { type BuildKind, buildPrompt } from "./dashboard-prompt";
import { projectResources } from "./services";
import { clearSessionCookie, readForm, redirect, requireSession } from "./session";
import { askLine, askText, plural, resourceCounts, resourcesView } from "./views";

/**
 * /dashboard: server-rendered pages for signed-in people. Every project route goes through
 * requireProject(), so a user only ever sees projects they're a member of (others are a 404).
 * Every form is a POST with a CSRF token; pages send frame-ancestors 'none' (see html.ts).
 */

export const dashboard = new Hono<SiteEnv>();
dashboard.use("*", requireSession);

dashboard.onError(htmlErrorHandler);

const PROJECT_ID = /^acct_[0-9a-z]{1,64}$/;
const projectId = (c: Context<SiteEnv>) => {
  const id = c.req.param("id") ?? "";
  if (!PROJECT_ID.test(id)) throw new ApiError(404, "not_found", "Project not found.");
  return id;
};
const projectName = (p: { name: string | null }) => p.name || "Untitled project";

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

function tabs(p: Project, active: "overview" | "keys" | "members"): SafeHtml {
  const tab = (key: string, href: string, label: string) =>
    html`<a href="${href}"${key === active ? html` aria-current="page"` : ""}>${label}</a>`;
  return html`<div class="page-head">
  <p class="crumbs"><a href="/dashboard">Projects</a><span aria-hidden="true">/</span></p>
  <h1>${projectName(p)}</h1>
  <p class="meta"><code>${p.id}</code><span>You're ${p.role === "owner" ? "the owner" : "a member"}</span><span>Created ${fmtDay(p.created_at)}</span></p>
  <nav class="tabs" aria-label="Project">
    ${tab("overview", `/dashboard/projects/${p.id}`, "Overview")}
    ${tab("keys", `/dashboard/projects/${p.id}/keys`, "API keys")}
    ${tab("members", `/dashboard/projects/${p.id}/members`, "Members")}
  </nav>
</div>`;
}

const notice = (msg: string | undefined, kind: "error" | "ok" = "error") =>
  msg ? html`<p class="notice ${kind === "ok" ? "notice-ok" : "notice-error"}" role="status">${msg}</p>` : "";

/**
 * What starts a new project: the agent reads the manual and does the rest. Short on purpose; the
 * manual (llms.txt) has every step, and the landing page's longer prompt says the same.
 */
const SETUP_PROMPT =
  "Set up AgentFirstStack for this project. Read https://agentfirststack.com/llms.txt and follow it: if this project's .env already has AGENTFIRSTSTACK_API_KEY, use it; otherwise get this project its own key. Set up analytics, conversion tracking and an inbox as the project needs (ask me before turning on session replay), and verify each step. Note what you set up in AGENTFIRSTSTACK.md at the repo root (ids and env var names, never key values). When you're done, send me a claim link for the project.";

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

async function projectsPage(c: Context<SiteEnv>) {
  const s = c.var.session;
  const projects = await listProjects(c.env.DB, s.user.id);
  // Resources for the first 20 projects (each is four service calls).
  const shown = projects.slice(0, 20);
  const resources = await Promise.all(shown.map((p) => projectResources(c.env, p.id)));
  const projectTile = (p: Project, i: number) => {
    const r = resources[i];
    return html`<li class="tile project">
      <div class="project-top">
        <h3><a class="project-link" href="/dashboard/projects/${p.id}">${projectName(p)}</a></h3>
        <span class="role">${p.role}</span>
      </div>
      <code class="project-id">${p.id}</code>
      <div class="project-bottom">
        ${r ? resourceCounts(r) : html`<p class="muted small">Open it to see its sites, containers, inboxes and replay sites.</p>`}
        <p class="project-foot">Created ${fmtDay(p.created_at)}</p>
      </div>
    </li>`;
  };
  return page({
    title: "Projects",
    session: s,
    nav: "projects",
    body: html`<div class="bento home-top">
  <section class="tile hero" aria-labelledby="hero-title">
    <div class="hero-copy">
      <h1 id="hero-title">You don't really need this dashboard.</h1>
      <p>${
        projects.length
          ? "Your agent set these projects up, and it can read any of this back to you. Just ask, in plain words."
          : "Your agent sets things up for you, and can read any of it back to you later. Just ask, in plain words."
      }</p>
    </div>
    <ul class="asks">${ASKS.map(
      (a) =>
        html`<li class="ask ask-${a.svc}">${askText(a.text)}<span class="ask-tag"><span class="swatch" aria-hidden="true"></span>${a.label}</span></li>`,
    )}</ul>
    <p class="hero-hint" data-js-text="Copy a question, then paste it into your agent.">Click a question to select it, then copy it into your agent.</p>
  </section>
  <section class="tile add" aria-labelledby="add-title">
    <h2 id="add-title">Set up a new project</h2>
    <p class="muted small">Open your agent in the new project's folder and paste this. It gets the project its own key, sets up what it needs, checks each step, and sends you a claim link that adds it here.</p>
    ${askLine(SETUP_PROMPT, null)}
    <p class="muted small add-also">Already set up by an agent? Ask it:</p>
    ${askLine("Send me a claim link for our AgentFirstStack project.", null)}
  </section>
</div>
<div class="section-head">
  <h2>Projects</h2>
  <p class="muted small">${plural(projects.length, "project", "projects")}. Each is what one API key belongs to: its sites, tag containers, inboxes and replay sites.</p>
</div>
${
  projects.length
    ? html`<ul class="projects">${projects.map(projectTile)}</ul>`
    : html`<div class="tile empty">
  <h3>No projects yet</h3>
  <p>When your agent has set something up, ask it for a claim link and open it: the project shows up here.</p>
  <p class="muted small">Agents create claim links with <code>POST /v1/claim-link</code> or the <code>afs_create_claim_link</code> tool.</p>
</div>`
}`,
  });
}

dashboard.get("/", (c) => projectsPage(c));

dashboard.get("/projects/:id", async (c) => {
  const s = c.var.session;
  const p = await requireProject(c.env.DB, s.user.id, projectId(c));
  const [resources, keys, members] = await Promise.all([
    projectResources(c.env, p.id),
    c.env.DB.prepare("SELECT count(*) AS n FROM api_keys WHERE account_id = ? AND revoked_at IS NULL AND oauth_grant_id IS NULL")
      .bind(p.id)
      .first<number>("n"),
    c.env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE account_id = ?").bind(p.id).first<number>("n"),
  ]);
  const project = { id: p.id, name: projectName(p) };
  return page({
    title: projectName(p),
    session: s,
    nav: "projects",
    body: html`${tabs(p, "overview")}
${resourcesView(resources, { asks: true })}
<div class="bento">
<section class="tile build-own" aria-labelledby="build-title">
  <div class="build-copy">
    <h2 id="build-title">Want a dashboard? Have your agent build it.</h2>
    <p>This page only lists what's set up. For a screen of your own, paste one of these into Claude, Cursor or any coding agent. It builds it inside your app, from the API, already pointed at this project.</p>
  </div>
  <ul class="builds">${BUILDS.map(
    (b) => html`<li class="build svc-${b.kind}">
    <h3><span class="swatch" aria-hidden="true"></span>${b.title}</h3>
    <p>${b.what}</p>
    <details><summary>See the prompt</summary><pre class="prompt-block select">${buildPrompt(b.kind, project, resources, siteBase(c))}</pre></details>
  </li>`,
  )}</ul>
</section>
</div>
<div class="bento project-more">
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
  <form class="tile stack rename" method="post" action="/dashboard/projects/${p.id}/rename">
    <h2>Rename</h2>
    ${csrfField(s)}
    <div class="inline-fields">
      <label class="field"><span>Name</span><input type="text" name="name" maxlength="200" value="${p.name ?? ""}" placeholder="acme.com"></label>
      <button class="btn btn-quiet" type="submit">Save</button>
    </div>
  </form>
</div>`,
  });
});

dashboard.post("/projects/:id/rename", async (c) => {
  const form = await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  await c.env.DB.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(cleanName(form.name, 200), p.id).run();
  return redirect(`/dashboard/projects/${p.id}`);
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
  return page({
    title: `API keys · ${projectName(p)}`,
    session: s,
    nav: "projects",
    status: created ? 201 : (extra.error?.status ?? 200),
    body: html`${tabs(p, "keys")}
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
  return page({
    title: `Members · ${projectName(p)}`,
    session: s,
    nav: "projects",
    status: invite ? 201 : 200,
    body: html`${tabs(p, "members")}
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
  return page({
    title: "Connected apps",
    session: s,
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
  return page({
    title: "Account",
    session: s,
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

dashboard.post("/account/delete", async (c) => {
  const form = await readForm(c);
  if ((form.confirm ?? "").trim().toLowerCase() !== "delete") {
    throw new ApiError(400, "not_confirmed", "Your account was not deleted.", "Type delete in the box to confirm.");
  }
  await deleteUser(c.env.DB, c.var.session.user.id);
  return page({
    title: "Account deleted",
    headers: { "set-cookie": clearSessionCookie(c) },
    body: html`<section class="solo"><div class="tile solo-card"><h1>Account deleted</h1><p class="lead">Your sign-in, memberships, sessions and connected apps are gone. Projects keep working for their agents.</p><p class="row"><a class="btn btn-quiet" href="/">Home</a></p></div></section>`,
  });
});
