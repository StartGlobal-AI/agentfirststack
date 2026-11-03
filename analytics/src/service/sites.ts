import { type Standing, accountStanding, badRequest, capFor, newId, parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { isPublicSuffix, isPublicSuffixWildcard, normalizeDomain } from "../lib/url";
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
import { type Ctx, type SiteRow, loadSite, parseExclusions, pushSettings, siteStub } from "./context";
import { proxyKeyFor } from "./ingest";
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
  browser_revenue: z
    .boolean()
    .optional()
    .describe(
      "Count revenue sent from the browser (afsa('revenue', ...)). Default false: anyone can send browser events, so revenue should come from your server (track_events, payments, Stripe).",
    ),
  trust_browser_user_id: z
    .boolean()
    .optional()
    .describe(
      "Let user ids from afsa('identify', id) link payments that carry only a user id (metadata.afs_user_id / client_reference_id). Default false: only user ids sent by your server (track_events user_id) link payments, so nobody can pre-seed another user's attribution.",
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
    })
    .nullable()
    .optional()
    .describe(
      "Drop matching events at ingest (from now on; stored data is not changed). Replaces the whole set; null clears it. Drops are counted per reason (excluded_ip, excluded_path, excluded_hostname, excluded_country); IPs are compared in memory, never stored.",
    ),
};

export const createSiteInput = z.object({
  domain: z.string().min(1).max(253).describe("The site's domain, e.g. example.com (scheme, path and www. are stripped)."),
  ...settingsShape,
});
export const updateSiteInput = z.object({ domain: z.string().min(1).max(253).optional(), ...settingsShape });

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
    trust_browser_user_id: !!s.trust_browser_user_id,
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
    trust_browser_user_id: input.trust_browser_user_id ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        `INSERT INTO sites (id, account_id, domain, name, timezone, visitor_id_mode, retention_days, allowed_hostnames, respect_dnt, exclusions,
           browser_revenue, trust_browser_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.account_id,
        row.domain,
        row.name,
        row.timezone,
        row.visitor_id_mode,
        row.retention_days,
        row.allowed_hostnames,
        row.respect_dnt,
        row.exclusions ?? null,
        row.browser_revenue ?? 0,
        row.trust_browser_user_id ?? 0,
        now,
        now,
      )
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
  if (input.trust_browser_user_id !== undefined) next.trust_browser_user_id = input.trust_browser_user_id ? 1 : 0;
  await ctx.env.DB.prepare(
    `UPDATE sites SET domain = ?, name = ?, timezone = ?, visitor_id_mode = ?, retention_days = ?, allowed_hostnames = ?, respect_dnt = ?, exclusions = ?,
       browser_revenue = ?, trust_browser_user_id = ?, updated_at = ?
     WHERE id = ? AND account_id = ?`,
  )
    .bind(
      next.domain,
      next.name,
      next.timezone,
      next.visitor_id_mode,
      next.retention_days,
      next.allowed_hostnames,
      next.respect_dnt,
      next.exclusions ?? null,
      next.browser_revenue ?? 0,
      next.trust_browser_user_id ?? 0,
      next.updated_at,
      s.id,
      ctx.accountId,
    )
    .run();
  await pushSettings(ctx.env, next);
  return { site: siteJson(next, ctx.baseUrl) };
}

export async function deleteSite(ctx: Ctx, siteId: string) {
  const s = await loadSite(ctx, siteId);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM goals WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM share_links WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM funnels WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM integrations WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM sites WHERE id = ? AND account_id = ?").bind(s.id, ctx.accountId),
  ]);
  await siteStub(ctx.env, s.id).destroy();
  return {
    deleted: s.id,
    note: "The site, its goals, funnels, share links, Stripe connection, annotations, payments and all stored events are gone.",
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
});

/**
 * The site's exclusion rules, what they dropped in the last 7 days, the caller's own IP (to add it
 * to ips), and an optional dry run of the rules against an ip / url / country. Nothing is stored.
 */
export async function getExclusions(ctx: Ctx, siteId: string, raw: unknown, callerIp: string | null) {
  const q = parse(exclusionsQuery, raw);
  const site = await loadSite(ctx, siteId);
  const ex = parseExclusions(site.exclusions) ?? { ips: [], paths: [], hostnames: [], countries: [] };
  const summary = await siteStub(ctx.env, site.id).summary();
  const drops = "error" in summary ? {} : summary.dropped_last_7d;
  let test: Record<string, unknown> | undefined;
  if (q.ip || q.url || q.country) {
    let host: string | null = null;
    let path: string | null = null;
    if (q.url) {
      try {
        const u = new URL(q.url);
        host = u.hostname.toLowerCase();
        path = u.pathname;
      } catch {
        throw badRequest("`url` is not a valid URL.", `Example: url=https://${site.domain}/admin/login`);
      }
    }
    const hit = excludedBy(compileExclusions(ex), { ip: q.ip ?? null, hostname: host, pathname: path, country: q.country ?? null });
    test = {
      ip: q.ip ?? null,
      url: q.url ?? null,
      country: q.country ?? null,
      excluded: !!hit,
      reason: hit?.reason ?? null,
      rule: hit?.rule ?? null,
    };
  }
  return {
    site_id: site.id,
    exclusions: ex,
    dropped_last_7d: Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, drops[r]?.count ?? 0])),
    your_ip: callerIp,
    ...(test ? { test } : {}),
    notes: [
      'Change the rules with PATCH /v1/sites/:id {"exclusions": {"ips": [...], "paths": [...], "hostnames": [...], "countries": [...]}} (the whole set is replaced).',
      "your_ip is the address this API request came from (an agent's machine may differ from your browser). To exclude only your own browser, set localStorage.afsa_ignore = 1 on the site.",
      "Exclusions apply from now on; stored events are not changed.",
    ],
  };
}
