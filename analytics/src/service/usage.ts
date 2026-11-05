import { accountStanding, capFor } from "@afs/shared";
import type { SiteUsage } from "../do/usage";
import { DEFAULT_MAX_BROWSER_USER_PROP_KEYS, DEFAULT_MAX_USER_PROP_KEYS } from "../do/user-props";
import { DEFAULT_MAX_GOALS_PER_SITE, DEFAULT_MAX_SHARE_LINKS_PER_SITE, STORAGE_FULL_HINT, ingestCaps, siteCap } from "../lib/limits";
import { DEFAULT_MAX_ALERTS_PER_SITE } from "./alerts";
import { type Ctx, siteStub } from "./context";
import { DEFAULT_MAX_COST_ROWS_PER_SITE } from "./costs";
import { DEFAULT_MAX_CRAWL_HITS_PER_SITE_PER_DAY } from "./crawlers";
import { DEFAULT_MAX_ALERT_DESTINATIONS_PER_SITE } from "./destinations";
import { DEFAULT_MAX_EXPORT_ROWS_PER_SITE_PER_DAY } from "./export";
import { DEFAULT_MAX_IMPORTED_ROWS_PER_SITE, DEFAULT_MAX_IMPORTS_PER_SITE } from "./imports";
import { DEFAULT_MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY, DEFAULT_MAX_ALERT_EMAILS_PER_SITE_PER_DAY } from "./notify";
import { DEFAULT_MAX_REPORTS_PER_SITE } from "./reports";
import { DEFAULT_MAX_SEGMENTS_PER_SITE } from "./segments";

/**
 * GET /v1/usage: every fair-use cap this service holds an account to, with what it uses now, the
 * limit this deployment sets for an account of its standing (UNCLAIMED_<name> until a person
 * claims it), and when daily budgets reset (00:00 UTC). limit null = no cap. The item shape is
 * mail's (label for a person, drops_data, per), so the platform site can warn owners before a cap.
 *
 * Cheap by design (the site calls it hourly per claimed project): one D1 batch of indexed counts
 * and one small RPC per site (SiteDO.usage: today's counters, storage, small tables), never a scan
 * of events. Deployment-wide budgets (DAILY_EVENT_BUDGET, MAX_CRAWL_HITS_PER_DAY) are the
 * deployment's volume, not the account's, and are not shown.
 */

/** One site under a per-site cap. */
export interface UsagePer {
  id: string;
  /** What a person reads: the site's domain. */
  label: string;
  used: number;
  remaining: number | null;
}

export interface UsageItem {
  /** A short sentence-case name a person reads in an email ("Events a day on one site"). */
  label: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** Daily budgets: next 00:00 UTC (unix ms). null for caps that do not reset. */
  resets_at: number | null;
  /** What one unit is, and what the cap counts. */
  unit: string;
  /** The operator var that sets it (UNCLAIMED_<var> for unclaimed accounts). */
  var: string;
  note?: string;
  /** Reaching it silently loses incoming data (events refused, storage full) rather than failing the agent's own call. */
  drops_data?: true;
  /** Per-site caps: every site, highest use first, at most PER_MAX. used = the top one. */
  per?: UsagePer[];
}

/** At most this many entries in an item's per list. */
export const PER_MAX = 25;
/** Site Durable Objects asked per call (the busiest today first), a few at a time. */
export const MAX_USAGE_SITES = 100;

const fin = (n: number) => (Number.isFinite(n) ? n : null);
const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const nextUtcMidnight = (ts: number) => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

interface ItemOpts {
  note?: string;
  drops_data?: true;
}

function item(
  label: string,
  used: number | null,
  limit: number,
  unit: string,
  varName: string,
  resetsAt: number | null,
  opts: ItemOpts & { per?: UsagePer[] } = {},
): UsageItem {
  const l = fin(limit);
  return {
    label,
    used,
    limit: l,
    remaining: l === null || used === null ? null : Math.max(0, l - used),
    resets_at: resetsAt,
    unit,
    var: varName,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.drops_data ? { drops_data: true as const } : {}),
    ...(opts.per ? { per: opts.per } : {}),
  };
}

interface SiteCounts {
  id: string;
  domain: string;
  goals: number;
  funnels: number;
  segments: number;
  share_links: number;
  alerts: number;
  destinations: number;
  reports: number;
  deliveries: number | null;
  emails: number | null;
}

export async function getUsage(ctx: Ctx, now = Date.now()) {
  const { env, accountId } = ctx;
  const standing = await accountStanding(env, accountId);
  const day = utcDay(now);
  const resets = nextUtcMidnight(now);
  const vars = env as unknown as Record<string, unknown>;
  const db = env.DB;
  // Every count is an index lookup by site id (or account id and day).
  const [sitesRes, eventsRes, crawlRes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT s.id, s.domain,
           (SELECT COUNT(*) FROM goals WHERE site_id = s.id) AS goals,
           (SELECT COUNT(*) FROM funnels WHERE site_id = s.id) AS funnels,
           (SELECT COUNT(*) FROM segments WHERE site_id = s.id) AS segments,
           (SELECT COUNT(*) FROM share_links WHERE site_id = s.id AND revoked_at IS NULL) AS share_links,
           (SELECT COUNT(*) FROM alerts WHERE site_id = s.id) AS alerts,
           (SELECT COUNT(*) FROM alert_destinations WHERE site_id = s.id) AS destinations,
           (SELECT COUNT(*) FROM reports WHERE site_id = s.id) AS reports,
           (SELECT deliveries FROM alert_usage WHERE site_id = s.id AND day = ?2) AS deliveries,
           (SELECT emails FROM alert_usage WHERE site_id = s.id AND day = ?2) AS emails
         FROM sites s WHERE s.account_id = ?1 ORDER BY s.created_at, s.id`,
      )
      .bind(accountId, day),
    // Today's reported counts, deleted sites included (deleting a site doesn't reset the account's day).
    db.prepare("SELECT site_id, events AS n FROM usage_daily WHERE account_id = ? AND day = ?").bind(accountId, day),
    db.prepare("SELECT site_id, hits AS n FROM crawl_usage_daily WHERE account_id = ? AND day = ?").bind(accountId, day),
  ]);
  const sites = (sitesRes?.results ?? []) as unknown as SiteCounts[];
  const reported = (r: typeof eventsRes) => new Map((r?.results ?? []).map((x) => [String(x.site_id), Number(x.n ?? 0)]));
  const eventsD1 = reported(eventsRes);
  const crawlD1 = reported(crawlRes);

  // Each site's Durable Object: today's counters and storage (the busiest sites first, if there are many).
  const asked = [...sites].sort((a, b) => (eventsD1.get(b.id) ?? 0) - (eventsD1.get(a.id) ?? 0)).slice(0, MAX_USAGE_SITES);
  const live = new Map<string, SiteUsage>();
  for (let i = 0; i < asked.length; i += 10)
    await Promise.all(
      asked.slice(i, i + 10).map(async (s) => {
        try {
          const u = await siteStub(env, s.id).usage();
          // null: the site's storage was never set up, so it holds nothing yet.
          live.set(s.id, u ?? EMPTY_USAGE);
        } catch {
          // unreachable now: its numbers are left out (D1's reported counts still cover events)
        }
      }),
    );

  /** Today's count of a site: the live counter, or what it last reported to D1 (null = unknown). */
  const today = (id: string, d1: Map<string, number>, key: "events_today" | "crawl_hits_today") => {
    const l = live.get(id)?.[key];
    const d = d1.get(id);
    return l === undefined ? (d ?? null) : Math.max(l, d ?? 0);
  };
  /** The account's total today: every site D1 knows of (deleted ones too) plus the live ones. */
  const accountTotal = (d1: Map<string, number>, key: "events_today" | "crawl_hits_today") => {
    const ids = new Set([...d1.keys(), ...sites.map((s) => s.id)]);
    let n = 0;
    for (const id of ids) n += today(id, d1, key) ?? 0;
    return n;
  };

  /** A per-site cap: used = the highest site's use, per = every site measured, highest first. */
  const perSite = (
    label: string,
    value: (s: SiteCounts) => number | null,
    limit: number,
    unit: string,
    varName: string,
    resetsAt: number | null,
    opts: ItemOpts = {},
  ): UsageItem => {
    const l = fin(limit);
    const per = sites
      .map((s) => ({ s, v: value(s) }))
      .filter((x): x is { s: SiteCounts; v: number } => x.v !== null)
      .map(({ s, v }) => ({ id: s.id, label: s.domain, used: v, remaining: l === null ? null : Math.max(0, l - v) }))
      .sort((a, b) => b.used - a.used)
      .slice(0, PER_MAX);
    return item(label, per[0]?.used ?? 0, limit, unit, varName, resetsAt, { ...opts, per });
  };
  const fromDo = (key: keyof SiteUsage) => (s: SiteCounts) => {
    const v = live.get(s.id)?.[key];
    return typeof v === "number" ? v : null;
  };

  const caps = ingestCaps(vars as Record<string, string | undefined>, standing);
  const userPropKeys = Math.max(0, capFor(vars, standing, "MAX_USER_PROP_KEYS_PER_SITE", DEFAULT_MAX_USER_PROP_KEYS));
  const browserKeys = Math.max(0, capFor(vars, standing, "MAX_BROWSER_USER_PROP_KEYS_PER_SITE", DEFAULT_MAX_BROWSER_USER_PROP_KEYS));
  const sc = (name: string, fallback: number) => siteCap(env, standing, name, fallback);
  const refusedUntilMidnight = "until 00:00 UTC (429 daily_limit), and are not stored";

  const limits: Record<string, UsageItem> = {
    events_per_site_per_day: perSite(
      "Events a day on one site",
      (s) => today(s.id, eventsD1, "events_today"),
      caps.siteDaily,
      "accepted events, engagement beacons and payments on one site (used = the busiest site today)",
      "MAX_EVENTS_PER_SITE_PER_DAY",
      resets,
      { note: `Beyond it the site's browser and server events and payments are refused ${refusedUntilMidnight}.`, drops_data: true },
    ),
    events_per_account_per_day: item(
      "Events a day across all sites",
      accountTotal(eventsD1, "events_today"),
      caps.accountDaily,
      "accepted events, engagement beacons and payments, summed over the account's sites (a site deleted today still counts)",
      "MAX_EVENTS_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: `Beyond it every site's events are refused ${refusedUntilMidnight}. Sites report to the total about once a minute, so it can run a little behind.`,
        drops_data: true,
      },
    ),
    storage_bytes: perSite(
      "Storage of one site",
      fromDo("database_bytes"),
      caps.storageBytes,
      "bytes of one site's database: events, sessions, payments, imports, costs (used = the largest site)",
      "MAX_SITE_STORAGE_MB",
      null,
      {
        note: `The var is in MB. When full, the site stores no new events, payments, imports or costs (507 storage_full). ${STORAGE_FULL_HINT}`,
        drops_data: true,
      },
    ),
    sites_per_account: item(
      "Sites",
      sites.length,
      sc("MAX_SITES_PER_ACCOUNT", Number.POSITIVE_INFINITY),
      "sites",
      "MAX_SITES_PER_ACCOUNT",
      null,
    ),
    goals_per_site: perSite(
      "Goals on one site",
      (s) => s.goals,
      sc("MAX_GOALS_PER_SITE", DEFAULT_MAX_GOALS_PER_SITE),
      "goals on one site (used = the site with the most)",
      "MAX_GOALS_PER_SITE",
      null,
    ),
    funnels_per_site: perSite(
      "Saved funnels on one site",
      (s) => s.funnels,
      sc("MAX_FUNNELS_PER_SITE", Number.POSITIVE_INFINITY),
      "saved funnels on one site",
      "MAX_FUNNELS_PER_SITE",
      null,
    ),
    segments_per_site: perSite(
      "Segments on one site",
      (s) => s.segments,
      sc("MAX_SEGMENTS_PER_SITE", DEFAULT_MAX_SEGMENTS_PER_SITE),
      "saved segments on one site",
      "MAX_SEGMENTS_PER_SITE",
      null,
    ),
    share_links_per_site: perSite(
      "Share links on one site",
      (s) => s.share_links,
      sc("MAX_SHARE_LINKS_PER_SITE", DEFAULT_MAX_SHARE_LINKS_PER_SITE),
      "active (not revoked) share links on one site",
      "MAX_SHARE_LINKS_PER_SITE",
      null,
    ),
    annotations_per_site: perSite(
      "Annotations on one site",
      fromDo("annotations"),
      sc("MAX_ANNOTATIONS_PER_SITE", Number.POSITIVE_INFINITY),
      "manual annotations on one site (automatic spike and alert notes don't count)",
      "MAX_ANNOTATIONS_PER_SITE",
      null,
    ),
    alerts_per_site: perSite(
      "Alerts on one site",
      (s) => s.alerts,
      sc("MAX_ALERTS_PER_SITE", DEFAULT_MAX_ALERTS_PER_SITE),
      "alert rules on one site",
      "MAX_ALERTS_PER_SITE",
      null,
    ),
    alert_destinations_per_site: perSite(
      "Alert destinations on one site",
      (s) => s.destinations,
      sc("MAX_ALERT_DESTINATIONS_PER_SITE", DEFAULT_MAX_ALERT_DESTINATIONS_PER_SITE),
      "webhook, Slack and email destinations on one site",
      "MAX_ALERT_DESTINATIONS_PER_SITE",
      null,
    ),
    reports_per_site: perSite(
      "Scheduled reports on one site",
      (s) => s.reports,
      sc("MAX_REPORTS_PER_SITE", DEFAULT_MAX_REPORTS_PER_SITE),
      "scheduled reports on one site",
      "MAX_REPORTS_PER_SITE",
      null,
    ),
    alert_deliveries_per_site_per_day: perSite(
      "Alert and report deliveries a day on one site",
      (s) => s.deliveries ?? 0,
      capFor(vars, standing, "MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY", DEFAULT_MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY),
      "alert, report and test deliveries on one site (one per destination)",
      "MAX_ALERT_DELIVERIES_PER_SITE_PER_DAY",
      resets,
      { note: "Beyond it alerts and reports are not sent until 00:00 UTC (their history shows the deliveries skipped)." },
    ),
    alert_emails_per_site_per_day: perSite(
      "Alert and report emails a day on one site",
      (s) => s.emails ?? 0,
      capFor(vars, standing, "MAX_ALERT_EMAILS_PER_SITE_PER_DAY", DEFAULT_MAX_ALERT_EMAILS_PER_SITE_PER_DAY),
      "of those deliveries, emails on one site",
      "MAX_ALERT_EMAILS_PER_SITE_PER_DAY",
      resets,
      { note: "Beyond it email destinations are skipped until 00:00 UTC; webhooks and Slack still get alerts." },
    ),
    cost_rows_per_site: perSite(
      "Ad spend rows on one site",
      fromDo("cost_rows"),
      sc("MAX_COST_ROWS_PER_SITE", DEFAULT_MAX_COST_ROWS_PER_SITE),
      "ad spend rows (date x source x campaign) on one site",
      "MAX_COST_ROWS_PER_SITE",
      null,
      { note: "Past it new rows are refused (reason cost_rows_limit in the record_costs results); existing rows still update." },
    ),
    imported_rows_per_site: perSite(
      "Imported rows on one site",
      fromDo("imported_rows"),
      sc("MAX_IMPORTED_ROWS_PER_SITE", DEFAULT_MAX_IMPORTED_ROWS_PER_SITE),
      "imported daily rows (GA4, Plausible, other tools) on one site",
      "MAX_IMPORTED_ROWS_PER_SITE",
      null,
      { note: "An import that would pass it is refused (403 quota_exceeded); deleting an import frees room." },
    ),
    imports_per_site: perSite(
      "Imports on one site",
      fromDo("imports"),
      sc("MAX_IMPORTS_PER_SITE", DEFAULT_MAX_IMPORTS_PER_SITE),
      "imports (files or reports) on one site",
      "MAX_IMPORTS_PER_SITE",
      null,
    ),
    user_prop_keys_per_site: perSite(
      "User property keys on one site",
      fromDo("user_prop_keys"),
      userPropKeys,
      "distinct user property keys servers set on one site",
      "MAX_USER_PROP_KEYS_PER_SITE",
      null,
      {
        note: "Past it the values of a new key are not stored (events are kept, with the warning user_prop_keys_limit); keys already in use keep updating.",
        drops_data: true,
      },
    ),
    browser_user_prop_keys_per_site: perSite(
      "Browser user property keys on one site",
      fromDo("browser_user_prop_keys"),
      browserKeys,
      "user property keys only browsers created (browser_user_props) on one site, counted apart from server keys",
      "MAX_BROWSER_USER_PROP_KEYS_PER_SITE",
      null,
      { note: "Past it the values of a new browser key are not stored (events are kept).", drops_data: true },
    ),
    crawl_hits_per_site_per_day: perSite(
      "Crawler hits a day on one site",
      (s) => today(s.id, crawlD1, "crawl_hits_today"),
      sc("MAX_CRAWL_HITS_PER_SITE_PER_DAY", DEFAULT_MAX_CRAWL_HITS_PER_SITE_PER_DAY),
      "crawler hits counted on one site (POST /v1/sites/:id/crawls)",
      "MAX_CRAWL_HITS_PER_SITE_PER_DAY",
      resets,
      { note: "Beyond it the site's crawler hits are refused until 00:00 UTC (429 daily_limit) and not counted.", drops_data: true },
    ),
    crawl_hits_per_account_per_day: item(
      "Crawler hits a day across all sites",
      accountTotal(crawlD1, "crawl_hits_today"),
      capFor(vars, standing, "MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY", Number.POSITIVE_INFINITY),
      "crawler hits counted, summed over the account's sites",
      "MAX_CRAWL_HITS_PER_ACCOUNT_PER_DAY",
      resets,
      { note: "Beyond it every site's crawler hits are refused until 00:00 UTC (429 daily_limit) and not counted.", drops_data: true },
    ),
    export_rows_per_site_per_day: perSite(
      "Exported events a day on one site",
      fromDo("export_rows_today"),
      sc("MAX_EXPORT_ROWS_PER_SITE_PER_DAY", DEFAULT_MAX_EXPORT_ROWS_PER_SITE_PER_DAY),
      "raw events exported from one site (GET /v1/sites/:id/export)",
      "MAX_EXPORT_ROWS_PER_SITE_PER_DAY",
      resets,
      { note: "Beyond it export answers 429 daily_limit until 00:00 UTC." },
    ),
  };

  const unmeasured = sites.length - live.size;
  return {
    day,
    resets_at: resets,
    resets_at_iso: new Date(resets).toISOString(),
    claimed: standing.claimed,
    limits,
    sites: sites.length,
    rate_limits:
      "Bursts are also limited per minute (POST /e per network and per site, server events and payments per account, SQL, verify): 429 rate_limited. SQL time has its own budget per site per 10 minutes (SQL_TIME_BUDGET_MS, in get_site limits; 429 sql_budget_exhausted). Those are not listed here.",
    next_steps: [
      ...(standing.claimed
        ? []
        : [
            "Nobody has claimed this account, so the lower unclaimed limits apply. POST /v1/claim-link (on the platform site) gives your person a link to claim it.",
          ]),
      ...(unmeasured > 0
        ? [
            `${unmeasured} of ${sites.length} sites were not measured this time (more than ${MAX_USAGE_SITES} sites, or unreachable): their storage, annotations, costs, imports and user property keys are left out of per.`,
          ]
        : []),
      "GET /v1/sites/:id shows one site's limits and whether it is refusing events now (status: storage_full, daily_limit_reached).",
    ],
  };
}

const EMPTY_USAGE: SiteUsage = {
  day: "",
  events_today: 0,
  crawl_hits_today: 0,
  export_rows_today: 0,
  annotations: 0,
  cost_rows: 0,
  imports: 0,
  imported_rows: 0,
  user_prop_keys: 0,
  browser_user_prop_keys: 0,
  database_bytes: 0,
};
