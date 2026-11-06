import { ApiError, timingSafeEqual } from "@afs/shared";
import { type Context, Hono } from "hono";
import { NOSCRIPT, attackBanner, tabAttacks } from "./analytics-dashboard";
import { dashPage, type ProjectTab, projectHeader, projectId } from "./dashboard-frame";
import type { SiteEnv } from "./env";
import { type SafeHtml, html } from "./html";
import { type Project, requireProject } from "./identity";
import { type ContainerItem, type InboxItem, type ReplaySiteItem, type Service, callService } from "./services";
import { askLine } from "./views";

/**
 * A project's Tags, Replay and Mail tabs, and the data route every dashboard view reads from.
 *
 * The tabs are shells that /dashboard-app.js fills in. It reads the services' own answers through
 * GET /dashboard/projects/:id/data/<service>/<path>: a proxy to the service as the project
 * (internal auth over the service binding), GET only and only the report paths listed in ALLOW,
 * so a project member's browser can read what the project's agent can read, and change nothing.
 * The one write is Watch: POST .../replay/:site/sessions/:session/watch makes a one-hour player
 * link for a recorded session (with the page's CSRF token).
 */

export const serviceViews = new Hono<SiteEnv>();

/** What the dashboard may read, per service. Nothing here writes or returns a secret. */
const ALLOW: Record<Service, RegExp> = {
  analytics:
    /^(?:rollup|sites|sites\/site_[0-9a-z]{1,64}(?:\/(?:stats|timeseries|breakdown|realtime|insights|crawlers|funnels|funnels\/fnl_[0-9a-z]{1,64}|goals|visitors|journeys))?)$/,
  // Not /install (it can carry the first-party proxy key) and not /visitors/:id (stored identity).
  tags: /^(?:containers|containers\/ctr_[0-9a-z]{1,64}(?:\/(?:tag-stats|destinations|events|versions|coverage))?)$/,
  replay: /^(?:sites|sites\/rsite_[0-9a-z]{1,64}(?:\/(?:sessions|summary|errors|metrics))?)$/,
  // Messages as text only (html=false is forced below); no raw MIME, no attachment downloads.
  mail: /^(?:inboxes|inboxes\/inb_[0-9a-z]{1,64}(?:\/(?:messages|threads))?|messages\/msg_[0-9a-z]{1,64}|threads\/thr_[0-9a-z]{1,64}|search)$/,
};
const SERVICES = Object.keys(ALLOW) as Service[];

const jsonError = (c: Context<SiteEnv>, status: number, code: string, message: string) =>
  c.json({ error: { code, message } }, status as 404);

/** The project, or a JSON error (the caller is /dashboard-app.js, not a person). */
async function projectForJson(c: Context<SiteEnv>): Promise<Project | Response> {
  try {
    return await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
  } catch (e) {
    if (e instanceof ApiError) return jsonError(c, e.status, e.code, e.message);
    throw e;
  }
}

/**
 * The dashboard reaches the services with internal credentials, which READ_LIMITER doesn't count,
 * so this route has its own limit per signed-in person (a page load makes 20-40 reads).
 */
async function dashboardReadAllowed(c: Context<SiteEnv>): Promise<boolean> {
  if (!c.env.DASHBOARD_LIMITER) return true;
  try {
    return (await c.env.DASHBOARD_LIMITER.limit({ key: `dash|${c.var.session.user.id}` })).success;
  } catch {
    return true;
  }
}

/**
 * An analytics site's live stream for the dashboard: a WebSocket from the browser, checked here
 * (our own page, signed in, a member of the project) and handed to the analytics Worker, whose
 * site object holds it (GET /v1/sites/:id/realtime/stream).
 */
serviceViews.get("/projects/:id/live/analytics/:site", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return jsonError(c, 426, "upgrade_required", "This is a WebSocket stream; the dashboard opens it.");
  }
  // The browser sends the session cookie with any page's WebSocket: only our own pages may open one.
  if (c.req.header("origin") !== new URL(c.req.url).origin) {
    return jsonError(c, 403, "forbidden", "Live streams open from the dashboard only.");
  }
  if (!(await dashboardReadAllowed(c))) {
    return jsonError(c, 429, "rate_limited", "Too many dashboard requests in the last minute. Wait a minute, then reload the page.");
  }
  const p = await projectForJson(c);
  if (p instanceof Response) return p;
  const site = c.req.param("site");
  if (!/^site_[0-9a-z]{1,64}$/.test(site)) return jsonError(c, 404, "not_found", "Not an analytics site.");
  const binding = c.env.ANALYTICS as Fetcher | undefined;
  if (!binding || !c.env.INTERNAL_TOKEN) return jsonError(c, 503, "service_unavailable", "Analytics isn't connected here.");
  return binding.fetch(`https://analytics.internal/v1/sites/${site}/realtime/stream`, {
    headers: { upgrade: "websocket", "x-afs-internal": c.env.INTERNAL_TOKEN, "x-afs-account": p.id },
  });
});

serviceViews.get("/projects/:id/data/:service/*", async (c) => {
  if (!(await dashboardReadAllowed(c))) {
    return c.json(
      { error: { code: "rate_limited", message: "Too many dashboard requests in the last minute. Wait a minute, then reload the page." } },
      429,
      { "retry-after": "60", "cache-control": "no-store" },
    );
  }
  const p = await projectForJson(c);
  if (p instanceof Response) return p;
  const service = c.req.param("service") as Service;
  if (!SERVICES.includes(service)) return jsonError(c, 404, "not_found", "Not a dashboard report.");
  const url = new URL(c.req.url);
  const prefix = `/dashboard/projects/${p.id}/data/${service}/`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
  if (!ALLOW[service].test(rest)) return jsonError(c, 404, "not_found", "Not a dashboard report.");
  url.searchParams.delete("format"); // JSON only
  if (service === "mail") url.searchParams.set("html", "false");
  const q = url.searchParams.toString();
  const r = await callService(c.env, service, p.id, `/v1/${rest}${q ? `?${q}` : ""}`);
  const body = r.json ?? { error: { code: "service_unavailable", message: "The service didn't answer. Try again in a minute." } };
  return c.json(body, (r.json ? r.status : 502) as 200, { "cache-control": "no-store" });
});

// Watch a recorded session: a one-hour link to the replay player.
serviceViews.post("/projects/:id/replay/:site/sessions/:session/watch", async (c) => {
  const p = await projectForJson(c);
  if (p instanceof Response) return p;
  const csrf = c.req.header("x-csrf") ?? "";
  if (!csrf || !timingSafeEqual(csrf, c.var.session.csrf)) return jsonError(c, 403, "bad_csrf", "Reload the page and try again.");
  const site = c.req.param("site");
  const session = c.req.param("session");
  if (!/^rsite_[0-9a-z]{1,64}$/.test(site) || !/^rs_[0-9a-z]{1,64}$/.test(session))
    return jsonError(c, 404, "not_found", "Session not found.");
  const r = await callService<{ link?: { url: string; expires_at: number }; error?: { message?: string } }>(
    c.env,
    "replay",
    p.id,
    `/v1/sites/${site}/links`,
    { method: "POST", body: { session_id: session, expires_in: 3600 } },
  );
  if (!r.ok || !r.json?.link) return jsonError(c, r.status || 502, "watch_failed", r.json?.error?.message ?? "Couldn't open the player.");
  return c.json({ url: r.json.link.url, expires_at: r.json.link.expires_at }, 201, { "cache-control": "no-store" });
});

/** A tab's empty state: nothing of this kind yet, with what to ask the agent. */
function emptyTab(c: Context<SiteEnv>, p: Project, tab: ProjectTab, ok: boolean, what: string, ask: string) {
  return dashPage(c, {
    title: what,
    project: p,
    tab,
    body: html`${projectHeader(p, tab)}
<section class="tile empty">
  <h3>${ok ? `No ${what} on this project yet` : "That service didn't answer"}</h3>
  <p>${ok ? "When your agent sets it up, it shows up here." : "Try again in a minute."}</p>
  ${ok ? askLine(ask, "Ask your agent") : ""}
</section>`,
  });
}

const data = (v: unknown) => JSON.stringify(v);
const ID = {
  tags: /^ctr_[0-9a-z]{1,64}$/,
  replay: /^rsite_[0-9a-z]{1,64}$/,
  mail: /^inb_[0-9a-z]{1,64}$/,
};

/** One of the list's items: the one in the URL (404 if it isn't the project's), else the first. */
function pick<T extends { id: string }>(list: T[], wanted: string | undefined, re: RegExp, what: string): T {
  if (wanted === undefined) return list[0]!;
  const found = re.test(wanted) ? list.find((x) => x.id === wanted) : undefined;
  if (!found) throw new ApiError(404, "not_found", `${what} not found.`);
  return found;
}

const shell = (
  c: Context<SiteEnv>,
  p: Project,
  tab: ProjectTab,
  title: string,
  attrs: Record<string, unknown>,
  banner: SafeHtml | "" = "",
) =>
  dashPage(c, {
    title,
    project: p,
    tab,
    scripts: ["/dashboard-app.js"],
    styles: ["/dashboard-app.css"],
    body: html`${projectHeader(p, tab)}
${banner}
<div class="afa" id="afa" data-view="${tab}" data-project="${p.id}" data-csrf="${c.var.session.csrf}" data-role="${p.role}" ${Object.entries(
      attrs,
    ).map(([k, v]) => html`data-${k}="${data(v)}" `)}>${NOSCRIPT}</div>`,
  });

for (const path of ["/projects/:id/tags", "/projects/:id/tags/:item"])
  serviceViews.get(path, async (c) => {
    const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
    const item = c.req.param("item");
    const [r, attacks] = await Promise.all([
      callService<{ containers?: ContainerItem[] }>(c.env, "tags", p.id, "/v1/containers"),
      tabAttacks(c, p, "tags"),
    ]);
    const list = r.json?.containers ?? [];
    if (!list.length)
      return emptyTab(c, p, "tags", r.ok, "tag containers", "Track our sign-ups and key actions with AgentFirstStack tags.");
    const one = pick(list, item, ID.tags, "Container");
    return shell(
      c,
      p,
      "tags",
      `${one.domain} tags`,
      {
        container: one,
        containers: list.map((x) => ({ id: x.id, domain: x.domain })),
      },
      attackBanner(c, p, attacks, one.id),
    );
  });

for (const path of ["/projects/:id/replay", "/projects/:id/replay/:item"])
  serviceViews.get(path, async (c) => {
    const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
    const r = await callService<{ sites?: ReplaySiteItem[] }>(c.env, "replay", p.id, "/v1/sites");
    const list = r.json?.sites ?? [];
    if (!list.length) return emptyTab(c, p, "replay", r.ok, "replay sites", "Turn on AgentFirstStack session replay for my website.");
    const one = pick(list, c.req.param("item"), ID.replay, "Replay site");
    return shell(c, p, "replay", `${one.domain} replay`, {
      site: { id: one.id, domain: one.domain, enabled: one.enabled },
      sites: list.map((x) => ({ id: x.id, domain: x.domain })),
    });
  });

for (const path of ["/projects/:id/mail", "/projects/:id/mail/:item"])
  serviceViews.get(path, async (c) => {
    const p = await requireProject(c.env.DB, c.var.session.user.id, projectId(c));
    const r = await callService<{ inboxes?: InboxItem[] }>(c.env, "mail", p.id, "/v1/inboxes");
    const list = r.json?.inboxes ?? [];
    if (!list.length) return emptyTab(c, p, "mail", r.ok, "inboxes", "Create an AgentFirstStack inbox for our sign-up emails.");
    const one = pick(list, c.req.param("item"), ID.mail, "Inbox");
    return shell(c, p, "mail", one.address, {
      inbox: { id: one.id, address: one.address, display_name: one.display_name, forward: one.forward ?? null },
      inboxes: list.map((x) => ({ id: x.id, address: x.address })),
    });
  });
