import { ApiError, createApiKey } from "@afs/shared";
import { type Context, Hono } from "hono";
import { createClaimLink } from "./claims";
import type { SiteEnv } from "./env";
import { siteBase } from "./google";
import { type SafeHtml, csrfField, fmtDate, fmtDay, html, htmlErrorHandler, page } from "./html";
import { type Project, deleteUser, listMembers, listProjects, removeMember, requireProject, revokeGrant } from "./identity";
import { dashboardPrompt } from "./dashboard-prompt";
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
const cleanName = (raw: string | undefined) => {
  const name = (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return name || null;
};

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
  "Set up AgentFirstStack for this project. Read https://agentfirststack.com/llms.txt and follow it: get this project its own API key, set up analytics, conversion tracking and an inbox as the project needs, and verify each step. When you're done, send me a claim link for the project.";

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
  // Resources for the first 20 projects (each is three service calls).
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
        ${r ? resourceCounts(r) : html`<p class="muted small">Open it to see its sites, containers and inboxes.</p>`}
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
  <p class="muted small">${plural(projects.length, "project", "projects")}. Each is what one API key belongs to: its sites, tag containers and inboxes.</p>
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
  const prompt = dashboardPrompt({ id: p.id, name: projectName(p) }, resources, siteBase(c));
  return page({
    title: projectName(p),
    session: s,
    nav: "projects",
    body: html`${tabs(p, "overview")}
${resourcesView(resources, { asks: true })}
<div class="bento">
<section class="tile build-own" aria-labelledby="build-title">
  <div class="build-copy">
    <h2 id="build-title">Want charts? Have your agent build them.</h2>
    <p>This page only lists what's set up. For numbers, ask your agent. For a dashboard, paste this prompt into Claude, Cursor or any coding agent: it builds a Stripe-style dashboard for this project from the API, inside your own app.</p>
  </div>
  <pre class="prompt-block select">${prompt}</pre>
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
  await c.env.DB.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(cleanName(form.name), p.id).run();
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
}

async function keysPage(c: Context<SiteEnv>, p: Project, created?: { key: string; name: string | null; scopes: string }) {
  const s = c.var.session;
  // OAuth access tokens are listed as connected apps, not here.
  const { results: keys } = await c.env.DB.prepare(
    `SELECT id, name, prefix, scopes, created_at, last_used_at FROM api_keys
      WHERE account_id = ? AND revoked_at IS NULL AND oauth_grant_id IS NULL ORDER BY created_at`,
  )
    .bind(p.id)
    .all<KeyRow>();
  const access = (scopes: string) =>
    scopes === "*" ? html`<span class="tag tag-full">Full access</span>` : html`<span class="tag">Read only</span>`;
  return page({
    title: `API keys · ${projectName(p)}`,
    session: s,
    nav: "projects",
    status: created ? 201 : 200,
    body: html`${tabs(p, "keys")}
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
    <thead><tr><th scope="col">Name</th><th scope="col">Key</th><th scope="col">Access</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col"><span class="sr-only">Revoke</span></th></tr></thead>
    <tbody>${keys.map(
      (k) => html`<tr>
      <td data-label="Name"><b>${k.name || "unnamed"}</b></td><td data-label="Key"><code>${k.prefix}…</code></td><td data-label="Access">${access(k.scopes)}</td>
      <td data-label="Created">${fmtDate(k.created_at)}</td><td data-label="Last used">${fmtDate(k.last_used_at)}</td>
      <td class="cell-action"><form method="post" action="/dashboard/projects/${p.id}/keys/${k.id}/revoke">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">Revoke</button></form></td>
    </tr>`,
    )}</tbody>
  </table>`
      : html`<p class="tile-body muted">No active keys.</p>`
  }
  <p class="tile-foot">Revoking a key stops it at once, including for any agent that uses it. Chat apps you connected are under <a href="/dashboard/apps">Connected apps</a>.</p>
</section>
<form class="tile stack create-key" method="post" action="/dashboard/projects/${p.id}/keys">
  <h2>Create a key</h2>
  ${csrfField(s)}
  <div class="inline-fields">
    <label class="field"><span>Name</span><input type="text" name="name" maxlength="100" placeholder="ci"></label>
    <label class="field field-narrow"><span>Access</span><select name="scope"><option value="*">Full access</option><option value="read">Read only</option></select></label>
    <button class="btn btn-primary" type="submit">Create key</button>
  </div>
  ${askLine("Create a read-only AgentFirstStack key for our CI.", "Or ask your agent")}
</form>
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
  const scope = form.scope === "read" ? "read" : "*";
  const name = cleanName(form.name)?.slice(0, 100) ?? null;
  const k = await createApiKey(c.env.DB, p.id, {
    keyPrefix: c.env.KEY_PREFIX || "afs",
    name,
    scope,
    createdByUserId: c.var.session.user.id,
  });
  return keysPage(c, p, { key: k.key, name, scopes: k.scopes });
});

dashboard.post("/projects/:id/keys/:key/revoke", async (c) => {
  await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL")
    .bind(Date.now(), c.req.param("key"), p.id)
    .run();
  return redirect(`/dashboard/projects/${p.id}/keys`);
});

// ---------- members ----------

async function membersPage(c: Context<SiteEnv>, p: Project, invite?: { url: string; expires_at: number }) {
  const s = c.var.session;
  const members = await listMembers(c.env.DB, p.id);
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
  <p class="tile-foot">Removing someone also disconnects the chat apps they connected to this project.</p>
</section>
<form class="tile stack invite" method="post" action="/dashboard/projects/${p.id}/members/invite">
  <h2>Invite someone</h2>
  <p class="muted small">Creates a single-use link. Whoever opens it and signs in joins this project as a member.</p>
  ${csrfField(s)}
  <p class="row"><button class="btn btn-primary" type="submit">Create invite link</button></p>
</form>
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
  const link = await createClaimLink(c.env.DB, siteBase(c), p.id, { userId: c.var.session.user.id });
  return membersPage(c, p, link);
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
