import { ApiError, badRequest } from "@afs/shared";
import type { ForwardItem } from "../do/engine";
import type { Bindings } from "../env";

/**
 * The optional link to AgentFirstStack Analytics, over the ANALYTICS service binding with internal
 * auth (x-afs-internal: INTERNAL_TOKEN, x-afs-account: the caller's account), so analytics checks
 * the account exactly as it checks an API key. Used to:
 *   - validate analytics_site_id when a site is linked (it must exist on the same account);
 *   - set the analytics site's replay_site_id to the linked replay site, so its tracker loads the
 *     recorder by itself (no second snippet), and clear it again on unlink or delete;
 *   - forward frustration signals and JS errors as analytics events (rage_click, dead_click,
 *     error_click, js_error, quick_back, excessive_scroll), so analytics breakdowns and funnels
 *     work on them with no new API;
 *   - read a saved analytics funnel for get_funnel_dropoffs.
 */

export const ANALYTICS_SITE_RE = /^site_[0-9a-z]{16}$/;

export const analyticsAvailable = (env: Bindings) => !!env.ANALYTICS && !!env.INTERNAL_TOKEN;

async function call(
  env: Bindings,
  accountId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  if (!env.ANALYTICS || !env.INTERNAL_TOKEN) return { status: 503, json: null };
  const res = await env.ANALYTICS.fetch(
    new Request(`https://analytics.internal${path}`, {
      method,
      headers: {
        "x-afs-internal": env.INTERNAL_TOKEN,
        "x-afs-account": accountId,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

const unavailable = () =>
  new ApiError(
    400,
    "analytics_not_available",
    "This deployment has no link to an analytics service (ANALYTICS service binding and INTERNAL_TOKEN).",
    "Leave analytics_site_id unset here, or ask the operator to bind the analytics Worker as ANALYTICS and set INTERNAL_TOKEN on both.",
  );

/** Throws unless `analyticsSiteId` is an analytics site of this account. Returns its domain. */
export async function checkAnalyticsSite(env: Bindings, accountId: string, analyticsSiteId: string): Promise<{ domain: string | null }> {
  if (!ANALYTICS_SITE_RE.test(analyticsSiteId))
    throw badRequest(
      "analytics_site_id must be an analytics site id (site_ + 16 characters).",
      "GET /v1/sites on the analytics service lists them.",
    );
  if (!analyticsAvailable(env)) throw unavailable();
  const r = await call(env, accountId, "GET", `/v1/sites/${analyticsSiteId}`);
  if (r.status === 404)
    throw badRequest(
      `Analytics site ${analyticsSiteId} was not found on this account.`,
      "Use the id of an analytics site created with the same API key (analytics GET /v1/sites).",
    );
  if (r.status !== 200)
    throw new ApiError(502, "analytics_error", `The analytics service answered HTTP ${r.status}.`, "Retry in a minute.");
  return { domain: typeof r.json?.site?.domain === "string" ? r.json.site.domain : null };
}

/** call() that never throws: a binding failure is status 0. */
const tryCall = (env: Bindings, accountId: string, method: string, path: string, body?: unknown) =>
  call(env, accountId, method, path, body).catch((e: unknown) => ({ status: 0, json: { error: String(e) } as any }));

const logLink = (event: string, status: number, replaySiteId: string, analyticsSiteId: string) =>
  console.log(JSON.stringify({ event, status, site: replaySiteId, analytics_site: analyticsSiteId }));

/**
 * Point the analytics site's tracker at this replay site (PATCH its replay_site_id). Idempotent, so
 * calling it again repairs a link. `ok` = analytics answered with the site naming this replay site.
 * Never throws: a failure is logged and returned.
 */
export async function linkAnalyticsSite(
  env: Bindings,
  accountId: string,
  analyticsSiteId: string,
  replaySiteId: string,
): Promise<{ ok: boolean; status: number }> {
  if (!analyticsAvailable(env)) return { ok: false, status: 503 };
  const r = await tryCall(env, accountId, "PATCH", `/v1/sites/${analyticsSiteId}`, { replay_site_id: replaySiteId });
  const ok = r.status === 200 && r.json?.site?.replay_site_id === replaySiteId;
  if (!ok) logLink("replay.analytics_link_failed", r.status, replaySiteId, analyticsSiteId);
  return { ok, status: r.status };
}

/**
 * Stop the analytics site loading this replay site: clear its replay_site_id, but only while it
 * still names this replay site (it may have been linked to another one since). `ok` = nothing points
 * here any more (cleared, already elsewhere, or the analytics site is gone). Never throws.
 */
export async function unlinkAnalyticsSite(
  env: Bindings,
  accountId: string,
  analyticsSiteId: string,
  replaySiteId: string,
): Promise<{ ok: boolean; status: number }> {
  if (!analyticsAvailable(env)) return { ok: false, status: 503 };
  const cur = await tryCall(env, accountId, "GET", `/v1/sites/${analyticsSiteId}`);
  if (cur.status === 404) return { ok: true, status: 404 };
  if (cur.status !== 200) {
    logLink("replay.analytics_unlink_failed", cur.status, replaySiteId, analyticsSiteId);
    return { ok: false, status: cur.status };
  }
  if (cur.json?.site?.replay_site_id !== replaySiteId) return { ok: true, status: 200 };
  const r = await tryCall(env, accountId, "PATCH", `/v1/sites/${analyticsSiteId}`, { replay_site_id: null });
  const ok = r.status === 200 || r.status === 404;
  if (!ok) logLink("replay.analytics_unlink_failed", r.status, replaySiteId, analyticsSiteId);
  return { ok, status: r.status };
}

/** Does the analytics site name this replay site right now? null = couldn't ask. Never throws. */
export async function analyticsLoadsReplay(
  env: Bindings,
  accountId: string,
  analyticsSiteId: string,
  replaySiteId: string,
): Promise<boolean | null> {
  if (!analyticsAvailable(env)) return null;
  const r = await tryCall(env, accountId, "GET", `/v1/sites/${analyticsSiteId}`);
  if (r.status === 404) return false;
  if (r.status !== 200) return null;
  return r.json?.site?.replay_site_id === replaySiteId;
}

/**
 * The account's analytics site to suggest linking (instead of a second snippet): the one for this
 * domain, or for its parent or a subdomain. `others` = how many analytics sites the account has.
 * null when analytics isn't reachable. Never throws.
 */
export async function suggestAnalyticsSite(
  env: Bindings,
  accountId: string,
  domain: string,
): Promise<{ site: { id: string; domain: string } | null; count: number } | null> {
  if (!analyticsAvailable(env)) return null;
  const r = await tryCall(env, accountId, "GET", "/v1/sites");
  if (r.status !== 200 || !Array.isArray(r.json?.sites)) return null;
  const sites = (r.json.sites as { id?: unknown; domain?: unknown }[]).filter(
    (s): s is { id: string; domain: string } => typeof s.id === "string" && ANALYTICS_SITE_RE.test(s.id) && typeof s.domain === "string",
  );
  const related = (d: string) => d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`);
  const site = sites.find((s) => s.domain === domain) ?? sites.find((s) => related(s.domain)) ?? null;
  return { site: site ? { id: site.id, domain: site.domain } : null, count: sites.length };
}

export interface ForwardVisitor {
  ip: string | null;
  user_agent: string | null;
  analytics_visitor_id: string | null;
}

/** Signals as analytics server events, joined to the visitor (afsa.visitorId(), else ip + user agent). */
export function analyticsEvents(items: ForwardItem[], host: string, v: ForwardVisitor) {
  const visitor = v.analytics_visitor_id
    ? { visitor_id: v.analytics_visitor_id }
    : v.ip && v.user_agent
      ? { ip: v.ip, user_agent: v.user_agent }
      : {};
  return items.map((i) => ({
    name: i.name,
    timestamp: i.ts,
    url: `https://${host}${i.path ?? "/"}`,
    props: Object.fromEntries(Object.entries(i.props).filter(([, val]) => val !== null && val !== "")),
    ...visitor,
  }));
}

export async function forwardSignals(
  env: Bindings,
  accountId: string,
  analyticsSiteId: string,
  events: ReturnType<typeof analyticsEvents>,
) {
  for (let i = 0; i < events.length; i += 100) {
    const r = await call(env, accountId, "POST", `/v1/sites/${analyticsSiteId}/events`, { events: events.slice(i, i + 100) }).catch(
      (e) => ({
        status: 0,
        json: String(e),
      }),
    );
    if (r.status !== 202 && r.status !== 200)
      console.log(JSON.stringify({ event: "replay.forward_failed", status: r.status, site: analyticsSiteId }));
  }
}

/** Steps of a saved analytics funnel ("/pricing", "event:signup", "goal:Purchase"). */
export async function analyticsFunnelSteps(env: Bindings, accountId: string, analyticsSiteId: string, funnelId: string): Promise<string[]> {
  if (!analyticsAvailable(env)) throw unavailable();
  const r = await call(env, accountId, "GET", `/v1/sites/${analyticsSiteId}/funnels`);
  if (r.status !== 200)
    throw new ApiError(502, "analytics_error", `The analytics service answered HTTP ${r.status}.`, "Retry in a minute.");
  const f = (r.json?.funnels as { id: string; steps: string[] }[] | undefined)?.find((x) => x.id === funnelId);
  if (!f)
    throw badRequest(
      `Analytics funnel ${funnelId} was not found on the linked analytics site.`,
      "Analytics GET /v1/sites/:id/funnels lists them; or pass steps.",
    );
  return f.steps;
}
