import { ApiError, badRequest, newId, parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import { DEFAULTS, LIMITS, retentionDaysCap, sampleRateCap, sessionMinutesCap } from "../lib/limits";
import { MASK_MODES } from "../lib/mask-rules";
import type { LoaderConfig } from "../lib/protocol";
import { joinSelectors, selectorListProblems } from "../lib/selectors";
import { normalizeDomain } from "../lib/url";
import { ANALYTICS_SITE_RE, analyticsAvailable, checkAnalyticsSite } from "./analytics";
import { type Ctx, forgetSite, jsonList, loadSite, type SiteRow, siteStub } from "./context";
import { type Framework, installInstructions, scriptSnippet } from "./install";

const selectors = (what: string) =>
  z.array(z.string().min(1).max(200)).max(50).optional().describe(`CSS selectors (max 50) ${what}. The whole list is replaced.`);

const hostnamePattern = z
  .string()
  .max(253)
  .regex(/^(\*\.)?[a-z0-9.-]+$/i, "hostname or *.example.com");

export const settingsShape = {
  name: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional().describe("false = the loader records nothing (default true)."),
  sample_rate: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Share of browser sessions recorded, 0..1 (default 1 = all). Capped by the deployment's MAX_SAMPLE_RATE. ?afsr=1 on a page always records.",
    ),
  mask_mode: z
    .enum(MASK_MODES)
    .optional()
    .describe(
      "strict (default): all text masked in the browser, only unmask_selectors shown. balanced: text shown but digits and emails masked. relaxed: text shown except mask_selectors. Inputs are masked in every mode.",
    ),
  unmask_selectors: selectors(
    'whose text is shown as is (e.g. "nav", "button", "h1", "label", "[data-public]"); in strict mode the only text that is',
  ),
  mask_selectors: selectors("whose text is always masked (balanced and relaxed modes)"),
  block_selectors: selectors("never recorded at all (replaced by a same-size placeholder): chat widgets, payment iframes, account details"),
  exclude_paths: z
    .array(z.string().min(1).max(200).regex(/^\//, 'paths start with "/"'))
    .max(50)
    .optional()
    .describe('Path globs never recorded, * = anything (e.g. "/account/*", "/admin*"). The whole list is replaced.'),
  allowed_hostnames: z
    .array(hostnamePattern)
    .max(50)
    .nullable()
    .optional()
    .describe(
      'Extra hostnames chunks may come from besides the domain and its subdomains ("*.example.net" allowed). null = only the domain.',
    ),
  max_session_minutes: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.SESSION_MINUTES_MAX)
    .optional()
    .describe("Recording of a tab stops after this many minutes (default 30). Capped by MAX_SESSION_MINUTES."),
  retention_days: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.RETENTION_DAYS_MAX)
    .optional()
    .describe("Recordings, sessions and signals older than this are deleted hourly (default 30). Capped by MAX_RETENTION_DAYS."),
  heatmap_retention_days: z
    .number()
    .int()
    .min(7)
    .max(LIMITS.HEATMAP_RETENTION_DAYS_MAX)
    .optional()
    .describe("Daily click and scroll aggregates are kept this long (default 180), after recordings are gone."),
  capture_console_errors: z
    .boolean()
    .optional()
    .describe("Record console.error calls as errors (default true). Uncaught errors and unhandled rejections are always recorded."),
  require_consent: z.boolean().optional().describe("Record only after the page calls afsr('consent', true) (default false)."),
  analytics_site_id: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe(
      "Link an AgentFirstStack analytics site (site_...) on the same account: signals and JS errors are forwarded there as events. null unlinks. Needs the deployment's ANALYTICS binding.",
    ),
};

export const createSiteInput = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .describe(
      "The site's domain, e.g. example.com (scheme, path and www. are stripped). Natural key: creating it again returns the existing site.",
    ),
  ...settingsShape,
});
export const updateSiteInput = z.object({ domain: z.string().min(1).max(253).optional(), ...settingsShape });

type Settings = z.infer<typeof updateSiteInput>;

function cleanDomain(input: string): string {
  try {
    return normalizeDomain(input);
  } catch {
    throw badRequest(`"${input}" is not a valid domain.`, 'Pass a bare domain like "example.com".');
  }
}

export function siteJson(s: SiteRow, baseUrl: string, env: Bindings) {
  return {
    id: s.id,
    domain: s.domain,
    name: s.name,
    enabled: !!s.enabled,
    sample_rate: s.sample_rate,
    mask_mode: s.mask_mode,
    unmask_selectors: jsonList(s.unmask_selectors),
    mask_selectors: jsonList(s.mask_selectors),
    block_selectors: jsonList(s.block_selectors),
    exclude_paths: jsonList(s.exclude_paths),
    allowed_hostnames: s.allowed_hostnames ? jsonList(s.allowed_hostnames) : null,
    max_session_minutes: s.max_session_minutes,
    retention_days: s.retention_days,
    heatmap_retention_days: s.heatmap_retention_days,
    capture_console_errors: !!s.capture_console_errors,
    require_consent: !!s.require_consent,
    analytics_site_id: s.analytics_site_id,
    analytics_forwarding: s.analytics_site_id ? (analyticsAvailable(env) ? "on" : "unavailable_on_this_deployment") : "off",
    created_at: s.created_at,
    updated_at: s.updated_at,
    snippet: scriptSnippet(baseUrl, s.id),
  };
}

/** Apply settings to a row, clamping to the deployment's caps. Returns notes about what was clamped. */
async function apply(ctx: Ctx, row: SiteRow, input: Settings): Promise<string[]> {
  const notes: string[] = [];
  const problems = [
    ...selectorListProblems("unmask_selectors", input.unmask_selectors ?? []),
    ...selectorListProblems("mask_selectors", input.mask_selectors ?? []),
    ...selectorListProblems("block_selectors", input.block_selectors ?? []),
  ];
  if (problems.length) throw badRequest("Invalid CSS selectors.", problems.join(" "), problems);
  if (input.name !== undefined) row.name = input.name;
  if (input.enabled !== undefined) row.enabled = input.enabled ? 1 : 0;
  if (input.sample_rate !== undefined) {
    const cap = sampleRateCap(ctx.env);
    row.sample_rate = Math.min(input.sample_rate, cap);
    if (input.sample_rate > cap) notes.push(`sample_rate is capped at ${cap} on this deployment (MAX_SAMPLE_RATE).`);
  }
  if (input.mask_mode !== undefined) row.mask_mode = input.mask_mode;
  if (input.unmask_selectors !== undefined) row.unmask_selectors = JSON.stringify(input.unmask_selectors.map((s) => s.trim()));
  if (input.mask_selectors !== undefined) row.mask_selectors = JSON.stringify(input.mask_selectors.map((s) => s.trim()));
  if (input.block_selectors !== undefined) row.block_selectors = JSON.stringify(input.block_selectors.map((s) => s.trim()));
  if (input.exclude_paths !== undefined) row.exclude_paths = JSON.stringify(input.exclude_paths);
  if (input.allowed_hostnames !== undefined)
    row.allowed_hostnames = input.allowed_hostnames?.length ? JSON.stringify(input.allowed_hostnames.map((h) => h.toLowerCase())) : null;
  if (input.max_session_minutes !== undefined) {
    const cap = sessionMinutesCap(ctx.env);
    row.max_session_minutes = Math.min(input.max_session_minutes, cap);
    if (input.max_session_minutes > cap) notes.push(`max_session_minutes is capped at ${cap} on this deployment (MAX_SESSION_MINUTES).`);
  }
  if (input.retention_days !== undefined) {
    const cap = retentionDaysCap(ctx.env);
    row.retention_days = Math.min(input.retention_days, cap);
    if (input.retention_days > cap) notes.push(`retention_days is capped at ${cap} on this deployment (MAX_RETENTION_DAYS).`);
  }
  if (input.heatmap_retention_days !== undefined) row.heatmap_retention_days = input.heatmap_retention_days;
  if (input.capture_console_errors !== undefined) row.capture_console_errors = input.capture_console_errors ? 1 : 0;
  if (input.require_consent !== undefined) row.require_consent = input.require_consent ? 1 : 0;
  if (input.analytics_site_id !== undefined) {
    if (input.analytics_site_id === null || input.analytics_site_id === "") row.analytics_site_id = null;
    else if (input.analytics_site_id !== row.analytics_site_id) {
      if (!ANALYTICS_SITE_RE.test(input.analytics_site_id))
        throw badRequest(
          "analytics_site_id must be an analytics site id (site_ + 16 characters).",
          "Analytics GET /v1/sites lists them; null unlinks.",
        );
      await checkAnalyticsSite(ctx.env, ctx.accountId, input.analytics_site_id);
      row.analytics_site_id = input.analytics_site_id;
      notes.push(
        "Linked to analytics: rage_click, dead_click, error_click, js_error, quick_back and excessive_scroll events will appear there as they are detected.",
      );
    }
  }
  return notes;
}

function nextSteps(ctx: Ctx, s: SiteRow): string[] {
  return [
    `Add to every page's <head>: ${scriptSnippet(ctx.baseUrl, s.id)} (framework code: GET /v1/sites/${s.id}/install?framework=nextjs|react|astro|wordpress|gtm).`,
    `Open https://${s.domain}/?afsr=1 once (records regardless of sampling), click around, then confirm: POST /v1/sites/${s.id}/verify (MCP: verify_install).`,
    `Text is masked by default (mask_mode strict). Show non-personal UI text with PATCH /v1/sites/${s.id} {"unmask_selectors":["nav","button","a","h1","h2","label"]} so transcripts name what was clicked.`,
    `Read: GET /v1/sites/${s.id}/sessions?sort=frustration, then GET /v1/sites/${s.id}/sessions/<id>/transcript (MCP: search_sessions, get_session_transcript).`,
  ];
}

const COLUMNS = [
  "id",
  "account_id",
  "domain",
  "name",
  "enabled",
  "sample_rate",
  "mask_mode",
  "unmask_selectors",
  "mask_selectors",
  "block_selectors",
  "exclude_paths",
  "allowed_hostnames",
  "max_session_minutes",
  "retention_days",
  "heatmap_retention_days",
  "capture_console_errors",
  "require_consent",
  "analytics_site_id",
  "created_at",
  "updated_at",
] as const;

export async function createSite(ctx: Ctx, raw: unknown) {
  const input = parse(createSiteInput, raw);
  const domain = cleanDomain(input.domain);
  const db = ctx.env.DB;
  const find = () => db.prepare("SELECT * FROM sites WHERE account_id = ? AND domain = ?").bind(ctx.accountId, domain).first<SiteRow>();
  const respond = (s: SiteRow, existing: boolean, notes: string[] = []) => ({
    site: siteJson(s, ctx.baseUrl, ctx.env),
    existing,
    ...(existing
      ? {
          note: "A replay site for this domain already exists on your account; returned unchanged. Use PATCH /v1/sites/:id to change settings.",
        }
      : {}),
    ...(notes.length ? { notes } : {}),
    install: installInstructions(s, ctx.baseUrl, "html"),
    next_steps: nextSteps(ctx, s),
  });
  const existing = await find();
  if (existing) return respond(existing, true);
  const max = Number(ctx.env.MAX_SITES_PER_ACCOUNT || 0);
  if (max > 0) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE account_id = ?").bind(ctx.accountId).first<{ n: number }>();
    if ((n?.n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This account already has ${max} replay sites, the most allowed here.`,
        "Delete a replay site you no longer need (DELETE /v1/sites/:id), or self-host for more (see /llms.txt).",
      );
  }
  const now = Date.now();
  const row: SiteRow = {
    id: newId("rsite"),
    account_id: ctx.accountId,
    domain,
    name: null,
    enabled: 1,
    sample_rate: Math.min(DEFAULTS.SAMPLE_RATE, sampleRateCap(ctx.env)),
    mask_mode: "strict",
    unmask_selectors: "[]",
    mask_selectors: "[]",
    block_selectors: "[]",
    exclude_paths: "[]",
    allowed_hostnames: null,
    max_session_minutes: Math.min(DEFAULTS.MAX_SESSION_MINUTES, sessionMinutesCap(ctx.env)),
    retention_days: Math.min(DEFAULTS.RETENTION_DAYS, retentionDaysCap(ctx.env)),
    heatmap_retention_days: DEFAULTS.HEATMAP_RETENTION_DAYS,
    capture_console_errors: 1,
    require_consent: 0,
    analytics_site_id: null,
    purged_at: null,
    created_at: now,
    updated_at: now,
  };
  const notes = await apply(ctx, row, input);
  try {
    await db
      .prepare(`INSERT INTO sites (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`)
      .bind(...COLUMNS.map((c) => row[c]))
      .run();
  } catch (e) {
    const other = await find(); // concurrent create of the same domain: the unique index wins
    if (other) return respond(other, true);
    throw e;
  }
  return respond(row, false, notes);
}

export async function listSites(ctx: Ctx) {
  const { results } = await ctx.env.DB.prepare("SELECT * FROM sites WHERE account_id = ? ORDER BY created_at LIMIT ?")
    .bind(ctx.accountId, LIMITS.SITES_DEFAULT_LIST)
    .all<SiteRow>();
  return { sites: results.map((s) => siteJson(s, ctx.baseUrl, ctx.env)) };
}

export async function getSite(ctx: Ctx, siteId: string) {
  const s = await loadSite(ctx, siteId);
  return { site: siteJson(s, ctx.baseUrl, ctx.env), data: await siteStub(ctx.env, s.id).summary() };
}

export async function updateSite(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(updateSiteInput, raw);
  const s = await loadSite(ctx, siteId);
  const next: SiteRow = { ...s, updated_at: Date.now() };
  if (input.domain !== undefined) {
    next.domain = cleanDomain(input.domain);
    if (next.domain !== s.domain) {
      const clash = await ctx.env.DB.prepare("SELECT id FROM sites WHERE account_id = ? AND domain = ? AND id != ?")
        .bind(ctx.accountId, next.domain, s.id)
        .first();
      if (clash) throw badRequest(`Another replay site on your account already uses ${next.domain}.`, "Delete or rename that site first.");
    }
  }
  const notes = await apply(ctx, next, input);
  const cols = COLUMNS.filter((c) => c !== "id" && c !== "account_id" && c !== "created_at");
  await ctx.env.DB.prepare(`UPDATE sites SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ? AND account_id = ?`)
    .bind(...cols.map((c) => next[c]), s.id, ctx.accountId)
    .run();
  forgetSite(s.id);
  return {
    site: siteJson(next, ctx.baseUrl, ctx.env),
    ...(notes.length ? { notes } : {}),
    note: "The loader script picks up changes within about 5 minutes (browser cache); already-open tabs keep their settings until reload.",
  };
}

export async function deleteSite(ctx: Ctx, siteId: string) {
  const s = await loadSite(ctx, siteId);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM replay_links WHERE site_id = ?").bind(s.id),
    ctx.env.DB.prepare("DELETE FROM sites WHERE id = ? AND account_id = ?").bind(s.id, ctx.accountId),
    ctx.env.DB.prepare("INSERT OR IGNORE INTO r2_cleanup (prefix, created_at) VALUES (?, ?)").bind(`${s.id}/`, Date.now()),
  ]);
  forgetSite(s.id);
  await siteStub(ctx.env, s.id).destroy();
  return {
    deleted: s.id,
    note: "The replay site, its sessions, signals, heatmaps and share links are gone. Stored recording chunks are deleted from R2 in the background (hourly).",
  };
}

export async function getInstall(ctx: Ctx, siteId: string, framework?: Framework) {
  const s = await loadSite(ctx, siteId);
  return installInstructions(s, ctx.baseUrl, framework ?? "html");
}

/** The config inlined into /r/<site>.js. */
export function loaderConfig(s: SiteRow, env: Bindings, base: string, recorderPath: string): LoaderConfig & { base: string } {
  return {
    site: s.id,
    rec: recorderPath,
    sr: Math.min(s.sample_rate, sampleRateCap(env)),
    mask: s.mask_mode,
    unmask: joinSelectors(jsonList(s.unmask_selectors)),
    maskSel: joinSelectors(jsonList(s.mask_selectors)),
    block: joinSelectors(jsonList(s.block_selectors)),
    ex: jsonList(s.exclude_paths),
    maxMs: Math.min(s.max_session_minutes, sessionMinutesCap(env)) * 60_000,
    idleMs: DEFAULTS.IDLE_MS,
    consent: !!s.require_consent,
    errors: !!s.capture_console_errors,
    on: !!s.enabled,
    base,
  };
}
