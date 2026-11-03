import { ApiError, authenticate, createApiKey } from "@afs/shared";
import { type Context, Hono } from "hono";
import { createClaimLink } from "./claims";
import type { SiteEnv } from "./env";
import { siteBase } from "./google";
import { type SafeHtml, csrfField, fmtDate, html, htmlErrorHandler, page } from "./html";
import {
  type Project,
  addMember,
  createProject,
  deleteUser,
  listMembers,
  listProjects,
  removeMember,
  requireProject,
  revokeGrant,
} from "./identity";
import { analyticsShareLink, projectResources } from "./services";
import { clearSessionCookie, readForm, redirect, requireSession } from "./session";
import { resourceCounts, resourcesView } from "./views";

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
    html`<a href="${href}" class="${key === active ? "is-active" : ""}"${key === active ? html` aria-current="page"` : ""}>${label}</a>`;
  return html`<div class="page-head">
  <p class="crumbs"><a href="/dashboard">Projects</a></p>
  <h1>${projectName(p)}</h1>
  <p class="muted"><code>${p.id}</code> · you are ${p.role === "owner" ? "the owner" : "a member"} · created ${fmtDate(p.created_at)}</p>
  <nav class="tabs" aria-label="Project">
    ${tab("overview", `/dashboard/projects/${p.id}`, "Overview")}
    ${tab("keys", `/dashboard/projects/${p.id}/keys`, "API keys")}
    ${tab("members", `/dashboard/projects/${p.id}/members`, "Members")}
  </nav>
</div>`;
}

const notice = (msg: string | undefined, kind: "error" | "ok" = "error") =>
  msg ? html`<p class="notice ${kind === "ok" ? "notice-ok" : "notice-error"}" role="status">${msg}</p>` : "";

// ---------- projects ----------

async function projectsPage(c: Context<SiteEnv>, error?: string, status = 200) {
  const s = c.var.session;
  const projects = await listProjects(c.env.DB, s.user.id);
  // Resource counts for the first 20 projects (each is three service calls).
  const counts = await Promise.all(projects.slice(0, 20).map((p) => projectResources(c.env, p.id).then(resourceCounts)));
  return page({
    title: "Projects",
    session: s,
    status,
    body: html`<div class="page-head">
  <h1>Projects</h1>
  <p class="muted">Each project is what one API key belongs to: its sites, tag containers and inboxes.</p>
</div>
${notice(error)}
${
  projects.length
    ? html`<ul class="projects">${projects.map(
        (p, i) => html`<li class="card">
      <a class="project-link" href="/dashboard/projects/${p.id}"><b>${projectName(p)}</b><span class="badge">${p.role}</span></a>
      <span class="muted small"><code>${p.id}</code> · ${counts[i] ?? "open to see its resources"}</span>
    </li>`,
      )}</ul>`
    : html`<div class="card empty"><h2>No projects yet</h2><p>Ask your agent for a claim link (<code>POST /v1/claim-link</code> or the <code>afs_create_claim_link</code> tool), or add a project with its API key below.</p></div>`
}
<div class="two">
  <form class="card stack" method="post" action="/dashboard/import">
    <h2>Add a project by key</h2>
    <p class="muted small">Paste a full-access <code>afs_</code> key from your agent or your <code>.env</code>. We only use it to find the project.</p>
    ${csrfField(s)}
    <label class="field"><span>API key</span><input type="password" name="key" required autocomplete="off" spellcheck="false" placeholder="afs_..."></label>
    <button class="btn btn-primary" type="submit">Add project</button>
  </form>
  <form class="card stack" method="post" action="/dashboard/projects">
    <h2>New project</h2>
    <p class="muted small">An empty project. Create a key for it, or connect a chat app to it.</p>
    ${csrfField(s)}
    <label class="field"><span>Name</span><input type="text" name="name" maxlength="200" placeholder="acme.com"></label>
    <button class="btn btn-quiet" type="submit">Create project</button>
  </form>
</div>`,
  });
}

dashboard.get("/", (c) => projectsPage(c));

dashboard.post("/import", async (c) => {
  const form = await readForm(c);
  const key = (form.key ?? "").trim();
  const auth = key ? await authenticate(c.env.DB, key) : null;
  if (!auth) return projectsPage(c, "That key is unknown, revoked or expired.", 400);
  if (!auth.scopes.includes("*")) return projectsPage(c, "That's a read-only key. Paste a full-access key to add its project.", 400);
  await addMember(c.env.DB, c.var.session.user.id, auth.accountId);
  return redirect(`/dashboard/projects/${auth.accountId}`);
});

dashboard.post("/projects", async (c) => {
  const form = await readForm(c);
  const id = await createProject(c.env.DB, c.var.session.user.id, cleanName(form.name));
  return redirect(`/dashboard/projects/${id}`);
});

dashboard.get("/projects/:id", async (c) => {
  const s = c.var.session;
  const p = await requireProject(c.env.DB, s.user.id, projectId(c));
  const resources = await projectResources(c.env, p.id);
  return page({
    title: projectName(p),
    session: s,
    body: html`${tabs(p, "overview")}
${resourcesView(resources, { projectId: p.id, session: s })}
<form class="card stack inline-form" method="post" action="/dashboard/projects/${p.id}/rename">
  <h2>Rename</h2>
  ${csrfField(s)}
  <label class="field"><span>Name</span><input type="text" name="name" maxlength="200" value="${p.name ?? ""}" placeholder="acme.com"></label>
  <button class="btn btn-quiet" type="submit">Save</button>
</form>`,
  });
});

dashboard.post("/projects/:id/rename", async (c) => {
  const form = await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  await c.env.DB.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(cleanName(form.name), p.id).run();
  return redirect(`/dashboard/projects/${p.id}`);
});

dashboard.post("/projects/:id/sites/:site/share", async (c) => {
  await readForm(c);
  const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  const site = c.req.param("site");
  if (!/^site_[0-9a-z]{1,64}$/.test(site)) throw new ApiError(404, "not_found", "Site not found.");
  const url = await analyticsShareLink(c.env, p.id, site);
  if (!url)
    throw new ApiError(
      502,
      "unavailable",
      "Couldn't open the analytics dashboard.",
      "The analytics service didn't answer. Try again in a moment.",
    );
  return redirect(url);
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
  return page({
    title: `API keys · ${projectName(p)}`,
    session: s,
    status: created ? 201 : 200,
    body: html`${tabs(p, "keys")}
${
  created
    ? html`<div class="card secret-card" role="status">
  <h2>New key${created.name ? html`: ${created.name}` : ""}</h2>
  <p>Copy it now. It isn't shown again.</p>
  <pre class="secret">${created.key}</pre>
  <p class="muted small">Scope: ${created.scopes === "*" ? "full access" : "read only"}. Send it as <code>Authorization: Bearer &lt;key&gt;</code> to any AgentFirstStack service.</p>
</div>`
    : ""
}
<section class="card">
  <h2>Keys</h2>
  ${
    keys.length
      ? html`<table class="table">
    <thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Created</th><th>Last used</th><th></th></tr></thead>
    <tbody>${keys.map(
      (k) => html`<tr>
      <td>${k.name || "unnamed"}</td><td><code>${k.prefix}…</code></td><td>${k.scopes === "*" ? "full" : "read only"}</td>
      <td>${fmtDate(k.created_at)}</td><td>${fmtDate(k.last_used_at)}</td>
      <td><form method="post" action="/dashboard/projects/${p.id}/keys/${k.id}/revoke">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">Revoke</button></form></td>
    </tr>`,
    )}</tbody>
  </table>`
      : html`<p class="muted">No active keys.</p>`
  }
  <p class="muted small">Revoking a key stops it at once, including for any agent that uses it.</p>
</section>
<form class="card stack inline-form" method="post" action="/dashboard/projects/${p.id}/keys">
  <h2>Create a key</h2>
  ${csrfField(s)}
  <label class="field"><span>Name</span><input type="text" name="name" maxlength="100" placeholder="ci"></label>
  <label class="field"><span>Access</span><select name="scope"><option value="*">Full access</option><option value="read">Read only</option></select></label>
  <button class="btn btn-primary" type="submit">Create key</button>
</form>`,
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
    status: invite ? 201 : 200,
    body: html`${tabs(p, "members")}
${
  invite
    ? html`<div class="card secret-card" role="status">
  <h2>Invite link</h2>
  <p>Send this to your teammate. It works once and expires ${fmtDate(invite.expires_at)}.</p>
  <pre class="secret">${invite.url}</pre>
</div>`
    : ""
}
<section class="card">
  <h2>Members</h2>
  <table class="table">
    <thead><tr><th>Person</th><th>Role</th><th>Joined</th><th></th></tr></thead>
    <tbody>${members.map((m) => {
      const self = m.user_id === s.user.id;
      const canRemove = self || p.role === "owner";
      return html`<tr>
      <td>${m.name ? html`${m.name} <span class="muted">${m.email}</span>` : m.email}${self ? html` <span class="badge">you</span>` : ""}</td>
      <td>${m.role}</td><td>${fmtDate(m.created_at)}</td>
      <td>${
        canRemove
          ? html`<form method="post" action="/dashboard/projects/${p.id}/members/${m.user_id}/remove">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">${self ? "Leave" : "Remove"}</button></form>`
          : ""
      }</td>
    </tr>`;
    })}</tbody>
  </table>
  <p class="muted small">Removing someone also disconnects the chat apps they connected to this project.</p>
</section>
<form class="card stack inline-form" method="post" action="/dashboard/projects/${p.id}/members/invite">
  <h2>Invite someone</h2>
  <p class="muted small">Creates a single-use link. Whoever opens it and signs in joins this project as a member.</p>
  ${csrfField(s)}
  <button class="btn btn-primary" type="submit">Create invite link</button>
</form>`,
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
    body: html`<div class="page-head">
  <h1>Connected apps</h1>
  <p class="muted">Chat apps and other tools you allowed to use a project over OAuth, such as Claude or ChatGPT connectors.</p>
</div>
<section class="card">
  ${
    grants.length
      ? html`<table class="table">
    <thead><tr><th>App</th><th>Sends you back to</th><th>Project</th><th>Access</th><th>Connected</th><th>Last used</th><th></th></tr></thead>
    <tbody>${grants.map(
      (g) => html`<tr>
      <td><b>${g.client_name}</b></td><td><code>${redirectHosts(g.redirect_uris)}</code></td>
      <td><a href="/dashboard/projects/${g.account_id}">${g.account_name || g.account_id}</a></td>
      <td>${g.scope === "*" ? "full" : "read only"}</td><td>${fmtDate(g.created_at)}</td><td>${fmtDate(g.last_used_at)}</td>
      <td><form method="post" action="/dashboard/apps/${g.id}/revoke">${csrfField(s)}<button class="btn btn-danger btn-small" type="submit">Disconnect</button></form></td>
    </tr>`,
    )}</tbody>
  </table>`
      : html`<p class="muted">No connected apps. Add <code>${siteBase(c)}/mcp</code> as a custom connector in Claude or ChatGPT to connect one.</p>`
  }
</section>`,
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
    body: html`<div class="page-head"><h1>Account</h1></div>
<section class="card">
  <dl class="facts">
    <div><dt>Name</dt><dd>${s.user.name ?? "not set"}</dd></div>
    <div><dt>Email</dt><dd>${s.user.email}</dd></div>
    <div><dt>Signed up</dt><dd>${fmtDate(s.user.created_at)}</dd></div>
  </dl>
  <form method="post" action="/auth/signout">${csrfField(s)}<button class="btn btn-quiet" type="submit">Sign out</button></form>
</section>
<form class="card stack danger-zone" method="post" action="/dashboard/account/delete">
  <h2>Delete my account</h2>
  <p>This deletes your sign-in, your project memberships, your sessions and every app you connected. Your projects and their agent keys keep working; a project with no members left becomes unclaimed again. See the <a href="/privacy">privacy policy</a>.</p>
  ${csrfField(s)}
  <label class="field"><span>Type <b>delete</b> to confirm</span><input type="text" name="confirm" required autocomplete="off"></label>
  <button class="btn btn-danger" type="submit">Delete my account</button>
</form>`,
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
    body: html`<section class="narrow"><h1>Account deleted</h1><p class="lead">Your sign-in, memberships, sessions and connected apps are gone. Projects keep working for their agents.</p><p class="actions"><a class="btn btn-quiet" href="/">Home</a></p></section>`,
  });
});
