import { type AuthContext, badRequest, requireAuth, tooManyRequests } from "@afs/shared";
import { Hono } from "hono";
import type { Bindings, SiteEnv } from "./env";
import { siteBase } from "./google";
import {
  type ContainerItem,
  callService,
  type InboxItem,
  projectResources,
  type ReplaySiteItem,
  type Resources,
  type SiteItem,
} from "./services";

/**
 * The setup check: the full setup (llms.txt section 3) as a list of checks an agent runs with one
 * call, each ok / missing / failing / warning / waiting_on_owner / unavailable, with the exact call
 * that fixes it. It reads each service as the project (internal auth over the bindings, like the
 * dashboard) and fetches nothing from the website itself: install status comes from what the
 * services already received and from the last verify. It returns nothing an agent couldn't read
 * with the project's own key, and no content visitors sent.
 */

export const SETUP_SERVICES = ["analytics", "tags", "mail", "replay"] as const;
export type SetupService = (typeof SETUP_SERVICES)[number];

/** "analytics,tags" or ["analytics", "tags"] -> the services; null when one isn't a service. */
export function parseServices(raw: unknown): SetupService[] | null {
  const names = (Array.isArray(raw) ? raw : String(raw).split(",")).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.some((n) => !(SETUP_SERVICES as readonly string[]).includes(n))) return null;
  return [...new Set(names)] as SetupService[];
}

export type CheckStatus = "ok" | "missing" | "failing" | "warning" | "waiting_on_owner" | "unavailable";
export type CheckService = "project" | "mail" | "analytics" | "tags" | "replay";

export interface SetupCheck {
  /** Stable id, e.g. "analytics.goals_counted". */
  id: string;
  /** The full-setup step (llms.txt section 3) this belongs to. */
  step: number;
  service: CheckService;
  domain?: string;
  status: CheckStatus;
  /** What is checked, as a statement that's true when it passes. */
  title: string;
  /** What was found. */
  detail: string;
  /** The call that fixes it (only when it doesn't pass). */
  fix?: string;
}

export interface SetupReport {
  project: { id: string; name: string | null; claimed: boolean };
  /** The services checked: all this deployment runs, unless the caller passed `services`. */
  services: SetupService[];
  ready: boolean;
  summary: string;
  counts: Record<CheckStatus, number>;
  checks: SetupCheck[];
  next_steps: string[];
  not_checked: string[];
  domains_not_checked?: string[];
  checked_at: number;
}

/** Each extra domain costs about a dozen service reads; the rest are named with how to check them. */
const MAX_DOMAINS = 5;
const DAY = 86_400_000;
const BLOCKING: CheckStatus[] = ["missing", "failing", "unavailable"];

const NOT_CHECKED = [
  "That every main action from your site map has an event: compare the list in AGENTFIRSTSTACK.md with the tags events and analytics goals above.",
  "That the live pages are the ones you changed: this check fetches nothing. POST /v1/sites/:id/verify on analytics and replay fetch the live homepage.",
  'Backend conversions and payments, if the business has them: send each once with "debug": true and find it in analytics realtime?debug=only.',
  "AGENTFIRSTSTACK.md (it lives in the repo) and the ad platform IDs or tokens still waiting on the owner.",
];

const STATUS_ORDER: CheckStatus[] = ["ok", "missing", "failing", "warning", "waiting_on_owner", "unavailable"];

/** https://example.com -> https://analytics.example.com (service hosts derive from the apex). */
export const serviceUrl = (base: string, svc: string) => {
  const u = new URL(base);
  return `${u.protocol}//${svc}.${u.host}`;
};

export const normDomain = (d: string) =>
  d
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");

/** "example.com", "https://www.example.com/pricing" -> "example.com"; null when it isn't a host. */
export function parseDomain(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 300) return null;
  try {
    const host = new URL(s.includes("://") ? s : `https://${s}`).hostname;
    return /^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(host) ? normDomain(host) : null;
  } catch {
    return null;
  }
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "never");
const list = (names: string[], max = 8) =>
  names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", ");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- the service reads ----------

interface AnalyticsSite {
  site: { id: string; domain: string; replay_site_id: string | null; verification?: { verified?: boolean } | null };
  data: { total_events: number; browser_events: number; server_events: number; last_event_at: number | null } | null;
}
interface Goal {
  id: string;
  name: string;
  type: string;
  match: string;
}
interface GoalRow {
  value: string;
  conversions?: number;
}
interface AnalyticsDestination {
  id: string;
  type: string;
  name: string | null;
  last_status: string | null;
}
interface Report {
  id: string;
  enabled: boolean;
}
interface Alert {
  type: string;
  enabled: boolean;
}
interface Conversion {
  name: string;
  send_to?: Record<string, unknown> & { analytics?: { event_name?: string } };
}
interface TagsContainer {
  container: { id: string; live_version: number | null; domain_verified?: boolean };
  stats?: { today?: { browser_events?: number } };
}
interface TagStats {
  reporting: boolean;
  tags: { tag_id: string; fired: number }[];
  never_fired: string[];
  failing: string[];
}
interface TagsDestination {
  id: string;
  type: string;
  name: string | null;
  enabled: boolean;
  health?: { circuit?: string; consecutive_failures?: number };
}
interface ReplaySite {
  site: {
    id: string;
    enabled: boolean;
    analytics_site_id: string | null;
    require_consent: string | null;
    verification?: { verified?: boolean } | null;
  };
  data: { sessions_total: number; last_session_started_at: number | null } | null;
}

type Read = <T>(service: "analytics" | "tags" | "mail" | "replay", path: string) => Promise<T | null>;

/** "*.example" goal matches compile the way analytics does: `*` is any run of characters. */
function goalMatches(match: string, eventName: string) {
  if (!match.includes("*")) return match === eventName;
  const re = new RegExp(
    `^${match
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return re.test(eventName);
}

// ---------- the report ----------

export async function setupReport(
  env: Bindings,
  accountId: string,
  opts: { base: string; domain?: string | null; services?: SetupService[] | null; resources?: Resources },
): Promise<SetupReport> {
  // Each check reads the services about 15 times: a burst limit per project (the dashboard counts too).
  if (env.SETUP_LIMITER) {
    const { success } = await env.SETUP_LIMITER.limit({ key: `setup|${accountId}` });
    if (!success) throw tooManyRequests("Running the setup check too often (30 a minute per project). Wait a minute, then run it again.");
  }
  const A = serviceUrl(opts.base, "analytics");
  const T = serviceUrl(opts.base, "tags");
  const M = serviceUrl(opts.base, "mail");
  const R = serviceUrl(opts.base, "replay");
  // A service is checked when this deployment runs it and the caller didn't leave it out.
  const want = (s: SetupService) => !opts.services || opts.services.includes(s);
  const has = {
    analytics: !!env.ANALYTICS && want("analytics"),
    tags: !!env.TAGS && want("tags"),
    mail: !!env.MAIL && want("mail"),
    replay: !!env.REPLAY && want("replay"),
  };
  const read: Read = async <T>(service: "analytics" | "tags" | "mail" | "replay", path: string) => {
    const r = await callService<T>(env, service, accountId, path);
    return r.ok ? r.json : null;
  };

  const [resources, account, members, link] = await Promise.all([
    opts.resources ?? projectResources(env, accountId),
    env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(accountId).first<{ name: string | null }>(),
    env.DB.prepare("SELECT count(*) AS n FROM memberships WHERE account_id = ?").bind(accountId).first<number>("n"),
    // An open claim link: unused, unexpired, and the key that asked for it still works.
    env.DB.prepare(
      `SELECT l.expires_at FROM claim_links l LEFT JOIN api_keys k ON k.id = l.created_by_key_id
        WHERE l.account_id = ? AND l.used_at IS NULL AND l.expires_at > ?
          AND (l.created_by_key_id IS NULL OR (k.id IS NOT NULL AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)))
        ORDER BY l.expires_at DESC LIMIT 1`,
    )
      .bind(accountId, Date.now(), Date.now())
      .first<{ expires_at: number }>(),
  ]);
  const name = account?.name?.trim() || null;
  const claimed = (members ?? 0) > 0;
  const checks: SetupCheck[] = [];

  // Step 1: a name the owner recognises.
  checks.push(
    name
      ? { id: "project.named", step: 1, service: "project", status: "ok", title: "The project is named", detail: `"${name}"` }
      : {
          id: "project.named",
          step: 1,
          service: "project",
          status: "missing",
          title: "The project is named",
          detail: "The project has no name, so the owner sees an id in the dashboard and on the claim page.",
          fix: `PATCH ${opts.base}/v1/me {"name":"example.com"} (MCP afs_update_project)`,
        },
  );

  // Step 3: an inbox.
  if (has.mail) checks.push(inboxCheck(resources.inboxes, M));

  // Steps 4-6, per domain.
  const domainsOf = (items: { domain: string }[] | null) => (items ?? []).map((i) => normDomain(i.domain));
  let domains = [
    ...new Set([...domainsOf(resources.sites), ...domainsOf(resources.containers), ...domainsOf(resources.replaySites)]),
  ].sort();
  let notChecked: string[] = [];
  if (opts.domain) domains = [opts.domain];
  else if (domains.length > MAX_DOMAINS) {
    notChecked = domains.slice(MAX_DOMAINS);
    domains = domains.slice(0, MAX_DOMAINS);
  }
  if (!domains.length) {
    // Nothing created yet: everything per website is missing, analytics first (replay links to it).
    const none = (
      id: string,
      step: number,
      service: CheckService,
      listed: unknown[] | null,
      title: string,
      what: string,
      fix: string,
    ): SetupCheck => ({
      id,
      step,
      service,
      status: listed ? "missing" : "unavailable",
      title,
      detail: listed ? `No ${what} yet.` : `The ${service} service didn't answer.`,
      fix,
    });
    if (has.analytics)
      checks.push(
        none(
          "analytics.site",
          4,
          "analytics",
          resources.sites,
          "Analytics has a site for the website",
          "analytics site",
          `POST ${A}/v1/sites {"domain":"example.com"} (MCP analytics_create_site)`,
        ),
      );
    if (has.tags)
      checks.push(
        none(
          "tags.container",
          5,
          "tags",
          resources.containers,
          "There is a tag container for the website",
          "tag container",
          `POST ${T}/v1/containers {"domain":"example.com"} (MCP tags_create_container)`,
        ),
      );
    if (has.replay)
      checks.push(
        none(
          "replay.site",
          6,
          "replay",
          resources.replaySites,
          "Replay records the website",
          "replay site",
          `After the analytics site: POST ${R}/v1/sites {"domain":"example.com","analytics_site_id":"site_...","require_consent":"eea"} (MCP replay_create_replay_site)`,
        ),
      );
  }
  const perDomain = await Promise.all(domains.map((domain) => domainChecks(domain, { resources, read, has, A, T, R })));
  for (const list of perDomain) checks.push(...list);

  // Step 10: the owner has the project.
  checks.push(
    claimed
      ? {
          id: "project.claimed",
          step: 10,
          service: "project",
          status: "ok",
          title: "The owner has claimed the project",
          detail: `${plural(members ?? 0, "person", "people")} can see it in the dashboard.`,
        }
      : link
        ? {
            id: "project.claimed",
            step: 10,
            service: "project",
            status: "waiting_on_owner",
            title: "The owner has claimed the project",
            detail: `A claim link is waiting to be opened (it expires ${iso(link.expires_at)}). Give the owner its URL if you haven't.`,
          }
        : {
            id: "project.claimed",
            step: 10,
            service: "project",
            status: "missing",
            title: "The owner has claimed the project",
            detail: "No one has claimed it and there is no open claim link.",
            fix: `POST ${opts.base}/v1/claim-link (MCP afs_create_claim_link), then give the owner the url`,
          },
  );

  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const c of checks) counts[c.status]++;
  const blocking = checks.filter((c) => BLOCKING.includes(c.status));
  const ready = blocking.length === 0;
  const passed = counts.ok + counts.warning + counts.waiting_on_owner;
  const parts = (["missing", "failing", "unavailable", "warning"] as const).filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  const summary = ready
    ? `Ready: ${passed} of ${checks.length} checks pass${counts.warning ? ` (${plural(counts.warning, "warning")})` : ""}${
        counts.waiting_on_owner ? "; waiting on the owner to open the claim link" : ""
      }. Run the checks in not_checked yourself.`
    : `Not ready: ${parts.join(", ")} of ${checks.length} checks. Fix them in the order of next_steps, then run this check again.`;

  const next_steps = [...new Set(blocking.map((c) => `${c.title}${c.domain ? ` (${c.domain})` : ""}: ${c.fix ?? c.detail}`))];
  if (ready && counts.warning)
    next_steps.push(
      ...checks
        .filter((c) => c.status === "warning")
        .map((c) => `Optional: ${c.title}${c.domain ? ` (${c.domain})` : ""}: ${c.fix ?? c.detail}`),
    );
  if (notChecked.length) next_steps.push(`Check the other domains one at a time: GET ${opts.base}/v1/setup?domain=${notChecked[0]}`);

  return {
    project: { id: accountId, name, claimed },
    services: SETUP_SERVICES.filter((x) => has[x]),
    ready,
    summary,
    counts,
    checks,
    next_steps,
    not_checked: NOT_CHECKED,
    ...(notChecked.length ? { domains_not_checked: notChecked } : {}),
    checked_at: Date.now(),
  };
}

function inboxCheck(inboxes: InboxItem[] | null, M: string): SetupCheck {
  const base = { id: "mail.inbox", step: 3, service: "mail" as const, title: "The project has an inbox" };
  if (!inboxes) return { ...base, status: "unavailable", detail: "The mail service didn't answer.", fix: `GET ${M}/v1/inboxes` };
  if (!inboxes.length)
    return {
      ...base,
      status: "missing",
      detail: "No inbox yet. The setup uses it for any third-party signup that needs an email address.",
      fix: `POST ${M}/v1/inboxes {"username":"example-signups"} (MCP mail_create_inbox)`,
    };
  return {
    ...base,
    status: "ok",
    detail: list(
      inboxes.map((i) => i.address),
      3,
    ),
  };
}

interface Ctx {
  resources: Resources;
  read: Read;
  has: Record<"analytics" | "tags" | "mail" | "replay", boolean>;
  A: string;
  T: string;
  R: string;
}

async function domainChecks(domain: string, x: Ctx): Promise<SetupCheck[]> {
  const find = <I extends { domain: string }>(items: I[] | null) => items?.find((i) => normDomain(i.domain) === domain) ?? null;
  const site = find<SiteItem>(x.resources.sites);
  const container = find<ContainerItem>(x.resources.containers);
  const rsite = find<ReplaySiteItem>(x.resources.replaySites);
  const [analytics, tags, replay] = await Promise.all([
    x.has.analytics ? analyticsChecks(domain, site, x) : { checks: [], goals: null, siteId: null },
    x.has.tags && container ? tagsDetail(container, x) : null,
    x.has.replay ? replayChecks(domain, rsite, site?.id ?? null, x) : [],
  ]);
  const tagsChecks = x.has.tags ? tagsChecksFor(domain, container, tags, analytics, x) : [];
  return [...analytics.checks, ...tagsChecks, ...replay];
}

// ---------- analytics (step 4) ----------

async function analyticsChecks(domain: string, site: SiteItem | null, x: Ctx) {
  const { A } = x;
  const at = (c: Omit<SetupCheck, "step" | "service" | "domain">): SetupCheck => ({ ...c, step: 4, service: "analytics", domain });
  if (!x.resources.sites)
    return {
      checks: [
        at({
          id: "analytics.site",
          status: "unavailable",
          title: "Analytics has a site for the website",
          detail: "The analytics service didn't answer.",
        }),
      ],
      goals: null,
      siteId: null,
    };
  if (!site)
    return {
      checks: [
        at({
          id: "analytics.site",
          status: "missing",
          title: "Analytics has a site for the website",
          detail: `No analytics site for ${domain}.`,
          fix: `POST ${A}/v1/sites {"domain":"${domain}"} (MCP analytics_create_site)`,
        }),
      ],
      goals: null,
      siteId: null,
    };
  const p = `/v1/sites/${site.id}`;
  const [detail, goalsRes, goalStats, dests, reports, alerts] = await Promise.all([
    x.read<AnalyticsSite>("analytics", p),
    x.read<{ goals: Goal[] }>("analytics", `${p}/goals`),
    x.read<{ breakdown?: { results?: GoalRow[] } }>("analytics", `${p}/stats?period=30d&breakdown=goal&debug=include&limit=100`),
    x.read<{ destinations: AnalyticsDestination[]; email_available?: boolean }>("analytics", `${p}/destinations`),
    x.read<{ reports: Report[] }>("analytics", `${p}/reports`),
    x.read<{ alerts: Alert[] }>("analytics", `${p}/alerts`),
  ]);
  const checks: SetupCheck[] = [
    at({ id: "analytics.site", status: "ok", title: "Analytics has a site for the website", detail: `${site.id} (${site.domain})` }),
  ];
  const unavailable = (id: string, title: string) =>
    at({ id, status: "unavailable", title, detail: "The analytics service didn't answer this read.", fix: `GET ${A}${p}` });

  // Events arriving
  const data = detail?.data;
  const receiving = "Analytics is receiving events from the pages";
  if (!detail) checks.push(unavailable("analytics.receiving", receiving));
  else if (!data || !data.total_events)
    checks.push(
      at({
        id: "analytics.receiving",
        status: "missing",
        title: receiving,
        detail: "No events yet.",
        fix: `Put the site's snippet (GET ${A}${p} -> site.snippet) in the <head> of every page, deploy, then open https://${domain}/?afsa_debug=1 and check realtime?debug=only`,
      }),
    );
  else if (!data.browser_events)
    checks.push(
      at({
        id: "analytics.receiving",
        status: "failing",
        title: receiving,
        detail: `${plural(data.server_events, "server event")} but nothing from a browser: the snippet isn't on the live pages.`,
        fix: `Put the site's snippet (GET ${A}${p} -> site.snippet) in the <head> of every page and deploy`,
      }),
    );
  else if (data.last_event_at && Date.now() - data.last_event_at > 7 * DAY)
    checks.push(
      at({
        id: "analytics.receiving",
        status: "warning",
        title: receiving,
        detail: `No events in 7 days (the last at ${iso(data.last_event_at)}). Fine for a site without visitors; otherwise the snippet may have been removed.`,
        fix: `POST ${A}${p}/verify (MCP analytics_verify_install)`,
      }),
    );
  else
    checks.push(
      at({
        id: "analytics.receiving",
        status: "ok",
        title: receiving,
        detail: `${plural(data.total_events, "event")} (${data.browser_events} from browsers, ${data.server_events} server); the last at ${iso(data.last_event_at)}.`,
      }),
    );

  // Domain verified (verify proved the snippet is on the homepage, or the DNS record)
  const verifiedTitle = "The site's domain is verified";
  if (detail?.site?.verification?.verified)
    checks.push(
      at({
        id: "analytics.domain_verified",
        status: "ok",
        title: verifiedTitle,
        detail: "verify found the snippet on the homepage, or the DNS record.",
      }),
    );
  else if (detail)
    checks.push(
      at({
        id: "analytics.domain_verified",
        status: "missing",
        title: verifiedTitle,
        detail: "Not verified yet: verify hasn't found the snippet on the live homepage.",
        fix: `Deploy the snippet, then POST ${A}${p}/verify (MCP analytics_verify_install)`,
      }),
    );

  // Goals, and whether each has counted
  const goals = goalsRes?.goals ?? null;
  if (!goals) checks.push(unavailable("analytics.goals", "There is a goal for each conversion and main action"));
  else if (!goals.length)
    checks.push(
      at({
        id: "analytics.goals",
        status: "missing",
        title: "There is a goal for each conversion and main action",
        detail: "No goals yet.",
        fix: `POST ${A}${p}/goals {"name":"Signed up","type":"event","match":"sign_up"} for each one (MCP analytics_create_goal)`,
      }),
    );
  else {
    checks.push(
      at({
        id: "analytics.goals",
        status: "ok",
        title: "There is a goal for each conversion and main action",
        detail: plural(goals.length, "goal"),
      }),
    );
    const counted = new Map((goalStats?.breakdown?.results ?? []).map((r) => [r.value, r.conversions ?? 0]));
    const title = "Every goal has counted at least once (test traffic included, last 30 days)";
    if (!goalStats) checks.push(unavailable("analytics.goals_counted", title));
    else {
      const never = goals.filter((g) => !counted.get(g.name)).map((g) => g.name);
      checks.push(
        never.length
          ? at({
              id: "analytics.goals_counted",
              status: "failing",
              title,
              detail: `Never counted: ${list(never)}.`,
              fix: `Trigger each on the live site with ?afsa_debug=1 (server events: send one with "debug": true). If one still doesn't count, compare its match with the event names in GET ${A}${p}/schema`,
            })
          : at({ id: "analytics.goals_counted", status: "ok", title, detail: `All ${plural(goals.length, "goal")} counted.` }),
      );
    }
  }

  // Server events (only a hint: not every site has backend conversions)
  if (data?.total_events && !data.server_events)
    checks.push(
      at({
        id: "analytics.server_events",
        status: "warning",
        title: "Conversions only the backend knows arrive as server events",
        detail: "No server events yet. Ignore this if the business has no backend conversions (a verified sign-up, a paid order).",
        fix: `POST ${A}${p}/events {"events":[{"name":"sign_up","visitor_id":"<afsa.visitorId() from the page>","debug":true}]}`,
      }),
    );

  // For the owner: email, weekly report, alerts
  const destTitle = "The owner gets email from analytics";
  if (!dests) checks.push(unavailable("analytics.owner_email", destTitle));
  else {
    const email = dests.destinations.filter((d) => d.type === "email");
    const failed = dests.destinations.filter((d) => d.last_status === "failed").map((d) => d.name ?? d.id);
    if (failed.length)
      checks.push(
        at({
          id: "analytics.owner_email",
          status: "failing",
          title: destTitle,
          detail: `Last delivery failed: ${list(failed)}.`,
          fix: `POST ${A}${p}/destinations/<id>/test (MCP analytics_test_destination) and read the error`,
        }),
      );
    else if (email.length)
      checks.push(
        at({
          id: "analytics.owner_email",
          status: "ok",
          title: destTitle,
          detail: "An email destination reaches every member of the project.",
        }),
      );
    else if (dests.email_available === false)
      checks.push(
        at({
          id: "analytics.owner_email",
          status: dests.destinations.length ? "ok" : "warning",
          title: destTitle,
          detail: dests.destinations.length
            ? "This deployment doesn't send email; a webhook or Slack destination is set."
            : "This deployment doesn't send email. Add a Slack or webhook destination if the owner wants reports.",
          ...(dests.destinations.length
            ? {}
            : { fix: `POST ${A}${p}/destinations {"type":"slack","url":"https://hooks.slack.com/services/..."}` }),
        }),
      );
    else
      checks.push(
        at({
          id: "analytics.owner_email",
          status: "missing",
          title: destTitle,
          detail: "No email destination. It reaches the owner once they claim the project (nothing is sent before).",
          fix: `POST ${A}${p}/destinations {"type":"email","name":"Project members"} (MCP analytics_create_destination)`,
        }),
      );
  }
  const reportTitle = "A weekly report goes to the owner";
  if (!reports) checks.push(unavailable("analytics.weekly_report", reportTitle));
  else
    checks.push(
      reports.reports.some((r) => r.enabled)
        ? at({
            id: "analytics.weekly_report",
            status: "ok",
            title: reportTitle,
            detail: plural(reports.reports.filter((r) => r.enabled).length, "report"),
          })
        : at({
            id: "analytics.weekly_report",
            status: "missing",
            title: reportTitle,
            detail: "No scheduled report.",
            fix: `POST ${A}${p}/reports {"name":"Weekly report","cadence":"weekly","destination_ids":["<the email destination id>"]} (MCP analytics_create_report)`,
          }),
    );
  const alertTitle = "Alerts fire on a traffic drop and when tracking stops";
  if (!alerts) checks.push(unavailable("analytics.alerts", alertTitle));
  else {
    const on = new Set(alerts.alerts.filter((a) => a.enabled).map((a) => a.type));
    const lacking = (["traffic_drop", "no_data"] as const).filter((t) => !on.has(t));
    checks.push(
      lacking.length
        ? at({
            id: "analytics.alerts",
            status: "missing",
            title: alertTitle,
            detail: `Missing: ${lacking.join(", ")}.`,
            fix: `POST ${A}${p}/alerts {"name":"...","type":"${lacking[0]}","destination_ids":["<the email destination id>"]} for each (MCP analytics_create_alert)`,
          })
        : at({ id: "analytics.alerts", status: "ok", title: alertTitle, detail: `${plural(on.size, "alert type")} on.` }),
    );
  }
  return { checks, goals, siteId: site.id };
}

// ---------- tags (step 5) ----------

interface TagsDetail {
  container: TagsContainer | null;
  conversions: Conversion[] | null;
  stats: TagStats | null;
  destinations: TagsDestination[] | null;
}

async function tagsDetail(container: ContainerItem, x: Ctx): Promise<TagsDetail> {
  const p = `/v1/containers/${container.id}`;
  const [detail, stats, dests] = await Promise.all([
    x.read<TagsContainer>("tags", p),
    x.read<TagStats>("tags", `${p}/tag-stats?since=7d`),
    x.read<{ destinations: TagsDestination[] }>("tags", `${p}/destinations`),
  ]);
  const live = detail?.container.live_version ?? container.live_version;
  const version = live ? await x.read<{ config?: { conversions?: Conversion[] } }>("tags", `${p}/versions/${live}`) : null;
  return {
    container: detail,
    conversions: live ? (version ? (version.config?.conversions ?? []) : null) : [],
    stats,
    destinations: dests?.destinations ?? null,
  };
}

function tagsChecksFor(
  domain: string,
  container: ContainerItem | null,
  d: TagsDetail | null,
  analytics: { goals: Goal[] | null; siteId: string | null },
  x: Ctx,
): SetupCheck[] {
  const { T, A } = x;
  const at = (c: Omit<SetupCheck, "step" | "service" | "domain">): SetupCheck => ({ ...c, step: 5, service: "tags", domain });
  if (!x.resources.containers)
    return [
      at({
        id: "tags.container",
        status: "unavailable",
        title: "There is a tag container for the website",
        detail: "The tags service didn't answer.",
      }),
    ];
  if (!container || !d)
    return [
      at({
        id: "tags.container",
        status: "missing",
        title: "There is a tag container for the website",
        detail: `No tag container for ${domain}.`,
        fix: `POST ${T}/v1/containers {"domain":"${domain}"} (MCP tags_create_container)`,
      }),
    ];
  const p = `/v1/containers/${container.id}`;
  const checks: SetupCheck[] = [
    at({ id: "tags.container", status: "ok", title: "There is a tag container for the website", detail: container.id }),
  ];
  const live = d.container?.container.live_version ?? container.live_version;

  // The snippet is on the pages
  const seen =
    d.container?.container.domain_verified ||
    (d.stats?.tags ?? []).some((t) => t.fired > 0) ||
    (d.container?.stats?.today?.browser_events ?? 0) > 0;
  const installedTitle = "The container snippet is on the pages";
  checks.push(
    seen
      ? at({ id: "tags.installed", status: "ok", title: installedTitle, detail: "Found on the homepage or seen from browsers." })
      : at({
          id: "tags.installed",
          status: "missing",
          title: installedTitle,
          detail: "The snippet hasn't been found on the homepage or seen from a browser.",
          fix: `Put the container's snippet (GET ${T}${p} -> container.snippet) in the <head> of every page, deploy, then POST ${T}${p}/scan (MCP tags_scan_site)`,
        }),
  );

  // Published, with events
  if (!live)
    checks.push(
      at({
        id: "tags.published",
        status: "missing",
        title: "A version is published",
        detail: "Nothing is published: browsers load an empty container.",
        fix: `POST ${T}${p}/setup (MCP tags_setup_conversion_tracking), validate and preview, then POST ${T}${p}/publish (MCP tags_publish)`,
      }),
    );
  else {
    checks.push(at({ id: "tags.published", status: "ok", title: "A version is published", detail: `Version ${live} is live.` }));
    const conv = d.conversions;
    const evTitle = "There is an event for each main action";
    if (!conv)
      checks.push(
        at({
          id: "tags.events",
          status: "unavailable",
          title: evTitle,
          detail: "The tags service didn't return the live version.",
          fix: `GET ${T}${p}/versions/${live}`,
        }),
      );
    else if (!conv.length)
      checks.push(
        at({
          id: "tags.events",
          status: "missing",
          title: evTitle,
          detail: `Version ${live} has no events.`,
          fix: `POST ${T}${p}/setup with platforms ["analytics", ...] and one event per main action (MCP tags_setup_conversion_tracking), then publish`,
        }),
      );
    else {
      checks.push(at({ id: "tags.events", status: "ok", title: evTitle, detail: `${plural(conv.length, "event")} in version ${live}.` }));
      const toAnalytics = conv.filter((c) => c.send_to?.analytics);
      if (!toAnalytics.length)
        checks.push(
          at({
            id: "tags.to_analytics",
            status: "missing",
            title: "The events reach analytics",
            detail: "No event is sent to analytics.",
            fix: `Run setup again with "analytics" in platforms (it adds the analytics tag and send_to.analytics), then publish`,
          }),
        );
      else {
        checks.push(
          at({
            id: "tags.to_analytics",
            status: "ok",
            title: "The events reach analytics",
            detail: `${toAnalytics.length} of ${conv.length} go to analytics.`,
          }),
        );
        // Cross-check: each event sent to analytics has a goal there.
        if (analytics.goals && analytics.siteId) {
          const names = [...new Set(toAnalytics.map((c) => c.send_to?.analytics?.event_name || c.name))];
          const eventGoals = analytics.goals.filter((g) => g.type === "event");
          const noGoal = names.filter((n) => !eventGoals.some((g) => goalMatches(g.match, n)));
          checks.push(
            noGoal.length
              ? at({
                  id: "tags.goals_for_events",
                  status: "missing",
                  title: "Each event sent to analytics has a goal there",
                  detail: `No goal for: ${list(noGoal)}. They're recorded, but don't count as conversions.`,
                  fix: `POST ${A}/v1/sites/${analytics.siteId}/goals {"name":"...","type":"event","match":"${noGoal[0]}"} for each (MCP analytics_create_goal)`,
                })
              : at({
                  id: "tags.goals_for_events",
                  status: "ok",
                  title: "Each event sent to analytics has a goal there",
                  detail: `All ${plural(names.length, "event name")} have a goal.`,
                }),
          );
        }
      }
    }
  }

  // Tags firing (report_tag_fires)
  const fireTitle = "Every tag fires, and none fails";
  if (!d.stats)
    checks.push(
      at({
        id: "tags.firing",
        status: "unavailable",
        title: fireTitle,
        detail: "The tags service didn't answer.",
        fix: `GET ${T}${p}/tag-stats?since=7d`,
      }),
    );
  else if (!d.stats.reporting)
    checks.push(
      at({
        id: "tags.firing",
        status: "missing",
        title: fireTitle,
        detail: "report_tag_fires is off, so there's no way to see whether tags fire.",
        fix: `PATCH ${T}${p}/draft {"settings":{"report_tag_fires":true}} (MCP tags_patch_draft), then publish`,
      }),
    );
  else if (live) {
    const failing = d.stats.failing;
    const never = d.stats.never_fired;
    checks.push(
      failing.length || never.length
        ? at({
            id: "tags.firing",
            status: "failing",
            title: fireTitle,
            detail: [failing.length ? `Failing: ${list(failing)}.` : "", never.length ? `Never fired in 7 days: ${list(never)}.` : ""]
              .filter(Boolean)
              .join(" "),
            fix: `GET ${T}${p}/tag-stats?since=7d (MCP tags_get_tag_stats) says why; open a preview on the page that should fire it`,
          })
        : at({
            id: "tags.firing",
            status: "ok",
            title: fireTitle,
            detail: `${plural(d.stats.tags.length, "tag")} fired in the last 7 days.`,
          }),
    );
  }

  // Ad platform destinations (only when there are any)
  const dests = (d.destinations ?? []).filter((t) => t.enabled);
  if (dests.length) {
    const broken = dests
      .filter((t) => t.health?.circuit === "open" || (t.health?.consecutive_failures ?? 0) > 0)
      .map((t) => t.name ?? t.type);
    checks.push(
      broken.length
        ? at({
            id: "tags.destinations",
            status: "failing",
            title: "Conversions reach every ad platform",
            detail: `Failing deliveries: ${list(broken)}.`,
            fix: `GET ${T}${p}/destinations/<id> shows the last failure; POST ${T}${p}/destinations/<id>/test (MCP tags_test_destination) after fixing`,
          })
        : at({
            id: "tags.destinations",
            status: "ok",
            title: "Conversions reach every ad platform",
            detail: `${plural(dests.length, "destination")}, none failing.`,
          }),
    );
  }
  return checks;
}

// ---------- replay (step 6) ----------

async function replayChecks(domain: string, rsite: ReplaySiteItem | null, analyticsSiteId: string | null, x: Ctx): Promise<SetupCheck[]> {
  const { R } = x;
  const at = (c: Omit<SetupCheck, "step" | "service" | "domain">): SetupCheck => ({ ...c, step: 6, service: "replay", domain });
  if (!x.resources.replaySites)
    return [
      at({ id: "replay.site", status: "unavailable", title: "Replay records the website", detail: "The replay service didn't answer." }),
    ];
  if (!rsite)
    return [
      at({
        id: "replay.site",
        status: "missing",
        title: "Replay records the website",
        detail: `No replay site for ${domain}.`,
        fix: `POST ${R}/v1/sites {"domain":"${domain}","analytics_site_id":"${analyticsSiteId ?? "site_..."}","require_consent":"eea"} (MCP replay_create_replay_site)`,
      }),
    ];
  const p = `/v1/sites/${rsite.id}`;
  const d = await x.read<ReplaySite>("replay", p);
  if (!d)
    return [
      at({
        id: "replay.site",
        status: "unavailable",
        title: "Replay records the website",
        detail: "The replay service didn't answer.",
        fix: `GET ${R}${p}`,
      }),
    ];
  const checks: SetupCheck[] = [
    d.site.enabled
      ? at({ id: "replay.site", status: "ok", title: "Replay records the website", detail: rsite.id })
      : at({
          id: "replay.site",
          status: "warning",
          title: "Replay records the website",
          detail: `${rsite.id} is turned off (enabled: false). Fine if the owner chose that.`,
          fix: `PATCH ${R}${p} {"enabled":true}`,
        }),
  ];
  checks.push(
    d.site.analytics_site_id
      ? at({
          id: "replay.linked",
          status: "ok",
          title: "Replay is linked to analytics",
          detail: `Loads with analytics site ${d.site.analytics_site_id}.`,
        })
      : at({
          id: "replay.linked",
          status: "missing",
          title: "Replay is linked to analytics",
          detail: "Not linked: the recorder needs its own snippet, and sessions don't join analytics visits.",
          fix: `PATCH ${R}${p} {"analytics_site_id":"${analyticsSiteId ?? "site_..."}"} (MCP replay_update_replay_site)`,
        }),
  );
  checks.push(
    d.site.verification?.verified
      ? at({
          id: "replay.verified",
          status: "ok",
          title: "Replay's domain is verified",
          detail: "verify found the recorder (or the linked tracker) on the homepage.",
        })
      : at({
          id: "replay.verified",
          status: "missing",
          title: "Replay's domain is verified",
          detail: "Not verified: until it is, replay records only a short trial.",
          fix: `POST ${R}${p}/verify (MCP replay_verify_install)`,
        }),
  );
  const sessions = d.data?.sessions_total ?? 0;
  checks.push(
    sessions
      ? at({
          id: "replay.recording",
          status: "ok",
          title: "Sessions are being recorded",
          detail: `${plural(sessions, "session")}; the last started ${iso(d.data?.last_session_started_at)}.`,
        })
      : at({
          id: "replay.recording",
          status: "missing",
          title: "Sessions are being recorded",
          detail: "No sessions yet.",
          fix: `Open https://${domain}/?afsa_debug=1&afsr=1 in a browser (a forced test recording), then GET ${R}${p}/sessions`,
        }),
  );
  if (!d.site.require_consent)
    checks.push(
      at({
        id: "replay.consent",
        status: "warning",
        title: "Visitors from the EU, UK and Switzerland are recorded only after consent",
        detail: "require_consent is off. Fine if the owner decided so, or the site has its own consent banner wired to replay.",
        fix: `PATCH ${R}${p} {"require_consent":"eea"}`,
      }),
    );
  return checks;
}

// ---------- REST ----------

export const setupApi = new Hono<SiteEnv>();
setupApi.get("/v1/setup", requireAuth<SiteEnv>(), async (c) => {
  const auth: AuthContext = c.var.auth;
  const raw = c.req.query("domain");
  const domain = raw ? parseDomain(raw) : null;
  if (raw && !domain) throw badRequest("`domain` isn't a host name.", "Example: GET /v1/setup?domain=example.com");
  const rawServices = c.req.query("services");
  const services = rawServices ? parseServices(rawServices) : null;
  if (rawServices && !services)
    throw badRequest(
      "`services` names a service that doesn't exist.",
      "A comma-separated list of analytics, tags, mail and replay, e.g. GET /v1/setup?services=analytics (default: all of them, the full setup).",
    );
  return c.json(await setupReport(c.env, auth.accountId, { base: siteBase(c), domain, services }));
});
