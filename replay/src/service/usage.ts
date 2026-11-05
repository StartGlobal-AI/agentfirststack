import { accountStanding } from "@afs/shared";
import { DAY, utcDay } from "../do/db";
import type { SiteUsage } from "../do/engine";
import { COUNTERS, type Counter, cap, DEFAULTS, ingestCaps, LIMITS, type Totals, zeroTotals } from "../lib/limits";
import { analyticsAvailable } from "./analytics";
import { type Ctx, siteStub } from "./context";
import { surveyCaps } from "./surveys";
import { tagsAvailable } from "./tags";

/**
 * GET /v1/usage (MCP get_usage): every fair-use cap replay enforces for this account, with what it
 * has used, the limit this deployment sets for an account of its standing (UNCLAIMED_<name> until a
 * person claims it), and when daily budgets reset. The item shape is mail's (mail/src/service/
 * usage.ts): label (for a person), drops_data (reaching it silently loses incoming data) and per
 * (per-site caps), so the platform site can warn a project's people before data is lost.
 *
 * Cheap on purpose (the site reads it hourly for every claimed project): two D1 reads (account
 * counters, per-site counts over indexes) and one read-only call to each site's Durable Object for
 * today's counters (a key read of its daily row plus a few small counts). Nothing scans sessions,
 * chunks or R2. Deployment-wide budgets (MAX_PLATFORM_*) are the deployment's volume, not the
 * account's, and are never shown.
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
  /** A short sentence-case name a person reads in an email ("Recorded sessions a day on one site"). */
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
  /**
   * Reaching it silently loses incoming data (sessions not recorded, chunks refused, signals or
   * webhook events not sent) rather than failing the agent's own call with a clear error.
   */
  drops_data?: true;
  /** Per-site caps: every site it applies to, highest use first, at most PER_MAX. used = the top one. */
  per?: UsagePer[];
}

/** At most this many entries in an item's per list. */
export const PER_MAX = 25;

/** Durable Objects read at once. */
const DO_CONCURRENCY = 10;

const HOUR = 3_600_000;

interface ItemOpts {
  note?: string;
  drops_data?: true;
  per?: UsagePer[];
}

function item(
  label: string,
  used: number | null,
  limit: number | null,
  unit: string,
  varName: string,
  resetsAt: number | null,
  opts: ItemOpts = {},
): UsageItem {
  return {
    label,
    used,
    limit,
    remaining: limit === null || used === null ? null : Math.max(0, limit - used),
    resets_at: resetsAt,
    unit,
    var: varName,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.drops_data ? { drops_data: true as const } : {}),
    ...(opts.per ? { per: opts.per } : {}),
  };
}

/** D1 facts of one site, with its Durable Object's counters for today (null = it couldn't be read). */
interface SiteFacts {
  id: string;
  domain: string;
  verified: boolean;
  analytics_linked: boolean;
  tags_linked: boolean;
  links: number;
  segments: number;
  event_definitions: number;
  surveys: number;
  active_surveys: number;
  heatmap_images: number;
  today: SiteUsage | null;
}

/** The numeric counters a site's Durable Object reports. */
type SiteCounter = { [K in keyof SiteUsage]: SiteUsage[K] extends number ? K : never }[keyof SiteUsage];

/** A per-site item: `used` = the busiest site's, `per` = every site in `sites`, busiest first. */
function perSite(
  label: string,
  sites: SiteFacts[],
  used: (s: SiteFacts) => number,
  limit: number | null,
  unit: string,
  varName: string,
  resetsAt: number | null,
  opts: Omit<ItemOpts, "per"> = {},
): UsageItem {
  const per = sites
    .map((s, i) => ({ s, i, n: used(s) }))
    // highest first; ties keep the sites' creation order
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, PER_MAX)
    .map(({ s, n }) => ({ id: s.id, label: s.domain, used: n, remaining: limit === null ? null : Math.max(0, limit - n) }));
  return item(label, per[0]?.used ?? 0, limit, unit, varName, resetsAt, { ...opts, per });
}

async function mapLimited<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += n) out.push(...(await Promise.all(xs.slice(i, i + n).map(fn))));
  return out;
}

const nextUtcMidnight = (now: number) => Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY;

export async function getUsage(ctx: Ctx, now = Date.now()) {
  const env = ctx.env;
  const accountId = ctx.accountId;
  const standing = await accountStanding(env, accountId);
  const day = utcDay(now);
  const resets = nextUtcMidnight(now);
  const c = (name: string, fallback: number) => cap(env, standing, name, fallback);
  const db = env.DB;
  const [account, siteRows] = await db.batch([
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sites WHERE account_id = ?1) AS sites,
           (SELECT COUNT(*) FROM sites WHERE account_id = ?1 AND verified_at IS NULL) AS unverified_sites,
           (SELECT COUNT(*) FROM webhooks WHERE account_id = ?1) AS webhooks,
           (SELECT deliveries FROM webhook_usage WHERE account_id = ?1 AND day = ?2) AS webhook_deliveries,
           (SELECT tests FROM webhook_usage WHERE account_id = ?1 AND day = ?2) AS webhook_tests,
           (SELECT COUNT(*) FROM verify_log WHERE account_id = ?1 AND created_at > ?3) AS verify_calls,
           (SELECT images FROM heatmap_image_usage WHERE scope = ?1 AND day = ?2) AS heatmap_images,
           (SELECT sessions FROM account_usage WHERE account_id = ?1 AND day = ?2) AS sessions,
           (SELECT chunks FROM account_usage WHERE account_id = ?1 AND day = ?2) AS chunks,
           (SELECT bytes FROM account_usage WHERE account_id = ?1 AND day = ?2) AS bytes,
           (SELECT derived FROM account_usage WHERE account_id = ?1 AND day = ?2) AS derived`,
      )
      .bind(accountId, day, now - HOUR),
    db
      .prepare(
        `SELECT s.id, s.domain, s.verified_at, s.analytics_site_id, s.tags_container_id,
           (SELECT COUNT(*) FROM replay_links l WHERE l.site_id = s.id AND l.revoked_at IS NULL AND l.expires_at > ?2) AS links,
           (SELECT COUNT(*) FROM segments g WHERE g.site_id = s.id) AS segments,
           (SELECT COUNT(*) FROM event_definitions e WHERE e.site_id = s.id) AS event_definitions,
           (SELECT COUNT(*) FROM surveys v WHERE v.site_id = s.id) AS surveys,
           (SELECT COUNT(*) FROM surveys v WHERE v.site_id = s.id AND v.status = 'active') AS active_surveys,
           (SELECT images FROM heatmap_image_usage h WHERE h.scope = s.id AND h.day = ?3) AS heatmap_images
         FROM sites s WHERE s.account_id = ?1 ORDER BY s.created_at, s.id LIMIT ?4`,
      )
      .bind(accountId, now, day, LIMITS.SITES_DEFAULT_LIST),
  ]);
  const a = (account?.results?.[0] ?? {}) as Record<string, number | null>;
  const v = (k: string) => a[k] ?? 0;
  type SiteRow = Record<string, string | number | null>;
  const rows = (siteRows?.results ?? []) as SiteRow[];
  const unread: string[] = [];
  const sites: SiteFacts[] = await mapLimited(rows, DO_CONCURRENCY, async (r) => {
    const id = String(r.id);
    let today: SiteUsage | null = null;
    try {
      today = await siteStub(env, id).usageToday();
    } catch (e) {
      console.error("replay usage: site counters unreadable", id, e);
      unread.push(id);
    }
    const n = (k: string) => Number(r[k] ?? 0);
    return {
      id,
      domain: String(r.domain),
      verified: r.verified_at !== null && r.verified_at !== undefined,
      analytics_linked: !!r.analytics_site_id,
      tags_linked: !!r.tags_container_id,
      links: n("links"),
      segments: n("segments"),
      event_definitions: n("event_definitions"),
      surveys: n("surveys"),
      active_surveys: n("active_surveys"),
      heatmap_images: n("heatmap_images"),
      today: today && today.day === day ? today : null,
    };
  });
  const t = (s: SiteFacts, k: SiteCounter) => s.today?.[k] ?? 0;

  // The account's daily budgets as ingest enforces them: what D1 account_usage holds (reported by
  // every site, deleted ones too) plus what each site hasn't reported yet. account_usage is only
  // written while an account or deployment budget is set, so the sites' own counters are the floor.
  const reported: Totals = { sessions: v("sessions"), chunks: v("chunks"), bytes: v("bytes"), derived: v("derived") };
  const unreported = zeroTotals();
  const counted = zeroTotals();
  for (const s of sites)
    for (const k of COUNTERS) {
      unreported[k] += s.today?.unreported[k] ?? 0;
      counted[k] += t(s, k);
    }
  const daily = (k: Counter) => Math.max(reported[k] + unreported[k], counted[k]);

  const verified = sites.filter((s) => s.verified);
  const unverified = sites.filter((s) => !s.verified);
  const nonForced = (s: SiteFacts) => t(s, "sessions") - t(s, "forced_sessions");
  const caps = ingestCaps(env, standing, true);
  const trialSessions = ingestCaps(env, standing, false).daily_sessions;
  const sv = surveyCaps(env, standing);
  const images = !!env.BROWSER;
  const noImages = "Not available on this deployment (no Browser Rendering binding).";
  const forwarding = analyticsAvailable(env);
  const toTags = tagsAvailable(env);
  // drops_data says what the cap does; where the feature is off here, limit 0 (warnings skip it) and a note.
  const off = "Not available on this deployment.";

  const limits: Record<string, UsageItem> = {
    // ---------------------------------------------------------------- the account
    sites: item(
      "Replay sites",
      v("sites"),
      c("MAX_SITES_PER_ACCOUNT", Number.POSITIVE_INFINITY),
      "replay sites",
      "MAX_SITES_PER_ACCOUNT",
      null,
    ),
    unverified_sites: item(
      "Replay sites waiting for domain verification",
      v("unverified_sites"),
      c("MAX_UNVERIFIED_SITES_PER_ACCOUNT", DEFAULTS.UNVERIFIED_SITES_PER_ACCOUNT),
      "replay sites whose domain isn't verified yet",
      "MAX_UNVERIFIED_SITES_PER_ACCOUNT",
      null,
      { note: "Verify one (POST /v1/sites/:id/verify) or delete one before creating another." },
    ),
    sessions_per_day: item(
      "Recorded sessions a day",
      daily("sessions"),
      caps.account.sessions,
      "new sessions recorded, across sites (test sessions too)",
      "MAX_SESSIONS_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Past it no new session is recorded on any site until 00:00 UTC (429 account_daily_limit, the recorder stops); sessions already recording continue.",
        drops_data: true,
      },
    ),
    chunks_per_day: item(
      "Recording chunks a day",
      daily("chunks"),
      caps.account.chunks,
      "recording chunks stored, across sites (a recorder sends one every few seconds)",
      "MAX_CHUNKS_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Past it every chunk is refused until 00:00 UTC (429 account_daily_limit): recordings stop on every site.",
        drops_data: true,
      },
    ),
    daily_recorded_bytes: item(
      "Recording data a day",
      daily("bytes"),
      caps.account.bytes,
      "bytes stored (compressed chunks, starred sessions' playback copies, survey responses), across sites",
      "MAX_BYTES_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Past it every chunk is refused until 00:00 UTC (429 account_daily_limit): recordings stop on every site.",
        drops_data: true,
      },
    ),
    derived_per_day: item(
      "Derived events a day",
      daily("derived"),
      caps.account.derived,
      "derived rows (clicks, inputs, errors, events, scroll marks, survey responses and impressions), across sites",
      "MAX_DERIVED_PER_ACCOUNT_PER_DAY",
      resets,
      { note: "Past it chunks and survey answers are refused until 00:00 UTC (429 account_daily_limit).", drops_data: true },
    ),
    heatmap_images_per_day: item(
      "Heatmap images a day",
      v("heatmap_images"),
      images ? c("MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY", DEFAULTS.HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY) : 0,
      "heatmap images rendered, across sites (cached ones are free)",
      "MAX_HEATMAP_IMAGES_PER_ACCOUNT_PER_DAY",
      resets,
      images
        ? { note: "Past it GET /v1/sites/:id/heatmap/image answers 429; GET /v1/sites/:id/heatmap has no such cap." }
        : { note: noImages },
    ),
    webhooks: item(
      "Webhooks",
      v("webhooks"),
      c("MAX_WEBHOOKS_PER_ACCOUNT", DEFAULTS.WEBHOOKS_PER_ACCOUNT),
      "webhooks (disabled ones count)",
      "MAX_WEBHOOKS_PER_ACCOUNT",
      null,
    ),
    webhook_deliveries_per_day: item(
      "Webhook deliveries a day",
      v("webhook_deliveries"),
      c("MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY", DEFAULTS.WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY),
      "events queued for delivery (one per event and webhook)",
      "MAX_WEBHOOK_DELIVERIES_PER_ACCOUNT_PER_DAY",
      resets,
      {
        note: "Past it new events are logged as dropped and never sent (GET /v1/webhooks/:id shows them) until 00:00 UTC.",
        drops_data: true,
      },
    ),
    webhook_tests_per_day: item(
      "Webhook tests a day",
      v("webhook_tests"),
      c("MAX_WEBHOOK_TESTS_PER_DAY", DEFAULTS.WEBHOOK_TESTS_PER_DAY),
      "test events sent (POST /v1/webhooks/:id/test)",
      "MAX_WEBHOOK_TESTS_PER_DAY",
      resets,
    ),
    verify_calls_per_hour: item(
      "Install checks an hour",
      v("verify_calls"),
      c("MAX_VERIFY_PER_ACCOUNT_PER_HOUR", DEFAULTS.VERIFY_PER_ACCOUNT_PER_HOUR),
      "POST /v1/sites/:id/verify calls in the last hour (a rolling hour, so resets_at is null)",
      "MAX_VERIFY_PER_ACCOUNT_PER_HOUR",
      null,
    ),

    // ---------------------------------------------------------------- per site (used = the busiest site)
    sessions_per_site_per_day: perSite(
      "Recorded sessions a day on one site",
      verified,
      nonForced,
      caps.daily_sessions,
      "new sessions recorded on one verified site, ?afsr=1 test sessions not counted (used = the busiest site today)",
      "MAX_SESSIONS_PER_SITE_PER_DAY",
      resets,
      {
        note: "Past it that site records no new session until 00:00 UTC (429 daily_session_limit, the recorder stops); sessions already recording continue.",
        drops_data: true,
      },
    ),
    unverified_sessions_per_site_per_day: perSite(
      "Recorded sessions a day on one unverified site",
      unverified,
      nonForced,
      trialSessions,
      "new sessions recorded on one site whose domain isn't verified (the trial quota; used = the busiest such site today)",
      "MAX_UNVERIFIED_SESSIONS_PER_SITE_PER_DAY",
      resets,
      {
        note: "Past it that site records no new session until 00:00 UTC (429 unverified_daily_limit). Verifying the domain (POST /v1/sites/:id/verify) moves it to sessions_per_site_per_day.",
        drops_data: true,
      },
    ),
    forced_sessions_per_site_per_day: perSite(
      "Test recordings a day on one site",
      sites,
      (s) => t(s, "forced_sessions"),
      caps.forced_daily,
      "?afsr=1 test sessions started on one site (used = the busiest site today)",
      "MAX_FORCED_SESSIONS_PER_SITE_PER_DAY",
      resets,
      { note: "Past it ?afsr=1 test recordings are refused until 00:00 UTC (429 forced_daily_limit); visitors' sessions continue." },
    ),
    upgraded_sessions_per_site_per_day: perSite(
      "Upgraded sessions a day on one site",
      sites,
      (s) => t(s, "upgraded_sessions"),
      caps.upgraded_daily,
      "new sessions afsr('upgrade') started on one site (they count as sessions too; used = the busiest site today)",
      "MAX_UPGRADED_SESSIONS_PER_SITE_PER_DAY",
      resets,
      { note: "Past it afsr('upgrade') starts no recording on that site until 00:00 UTC.", drops_data: true },
    ),
    forwarded_events_per_site_per_day: perSite(
      "Signals sent to analytics a day from one site",
      forwarding ? sites.filter((s) => s.analytics_linked) : [],
      (s) => t(s, "forwarded_events"),
      forwarding ? caps.forward_daily : 0,
      "signals and JS errors forwarded to the linked analytics site (analytics_site_id) as events (used = the busiest site today)",
      "MAX_FORWARDED_EVENTS_PER_SITE_PER_DAY",
      resets,
      { note: forwarding ? "Past it signals are still recorded here but not sent to analytics until 00:00 UTC." : off, drops_data: true },
    ),
    tags_events_per_site_per_day: perSite(
      "Signals sent to tags a day from one site",
      toTags ? sites.filter((s) => s.tags_linked) : [],
      (s) => t(s, "tags_events"),
      toTags ? caps.tags_daily : 0,
      "signals and survey scores queued for the linked tags container (tags_container_id) (used = the busiest site today)",
      "MAX_TAGS_EVENTS_PER_SITE_PER_DAY",
      resets,
      { note: toTags ? "Past it signals are still recorded here but not sent to tags until 00:00 UTC." : off, drops_data: true },
    ),
    survey_responses_per_site_per_day: perSite(
      "Survey responses a day on one site",
      sites,
      (s) => t(s, "survey_responses"),
      sv.responses_daily,
      "survey responses started on one site, across its surveys (used = the busiest site today)",
      "MAX_RESPONSES_PER_SITE_PER_DAY",
      resets,
      { note: "Past it visitors' answers on that site are refused until 00:00 UTC.", drops_data: true },
    ),
    test_survey_responses_per_site_per_day: perSite(
      "Survey test responses a day on one site",
      sites,
      (s) => t(s, "test_survey_responses"),
      sv.test_daily,
      "test responses (test_survey previews) on one site (used = the busiest site today)",
      "MAX_TEST_RESPONSES_PER_SITE_PER_DAY",
      resets,
    ),
    heatmap_images_per_site_per_day: perSite(
      "Heatmap images a day for one site",
      images ? sites : [],
      (s) => s.heatmap_images,
      images ? c("MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY", DEFAULTS.HEATMAP_IMAGES_PER_SITE_PER_DAY) : 0,
      "heatmap images rendered for one site (cached ones are free; used = the busiest site today)",
      "MAX_HEATMAP_IMAGES_PER_SITE_PER_DAY",
      resets,
      images ? {} : { note: noImages },
    ),
    daily_export_bytes: perSite(
      "Recording data exported a day from one site",
      sites,
      (s) => t(s, "export_bytes"),
      c("MAX_EXPORT_BYTES_PER_DAY", DEFAULTS.EXPORT_BYTES_PER_DAY),
      "compressed recording bytes GET /v1/sites/:id/sessions/:sid/events read from one site (used = the busiest site today)",
      "MAX_EXPORT_BYTES_PER_DAY",
      resets,
      { note: "Past it raw event exports answer 429 until 00:00 UTC; share links have their own budget." },
    ),
    share_links_per_site: perSite(
      "Active share links on one site",
      sites,
      (s) => s.links,
      c("MAX_LINKS_PER_SITE", Number.POSITIVE_INFINITY),
      "unexpired, unrevoked share links of one site",
      "MAX_LINKS_PER_SITE",
      null,
    ),
    segments_per_site: perSite(
      "Saved segments on one site",
      sites,
      (s) => s.segments,
      c("MAX_SEGMENTS_PER_SITE", DEFAULTS.SEGMENTS_PER_SITE),
      "saved segments of one site",
      "MAX_SEGMENTS_PER_SITE",
      null,
    ),
    event_definitions_per_site: perSite(
      "Event definitions on one site",
      sites,
      (s) => s.event_definitions,
      c("MAX_EVENT_DEFINITIONS_PER_SITE", DEFAULTS.EVENT_DEFINITIONS_PER_SITE),
      "event definitions of one site",
      "MAX_EVENT_DEFINITIONS_PER_SITE",
      null,
    ),
    surveys_per_site: perSite(
      "Surveys on one site",
      sites,
      (s) => s.surveys,
      sv.surveys,
      "surveys of one site, in any status",
      "MAX_SURVEYS_PER_SITE",
      null,
    ),
    active_surveys_per_site: perSite(
      "Active surveys on one site",
      sites,
      (s) => s.active_surveys,
      sv.active,
      "surveys showing at once on one site (status active)",
      "MAX_ACTIVE_SURVEYS_PER_SITE",
      null,
    ),
    starred_sessions_per_site: perSite(
      "Starred sessions on one site",
      sites,
      (s) => t(s, "starred_sessions"),
      c("MAX_STARRED_SESSIONS_PER_SITE", DEFAULTS.STARRED_SESSIONS_PER_SITE),
      "starred sessions of one site",
      "MAX_STARRED_SESSIONS_PER_SITE",
      null,
    ),
    starred_copy_bytes: item(
      "Bytes kept for starred sessions on one site",
      null,
      c("MAX_STARRED_BYTES_PER_SITE", DEFAULTS.STARRED_BYTES_PER_SITE),
      "bytes in one site's starred sessions' playback copies",
      "MAX_STARRED_BYTES_PER_SITE",
      null,
      {
        note: "Not counted here (it would sum chunk rows): GET /v1/sites/:id shows data.starred_copy_bytes. Past it starring a session answers 403.",
      },
    ),
    notes_per_site: perSite(
      "Session notes on one site",
      sites,
      (s) => t(s, "notes"),
      c("MAX_NOTES_PER_SITE", DEFAULTS.NOTES_PER_SITE),
      "notes on one site's sessions",
      "MAX_NOTES_PER_SITE",
      null,
    ),
    labels_per_site: perSite(
      "Labels on one site",
      sites,
      (s) => t(s, "labels"),
      c("MAX_LABELS_PER_SITE", DEFAULTS.LABELS_PER_SITE),
      "distinct labels in use on one site",
      "MAX_LABELS_PER_SITE",
      null,
    ),
  };
  return {
    day,
    resets_at: resets,
    resets_at_iso: new Date(resets).toISOString(),
    claimed: standing.claimed,
    limits,
    ...(unread.length
      ? { unread_sites: unread, unread_note: "These sites' counters couldn't be read just now (counted as 0): call again shortly." }
      : {}),
    not_listed:
      "Caps on one session, chunk, survey, network or share link (MAX_CHUNKS_PER_SESSION, MAX_SESSION_BYTES, MAX_SESSION_MINUTES, MAX_CHUNK_BYTES, MAX_DERIVED_PER_CHUNK, MAX_DERIVED_PER_SESSION, MAX_NOTES_PER_SESSION, MAX_QUESTIONS_PER_SURVEY, MAX_ANSWER_CHARS, MAX_SESSIONS_PER_IP_PER_SITE_PER_DAY, MAX_RESPONSES_PER_NETWORK_PER_SITE_PER_DAY, MAX_IMPRESSIONS_PER_NETWORK_PER_SITE_PER_DAY, MAX_LINK_BYTES_PER_DAY, MAX_EXPORT_ROWS) and ceilings on settings (MAX_SAMPLE_RATE, MAX_RETENTION_DAYS, ...) are not account usage: GET /llms.txt lists them, GET /v1/sites/:id shows a site's limits and the chunks it refused by reason. Bursts are also limited per network and per site at the edge (429 rate_limited); those counters are not listed.",
    next_steps: [
      ...(standing.claimed
        ? []
        : [
            "Nobody has claimed this account, so the lower unclaimed limits apply. POST /v1/claim-link (on the platform site) gives your person a link to claim it.",
          ]),
      ...(unverified.length
        ? [
            `Unverified sites record only the trial quota: POST /v1/sites/<id>/verify (${unverified
              .map((s) => s.id)
              .slice(0, 5)
              .join(", ")}).`,
          ]
        : []),
      "Daily budgets reset at 00:00 UTC. The account's daily totals can trail live traffic by about a minute.",
    ],
  };
}
