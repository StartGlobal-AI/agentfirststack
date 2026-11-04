import type { ChannelGroup } from "../lib/types";
import type { Fetcher } from "../lib/stripe-api";
import { deleteCreatedEndpoint } from "./stripe-connect";
import { ApiError, INTERNAL_KEY_ID, type Standing, accountStanding, badRequest, capFor, newId, parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import type { EnrichedEvent, PathRule } from "../lib/types";
import { isPublicSuffix, isPublicSuffixWildcard, normalizeDomain, parsePage, parseReferrer } from "../lib/url";
import {
  DEFAULT_MAX_GOALS_PER_SITE,
  DEFAULT_MAX_SHARE_LINKS_PER_SITE,
  DEFAULT_SQL_TIME_BUDGET_MS,
  RETENTION_SCHEMA,
  SQL_BUDGET_WINDOW_MS,
  effectiveRetention,
  ingestCaps,
  quotaExceeded,
  retentionBounds,
  siteCap,
} from "../lib/limits";
import {
  EXCLUSION_REASONS,
  MAX_EXCLUSION_RULES,
  compileExclusions,
  excludedBy,
  isEmptyExclusions,
  normalizeExclusions,
} from "../lib/exclusions";
import { isValidTimezone } from "../lib/time";
import { DEFAULT_IGNORED_REFERRERS, MAX_IGNORED_REFERRERS, normalizeHostList, referrerIgnoredBy, spamReferrer } from "../lib/referrers";
import { cleanEvent } from "../lib/ingest-rules";
import { MAX_PATH_RULES, normalizePathRules } from "../lib/pathrules";
import { type Ctx, type SiteRow, isVerified, jsonList, loadSite, parseExclusions, pushSettings, siteStub } from "./context";
import { REPLAY_SITE_RE, proxyKeyFor } from "./ingest";
import { type Framework, installInstructions, scriptSnippet } from "./install";

const hostnamePattern = z
  .string()
  .max(253)
  .regex(/^(\*\.)?[a-z0-9.-]+$/i, "hostname or *.example.com")
  .refine(
    (h) => !isPublicSuffixWildcard(h.toLowerCase()),
    "a wildcard over a public suffix (*.com, *.co.uk, *.vercel.app) would match other people's sites",
  );

const settingsShape = {
  name: z.string().max(200).nullable().optional(),
  timezone: z.string().max(64).optional().describe("IANA timezone, e.g. Europe/Berlin. Periods and buckets use it. Default UTC."),
  visitor_id_mode: z
    .enum(["cookieless", "persistent"])
    .optional()
    .describe("cookieless (default): daily-salted hash, no storage. persistent: random id in localStorage, links returning visitors."),
  retention_days: z
    .number()
    .int()
    .min(RETENTION_SCHEMA.min)
    .max(RETENTION_SCHEMA.max)
    .optional()
    .describe("Raw events older than this are purged daily. Default 400. The deployment may bound it (MIN_/MAX_RETENTION_DAYS)."),
  allowed_hostnames: z
    .array(hostnamePattern)
    .max(50)
    .nullable()
    .optional()
    .describe(
      'Accept browser events only from these hostnames ("*.example.com" allowed; not *.com or other public suffixes). null (default) = the site\'s domain and its subdomains.',
    ),
  respect_dnt: z.boolean().optional().describe("Drop browser events when the visitor sends Global Privacy Control / Do Not Track."),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((c) => c.toUpperCase())
    .nullable()
    .optional()
    .describe(
      "Reporting currency (ISO 4217, e.g. EUR). Payments and subscriptions in other currencies are converted at ingest with that day's ECB reference rate (the original amount and currency are kept). null = none (default): money stays in its own currency. Applies to money recorded after it is set.",
    ),
  browser_revenue: z
    .boolean()
    .optional()
    .describe(
      "Count revenue sent from the browser (afsa('revenue', ...)). Default false: anyone can send browser events, so revenue should come from your server (track_events, payments, Stripe).",
    ),
  browser_user_props: z
    .boolean()
    .optional()
    .describe(
      "Keep user properties sent from the browser (afsa('identify', id, props)). Default false: anyone can send browser events, so set them from your server (user_props on server events); identify itself works either way.",
    ),
  trust_browser_user_id: z
    .boolean()
    .optional()
    .describe(
      "Let user ids from afsa('identify', id) link payments that carry only a user id (metadata.afs_user_id / client_reference_id). Default false: only user ids sent by your server (track_events user_id) link payments, so nobody can pre-seed another user's attribution.",
    ),
  ignored_referrers: z
    .array(z.string().max(253))
    .max(MAX_IGNORED_REFERRERS)
    .nullable()
    .optional()
    .describe(
      `Referrer hosts treated as no referrer (a host covers its subdomains; *.example.com allowed), on top of the built-in hosted-checkout and sign-in hosts (${DEFAULT_IGNORED_REFERRERS.slice(0, 6).join(", ")}, ...): a visitor coming back from them keeps the source they came with. Replaces the list; null clears it.`,
    ),
  path_rules: z
    .array(z.object({ match: z.string().min(1).max(500), replace: z.string().min(1).max(500) }))
    .max(MAX_PATH_RULES)
    .nullable()
    .optional()
    .describe(
      'Path cleaning at ingest, first match wins: [{"match":"/users/*","replace":"/users/:id"}] (* = one path segment, ** = anything). Applies from now on to page paths, entry/exit pages and URLs. Test with GET /v1/sites/:id/exclusions?url=. Replaces the list; null clears it.',
    ),
  redact_pii: z
    .boolean()
    .optional()
    .describe(
      "Replace email addresses and phone numbers (international +... or formatted like (415) 555-0123) in paths, URLs, referrers, UTM tags, titles and props with [email] / [phone] before storing. Default true. user_id is never changed.",
    ),
  search_params: z
    .array(z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/))
    .max(5)
    .nullable()
    .optional()
    .describe(
      'Site search: query parameters that carry a search term, e.g. ["q","s"]. A pageview carrying one also records a site_search event {term} (lowercased, 100 characters, redacted); the rest of the query string is still never stored. null or [] = off (default).',
    ),
  session_timeout_minutes: z
    .number()
    .int()
    .min(5)
    .max(240)
    .nullable()
    .optional()
    .describe("Minutes of inactivity that end a session (5-240; default 30). Applies to sessions from now on."),
  channel_groups: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        source: z.array(z.string().min(1).max(200)).max(20).optional(),
        medium: z.array(z.string().min(1).max(200)).max(20).optional(),
        campaign: z.array(z.string().min(1).max(200)).max(20).optional(),
        channel: z.array(z.string().min(1).max(60)).max(20).optional(),
      }),
    )
    .max(30)
    .nullable()
    .optional()
    .describe(
      'Custom channel groups, first match wins: [{"name":"Partners","source":["partner-*","*.affiliates.com"]},{"name":"Paid Social","medium":["paid_social","cpc"],"source":["facebook","instagram"]}]. Within a rule every condition given must match (any of its patterns; * = anything, case-insensitive) over source, utm_medium, utm_campaign or the built-in channel. Unmatched traffic keeps its built-in channel. Evaluated when you query (applies to stored data): breakdown=channel_group, filters=channel_group==Partners.',
    ),
  content_groups: z
    .array(z.object({ name: z.string().min(1).max(100), match: z.string().min(1).max(500) }))
    .max(50)
    .nullable()
    .optional()
    .describe(
      'Content groups, first match wins: [{"name":"Blog","match":"/blog/*"}] (* = anything). Evaluated when you query, so they apply to stored data too: breakdown=content_group, filters=content_group==Blog.',
    ),
  exclusions: z
    .object({
      ips: z
        .array(z.string().max(64))
        .max(MAX_EXCLUSION_RULES)
        .optional()
        .describe("IPv4/IPv6 addresses or CIDR ranges, e.g. 203.0.113.0/24, 2001:db8::/32."),
      paths: z.array(z.string().max(500)).max(MAX_EXCLUSION_RULES).optional().describe("Path patterns, * = anything, e.g. /admin/*."),
      hostnames: z
        .array(z.string().max(253))
        .max(MAX_EXCLUSION_RULES)
        .optional()
        .describe("Hostnames or *.example.com (e.g. staging.example.com)."),
      countries: z.array(z.string().max(8)).max(250).optional().describe("ISO 3166-1 alpha-2 codes."),
      referrers: z
        .array(z.string().max(253))
        .max(MAX_EXCLUSION_RULES)
        .optional()
        .describe("Referrer hosts to drop (a host covers its subdomains), on top of the built-in referrer-spam list."),
    })
    .nullable()
    .optional()
    .describe(
      "Drop matching events at ingest (from now on; stored data is not changed). Replaces the whole set; null clears it. Drops are counted per reason (excluded_ip, excluded_path, excluded_hostname, excluded_country, excluded_referrer); IPs are compared in memory, never stored.",
    ),
};

export const createSiteInput = z.object({
  domain: z.string().min(1).max(253).describe("The site's domain, e.g. example.com (scheme, path and www. are stripped)."),
  ...settingsShape,
});
export const updateSiteInput = z.object({
  domain: z.string().min(1).max(253).optional(),
  ...settingsShape,
  replay_site_id: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe(
      "Set by the replay service only: when a replay site names this site as its analytics_site_id, the tracker loads that replay site's recorder by itself. With an API key this is refused (403 replay_link_from_replay): link or unlink on the replay site instead (its analytics_site_id).",
    ),
});

/** The TXT record that verifies a site's domain (the alternative to the tracker on the homepage). */
export const verifyRecord = (s: Pick<SiteRow, "id" | "domain">) => ({
  name: `_afs-verify.${s.domain}`,
  type: "TXT",
  value: `afs-analytics-site=${s.id}`,
});

/** Whether (and how) the site proved its domain; share links need it. */
export function verificationJson(s: SiteRow) {
  const verified = isVerified(s);
  return {
    verified,
    method: s.verify_method ?? null,
    verified_at: s.verified_at ?? null,
    ...(verified
      ? {}
      : {
          until_verified: "No share links (a public dashboard names the domain, so the domain must be yours). Tracking works as usual.",
          how: [
            `Put the snippet as a <script src ... data-site="${s.id}"> tag on https://${s.domain}/ (the homepage itself, over https; a tag manager's injected tag doesn't count), then POST /v1/sites/${s.id}/verify (MCP verify_install).`,
            `Or add a DNS TXT record ${verifyRecord(s).name} = "${verifyRecord(s).value}", then POST /v1/sites/${s.id}/verify.`,
          ],
          dns_record: verifyRecord(s),
        }),
  };
}

export function siteJson(s: SiteRow, baseUrl: string) {
  return {
    id: s.id,
    domain: s.domain,
    name: s.name,
    timezone: s.timezone,
    visitor_id_mode: s.visitor_id_mode,
    retention_days: s.retention_days,
    allowed_hostnames: s.allowed_hostnames ? (JSON.parse(s.allowed_hostnames) as string[]) : null,
    respect_dnt: !!s.respect_dnt,
    exclusions: parseExclusions(s.exclusions),
    browser_revenue: !!s.browser_revenue,
    browser_user_props: !!s.browser_user_props,
    trust_browser_user_id: !!s.trust_browser_user_id,
    replay_site_id: s.replay_site_id ?? null,
    ignored_referrers: jsonList<string>(s.ignored_referrers) ?? [],
    path_rules: jsonList<PathRule>(s.path_rules) ?? [],
    redact_pii: s.redact_pii !== 0,
    search_params: jsonList<string>(s.search_params) ?? [],
    content_groups: jsonList<{ name: string; match: string }>(s.content_groups) ?? [],
    session_timeout_minutes: s.session_timeout_minutes ?? 30,
    channel_groups: jsonList<ChannelGroup>(s.channel_groups) ?? [],
    currency: s.currency ?? null,
    verification: verificationJson(s),
    created_at: s.created_at,
    updated_at: s.updated_at,
    snippet: scriptSnippet(baseUrl, s.id),
  };
}

const standingOf = (ctx: Ctx): Promise<Standing> => accountStanding(ctx.env, ctx.accountId);

function checkRetention(days: number | undefined, b: { min: number; max: number }) {
  if (days !== undefined && (days < b.min || days > b.max))
    throw badRequest(
      `retention_days must be between ${b.min} and ${b.max} on this deployment.`,
      `Pick a value in ${b.min}..${b.max}.${b.min > 1 ? " The minimum keeps a site's storage budget meaningful (no fill-and-purge)." : ""}`,
    );
}

/** The fair-use limits that apply to an account's sites, for get_site (null = no limit). */
export function siteLimits(env: Bindings, standing: Standing) {
  const caps = ingestCaps(env as unknown as Record<string, string | undefined>, standing);
  const fin = (n: number) => (Number.isFinite(n) ? n : null);
  const sqlBudget = capFor(env as unknown as Record<string, unknown>, standing, "SQL_TIME_BUDGET_MS", DEFAULT_SQL_TIME_BUDGET_MS);
  return {
    account_claimed: standing.claimed,
    events_per_site_per_day: fin(caps.siteDaily),
    events_per_account_per_day: fin(caps.accountDaily),
    storage_bytes: fin(caps.storageBytes),
    retention_days: retentionBounds(env, standing),
    goals_per_site: fin(siteCap(env, standing, "MAX_GOALS_PER_SITE", DEFAULT_MAX_GOALS_PER_SITE)),
    share_links_per_site: fin(siteCap(env, standing, "MAX_SHARE_LINKS_PER_SITE", DEFAULT_MAX_SHARE_LINKS_PER_SITE)),
    sites_per_account: fin(siteCap(env, standing, "MAX_SITES_PER_ACCOUNT", Number.POSITIVE_INFINITY)),
    sql_time_ms_per_10_min: fin(sqlBudget),
    note: `Daily counts reset at 00:00 UTC. Unclaimed accounts may have lower limits than claimed ones. SQL time is measured per ${SQL_BUDGET_WINDOW_MS / 60_000} minutes.`,
  };
}

/** Validated exclusions as stored in D1 (JSON, or null when empty). */
function exclusionsColumn(input: z.infer<typeof updateSiteInput>["exclusions"]): string | null {
  if (!input) return null;
  const { value, problems } = normalizeExclusions(input);
  if (problems.length) throw badRequest("Invalid exclusions.", problems.join(" "), problems);
  return isEmptyExclusions(value) ? null : JSON.stringify(value);
}

function ignoredReferrersColumn(input: string[] | null | undefined): string | null {
  if (!input?.length) return null;
  const { value, problems } = normalizeHostList(input, "ignored_referrers");
  if (problems.length) throw badRequest("Invalid ignored_referrers.", problems.join(" "), problems);
  return value.length ? JSON.stringify(value) : null;
}

function pathRulesColumn(input: PathRule[] | null | undefined): string | null {
  if (!input?.length) return null;
  const { value, problems } = normalizePathRules(input);
  if (problems.length) throw badRequest("Invalid path_rules.", problems.join(" "), problems);
  return value.length ? JSON.stringify(value) : null;
}

function searchParamsColumn(input: string[] | null | undefined): string | null {
  const v = [...new Set(input ?? [])];
  return v.length ? JSON.stringify(v) : null;
}

function contentGroupsColumn(input: { name: string; match: string }[] | null | undefined): string | null {
  if (!input?.length) return null;
  const bad = input.filter((g) => !g.match.startsWith("/"));
  if (bad.length)
    throw badRequest(
      "Invalid content_groups.",
      `match must be a path starting with "/" (got ${bad.map((g) => JSON.stringify(g.match)).join(", ")}).`,
    );
  return JSON.stringify(input.map((g) => ({ name: g.name.trim(), match: g.match.trim() })));
}

const channelGroupsColumn = (v: ChannelGroup[] | null | undefined) => (v?.length ? JSON.stringify(v) : null);

/** The settings columns of `sites` that create and update write, in order (besides id, account_id, timestamps). */
const SETTING_COLUMNS = [
  "domain",
  "name",
  "timezone",
  "visitor_id_mode",
  "retention_days",
  "allowed_hostnames",
  "respect_dnt",
  "exclusions",
  "browser_revenue",
  "browser_user_props",
  "trust_browser_user_id",
  "ignored_referrers",
  "path_rules",
  "redact_pii",
  "search_params",
  "content_groups",
  "currency",
  "session_timeout_minutes",
  "channel_groups",
] as const satisfies readonly (keyof SiteRow)[];

const columnValues = (row: SiteRow) => SETTING_COLUMNS.map((c) => (row[c] ?? null) as string | number | null);

function cleanDomain(input: string): string {
  let d: string;
  try {
    d = normalizeDomain(input);
  } catch {
    throw badRequest(`"${input}" is not a valid domain.`, 'Pass a bare domain like "example.com".');
  }
  // A public suffix (vercel.app, co.uk) would make every site under it "this site's domain".
  if (d !== "localhost" && isPublicSuffix(d))
    throw badRequest(
      `"${d}" is a public suffix, shared by many owners.`,
      'Pass your own hostname, e.g. "myapp.vercel.app" or "example.co.uk".',
    );
  return d;
}

function checkTimezone(tz: string | undefined) {
  if (tz && !isValidTimezone(tz))
    throw badRequest(`Unknown timezone "${tz}".`, 'Use an IANA name such as "UTC", "America/New_York" or "Asia/Kolkata".');
}

function nextSteps(ctx: Ctx, s: SiteRow): string[] {
  return [
    `Add the snippet to every page's <head>: ${scriptSnippet(ctx.baseUrl, s.id)} (framework-specific code: GET /v1/sites/${s.id}/install?framework=nextjs|astro|react|wordpress|gtm|tags).`,
    `Optional but recommended: proxy ${"/_a/*"} on your domain to ${ctx.baseUrl} so tracking is first-party (snippets in install.first_party_proxy).`,
    `Open the site in a browser, then confirm: POST /v1/sites/${s.id}/verify (MCP: verify_install).`,
    `Browser events are accepted from ${s.domain} and its subdomains only; other hostnames (a preview or staging domain) go in allowed_hostnames (PATCH /v1/sites/${s.id}).`,
    `Revenue from the browser tracker (afsa('revenue')) counts only with browser_revenue: true; prefer server events, POST /v1/sites/${s.id}/payments or Stripe.`,
    `Define conversions: POST /v1/sites/${s.id}/goals {"name":"Signup","type":"event","match":"signup"}.`,
    `Read numbers: GET /v1/sites/${s.id}/stats?period=7d&breakdown=channel (MCP: get_stats).`,
  ];
}

export async function createSite(ctx: Ctx, raw: unknown) {
  const input = parse(createSiteInput, raw);
  const domain = cleanDomain(input.domain);
  checkTimezone(input.timezone);
  const standing = await standingOf(ctx);
  const retention = retentionBounds(ctx.env, standing);
  const db = ctx.env.DB;
  const find = () => db.prepare("SELECT * FROM sites WHERE account_id = ? AND domain = ?").bind(ctx.accountId, domain).first<SiteRow>();
  const existing = await find();
  if (existing) {
    return {
      site: siteJson(existing, ctx.baseUrl),
      existing: true,
      note: "A site for this domain already exists on your account; returned unchanged. Use PATCH /v1/sites/:id to change settings.",
      install: installInstructions(existing, ctx.baseUrl, "html", await proxyKeyFor(ctx.env, existing.id)),
      next_steps: nextSteps(ctx, existing),
    };
  }
  checkRetention(input.retention_days, retention);
  // MAX_SITES_PER_ACCOUNT (hosted fair use; UNCLAIMED_ for unclaimed accounts). Unset = no cap.
  const max = siteCap(ctx.env, standing, "MAX_SITES_PER_ACCOUNT", Number.POSITIVE_INFINITY);
  if (Number.isFinite(max)) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE account_id = ?").bind(ctx.accountId).first<{ n: number }>();
    if ((n?.n ?? 0) >= max) {
      throw quotaExceeded(
        `This account already has ${max} sites, the most allowed here.`,
        "Delete a site you no longer need (DELETE /v1/sites/:id), or self-host for more (see /llms.txt).",
      );
    }
  }
  const now = Date.now();
  const row: SiteRow = {
    id: newId("site"),
    account_id: ctx.accountId,
    domain,
    name: input.name ?? null,
    timezone: input.timezone ?? "UTC",
    visitor_id_mode: input.visitor_id_mode ?? "cookieless",
    retention_days: input.retention_days ?? retention.default,
    allowed_hostnames: input.allowed_hostnames?.length ? JSON.stringify(input.allowed_hostnames.map((h) => h.toLowerCase())) : null,
    respect_dnt: input.respect_dnt ? 1 : 0,
    exclusions: exclusionsColumn(input.exclusions),
    browser_revenue: input.browser_revenue ? 1 : 0,
    browser_user_props: input.browser_user_props ? 1 : 0,
    trust_browser_user_id: input.trust_browser_user_id ? 1 : 0,
    ignored_referrers: ignoredReferrersColumn(input.ignored_referrers),
    path_rules: pathRulesColumn(input.path_rules),
    redact_pii: input.redact_pii === false ? 0 : 1,
    search_params: searchParamsColumn(input.search_params),
    content_groups: contentGroupsColumn(input.content_groups),
    session_timeout_minutes: input.session_timeout_minutes ?? null,
    channel_groups: channelGroupsColumn(input.channel_groups),
    currency: input.currency ?? null,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        `INSERT INTO sites (id, account_id, ${SETTING_COLUMNS.join(", ")}, created_at, updated_at)
         VALUES (${Array(SETTING_COLUMNS.length + 4)
           .fill("?")
           .join(", ")})`,
      )
      .bind(row.id, row.account_id, ...columnValues(row), now, now)
      .run();
  } catch (e) {
    // Concurrent create of the same domain: the unique index wins, return the other one.
    const other = await find();
    if (other) {
      const install = installInstructions(other, ctx.baseUrl, "html", await proxyKeyFor(ctx.env, other.id));
      return { site: siteJson(other, ctx.baseUrl), existing: true, install, next_steps: nextSteps(ctx, other) };
    }
    throw e;
  }
  await pushSettings(ctx.env, row);
  const install = installInstructions(row, ctx.baseUrl, "html", await proxyKeyFor(ctx.env, row.id));
  return { site: siteJson(row, ctx.baseUrl), existing: false, install, next_steps: nextSteps(ctx, row) };
}

export async function listSites(ctx: Ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM sites WHERE account_id = ? ORDER BY created_at")
    .bind(ctx.accountId)
    .all<SiteRow>();
  return { sites: results.map((s) => siteJson(s, ctx.baseUrl)) };
}

export async function getSite(ctx: Ctx, siteId: string) {
  const s = await loadSite(ctx, siteId);
  const [summary, standing] = await Promise.all([siteStub(ctx.env, s.id).summary(), standingOf(ctx)]);
  const data = "error" in summary ? null : summary;
  const limits = siteLimits(ctx.env, standing);
  return {
    site: { ...siteJson(s, ctx.baseUrl), effective_retention_days: effectiveRetention(ctx.env, standing, s.retention_days) },
    data,
    limits,
    status: data ? budgetStatus(data, limits) : null,
  };
}

/** Is the site currently refusing events (storage budget, daily limit)? */
export function budgetStatus(
  d: { usage_today?: { events: number; refused: number }; database_bytes?: number },
  l: { events_per_site_per_day: number | null; storage_bytes: number | null },
) {
  const storageFull = l.storage_bytes != null && (d.database_bytes ?? 0) >= l.storage_bytes;
  const dailyLimit = l.events_per_site_per_day != null && (d.usage_today?.events ?? 0) >= l.events_per_site_per_day;
  return {
    storage_full: storageFull,
    daily_limit_reached: dailyLimit,
    database_bytes: d.database_bytes ?? null,
    events_today: d.usage_today?.events ?? 0,
    refused_today: d.usage_today?.refused ?? 0,
  };
}

export async function updateSite(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(updateSiteInput, raw);
  const s = await loadSite(ctx, siteId);
  // replay_site_id makes the tracker load a replay recorder: only the replay service sets it (after
  // checking the replay site is this account's). The same value again is a no-op for anyone.
  const replayChange = input.replay_site_id !== undefined && (input.replay_site_id || null) !== (s.replay_site_id ?? null);
  if (replayChange && ctx.auth.keyId !== INTERNAL_KEY_ID)
    throw new ApiError(
      403,
      "replay_link_from_replay",
      "replay_site_id is set by the replay service, not with an API key (it would make this site's tracker load any recorder).",
      `Link from the replay side: PATCH /v1/sites/<rsite_...> {"analytics_site_id": "${s.id}"} on the replay service (MCP update_replay_site); {"analytics_site_id": null} there unlinks. It links both ways.`,
    );
  checkTimezone(input.timezone);
  if (input.retention_days !== undefined) checkRetention(input.retention_days, retentionBounds(ctx.env, await standingOf(ctx)));
  const next: SiteRow = { ...s, updated_at: Date.now() };
  if (input.domain !== undefined) {
    next.domain = cleanDomain(input.domain);
    if (next.domain !== s.domain) {
      const clash = await ctx.env.DB.prepare("SELECT id FROM sites WHERE account_id = ? AND domain = ? AND id != ?")
        .bind(ctx.accountId, next.domain, s.id)
        .first();
      if (clash) throw badRequest(`Another site on your account already uses ${next.domain}.`, "Delete or rename that site first.");
    }
  }
  if (input.name !== undefined) next.name = input.name;
  if (input.timezone !== undefined) next.timezone = input.timezone;
  if (input.visitor_id_mode !== undefined) next.visitor_id_mode = input.visitor_id_mode;
  if (input.retention_days !== undefined) next.retention_days = input.retention_days;
  if (input.allowed_hostnames !== undefined)
    next.allowed_hostnames = input.allowed_hostnames?.length ? JSON.stringify(input.allowed_hostnames.map((h) => h.toLowerCase())) : null;
  if (input.respect_dnt !== undefined) next.respect_dnt = input.respect_dnt ? 1 : 0;
  if (input.exclusions !== undefined) next.exclusions = exclusionsColumn(input.exclusions);
  if (input.browser_revenue !== undefined) next.browser_revenue = input.browser_revenue ? 1 : 0;
  if (input.browser_user_props !== undefined) next.browser_user_props = input.browser_user_props ? 1 : 0;
  if (input.trust_browser_user_id !== undefined) next.trust_browser_user_id = input.trust_browser_user_id ? 1 : 0;
  if (input.ignored_referrers !== undefined) next.ignored_referrers = ignoredReferrersColumn(input.ignored_referrers);
  if (input.path_rules !== undefined) next.path_rules = pathRulesColumn(input.path_rules);
  if (input.redact_pii !== undefined) next.redact_pii = input.redact_pii ? 1 : 0;
  if (input.search_params !== undefined) next.search_params = searchParamsColumn(input.search_params);
  if (input.content_groups !== undefined) next.content_groups = contentGroupsColumn(input.content_groups);
  if (input.session_timeout_minutes !== undefined) next.session_timeout_minutes = input.session_timeout_minutes ?? null;
  if (input.channel_groups !== undefined) next.channel_groups = channelGroupsColumn(input.channel_groups);
  if (input.currency !== undefined) next.currency = input.currency ?? null;
  if (replayChange) next.replay_site_id = replaySiteColumn(input.replay_site_id ?? null);
  // A new domain has to be proven again (share pages show the domain only while it is).
  const domainChanged = next.domain !== s.domain;
  if (domainChanged) {
    next.verified_at = null;
    next.verify_method = null;
  }
  await ctx.env.DB.prepare(
    `UPDATE sites SET ${SETTING_COLUMNS.map((c) => `${c} = ?`).join(", ")}, replay_site_id = ?, updated_at = ?${domainChanged ? ", verified_at = NULL, verify_method = NULL" : ""}
     WHERE id = ? AND account_id = ?`,
  )
    .bind(...columnValues(next), next.replay_site_id ?? null, next.updated_at, s.id, ctx.accountId)
    .run();
  await pushSettings(ctx.env, next);
  const linked = replayChange && next.replay_site_id;
  return {
    site: siteJson(next, ctx.baseUrl),
    ...(domainChanged && isVerified(s)
      ? { notes: [`The domain changed, so it has to be verified again (POST /v1/sites/${s.id}/verify) before share pages show it.`] }
      : {}),
    ...(linked
      ? {
          note: ctx.env.REPLAY_BASE_URL
            ? `Pages with this site's tracker now load the recorder of replay site ${next.replay_site_id} by themselves (from ${ctx.env.REPLAY_BASE_URL.replace(/\/+$/, "")}): no second snippet. A strict Content-Security-Policy needs script-src and connect-src for that host.`
            : "Linked, but this deployment has no REPLAY_BASE_URL, so the tracker doesn't load the recorder: install the replay snippet on your pages.",
        }
      : {}),
  };
}

/** replay_site_id as stored: an rsite_ id, or null (null or "" clears it). */
function replaySiteColumn(v: string | null): string | null {
  if (v === null || v === "") return null;
  if (!REPLAY_SITE_RE.test(v))
    throw badRequest(
      "replay_site_id must be a replay site id (rsite_ + 16 characters).",
      'Use a replay site id (rsite_..., listed by the replay app\'s GET /v1/sites), or set analytics_site_id to this site on the replay site, which links both ways. {"replay_site_id": null} unlinks.',
    );
  return v;
}

export async function deleteSite(ctx: Ctx, siteId: string, opts: { fetcher?: Fetcher } = {}) {
  const s = await loadSite(ctx, siteId);
  // The Stripe webhook endpoint we created for this site goes with it (best effort, with its key).
  const endpointDeleted = await deleteCreatedEndpoint(ctx.env, s.id, opts.fetcher).catch(() => false);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM goals WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM share_links WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM funnels WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM integrations WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM alerts WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM reports WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM alert_destinations WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM alert_events WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM segments WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM sites WHERE id = ? AND account_id = ?").bind(s.id, ctx.accountId),
  ]);
  await siteStub(ctx.env, s.id).destroy();
  return {
    deleted: s.id,
    ...(endpointDeleted ? { stripe_webhook_endpoint_deleted: true } : {}),
    note: "The site, its goals, funnels, share links, Stripe connection (and the webhook endpoint we created in Stripe), alerts, reports, destinations and their history, segments, annotations, payments and all stored events are gone.",
  };
}

export async function getInstall(ctx: Ctx, siteId: string, framework?: Framework) {
  const s = await loadSite(ctx, siteId);
  return installInstructions(s, ctx.baseUrl, framework ?? "html", await proxyKeyFor(ctx.env, s.id));
}

// ------------------------------------------------------------------ exclusions

export const exclusionsQuery = z.object({
  ip: z.string().max(64).optional().describe("Test: would an event from this IP be dropped?"),
  url: z.string().max(2000).optional().describe("Test: a page URL (hostname + path rules)."),
  country: z.string().max(8).optional().describe("Test: an ISO country code."),
  referrer: z.string().max(2000).optional().describe("Test: a referrer URL or host (ignored back-from-checkout host, spam, excluded)."),
});

/**
 * The site's exclusion rules, what they dropped in the last 7 days, the caller's own IP (to add it
 * to ips), and an optional dry run of the rules against an ip / url / country. Nothing is stored.
 */
export async function getExclusions(ctx: Ctx, siteId: string, raw: unknown, callerIp: string | null) {
  const q = parse(exclusionsQuery, raw);
  const site = await loadSite(ctx, siteId);
  const ex = parseExclusions(site.exclusions) ?? { ips: [], paths: [], hostnames: [], countries: [], referrers: [] };
  const summary = await siteStub(ctx.env, site.id).summary();
  const drops = "error" in summary ? {} : summary.dropped_last_7d;
  let test: Record<string, unknown> | undefined;
  if (q.ip || q.url || q.country || q.referrer) {
    let host: string | null = null;
    let path: string | null = null;
    if (q.url) {
      const page = parsePage(q.url);
      if (!page.hostname) throw badRequest("`url` is not a valid URL.", `Example: url=https://${site.domain}/admin/login`);
      host = page.hostname;
      path = page.pathname;
    }
    const refHost = q.referrer
      ? (parseReferrer(/^[a-z]+:\/\//i.test(q.referrer) ? q.referrer : `https://${q.referrer}`).referrer_host ?? null)
      : null;
    const spam = spamReferrer(refHost);
    const hit =
      excludedBy(compileExclusions(ex), {
        ip: q.ip ?? null,
        hostname: host,
        pathname: path,
        country: q.country ?? null,
        referrer_host: refHost,
      }) ?? (spam ? { reason: "referrer_spam" as const, rule: spam } : null);
    const settings = { redact_pii: site.redact_pii !== 0, path_rules: jsonList<PathRule>(site.path_rules) };
    const cleaned = path ? cleanEvent({ pathname: path, url: null } as unknown as EnrichedEvent, settings) : null;
    test = {
      ip: q.ip ?? null,
      url: q.url ?? null,
      country: q.country ?? null,
      referrer: q.referrer ?? null,
      excluded: !!hit,
      reason: hit?.reason ?? null,
      rule: hit?.rule ?? null,
      ...(cleaned ? { stored_path: cleaned.ev.pathname, path_rule: cleaned.path_rule, redacted: cleaned.redacted } : {}),
      ...(refHost
        ? {
            referrer_host: refHost,
            referrer_ignored: referrerIgnoredBy(refHost, jsonList<string>(site.ignored_referrers)),
            referrer_spam: !!spam,
          }
        : {}),
    };
  }
  return {
    site_id: site.id,
    exclusions: ex,
    dropped_last_7d: Object.fromEntries([...EXCLUSION_REASONS, "referrer_spam"].map((r) => [r, drops[r]?.count ?? 0])),
    your_ip: callerIp,
    ...(test ? { test } : {}),
    notes: [
      'Change the rules with PATCH /v1/sites/:id {"exclusions": {"ips": [...], "paths": [...], "hostnames": [...], "countries": [...]}} (the whole set is replaced).',
      "your_ip is the address this API request came from (an agent's machine may differ from your browser). To exclude only your own browser, set localStorage.afsa_ignore = 1 on the site.",
      "Exclusions apply from now on; stored events are not changed (purge old ones with POST /v1/sites/:id/purge).",
      "The test also runs the site's other ingest rules: stored_path is the path after PII redaction and path_rules; referrer_ignored says whether a referrer counts as none (default = a built-in checkout / sign-in host, site = ignored_referrers); referrer_spam = the built-in spam list.",
    ],
  };
}
