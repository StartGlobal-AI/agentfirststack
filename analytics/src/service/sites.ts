import { ApiError, badRequest, newId, parse } from "@afs/shared";
import { z } from "zod";
import { normalizeDomain } from "../lib/url";
import { isValidTimezone } from "../lib/time";
import { type Ctx, type SiteRow, loadSite, pushSettings, siteStub } from "./context";
import { proxyKeyFor } from "./ingest";
import { type Framework, installInstructions, scriptSnippet } from "./install";

const hostnamePattern = z
  .string()
  .max(253)
  .regex(/^(\*\.)?[a-z0-9.-]+$/i, "hostname or *.example.com");

const settingsShape = {
  name: z.string().max(200).nullable().optional(),
  timezone: z.string().max(64).optional().describe("IANA timezone, e.g. Europe/Berlin. Periods and buckets use it. Default UTC."),
  visitor_id_mode: z
    .enum(["cookieless", "persistent"])
    .optional()
    .describe("cookieless (default): daily-salted hash, no storage. persistent: random id in localStorage, links returning visitors."),
  retention_days: z.number().int().min(1).max(3650).optional().describe("Raw events older than this are purged daily. Default 400."),
  allowed_hostnames: z
    .array(hostnamePattern)
    .max(50)
    .nullable()
    .optional()
    .describe('Only accept browser events from these hostnames ("*.example.com" allowed). null = accept any.'),
  respect_dnt: z.boolean().optional().describe("Drop browser events when the visitor sends Global Privacy Control / Do Not Track."),
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
    created_at: s.created_at,
    updated_at: s.updated_at,
    snippet: scriptSnippet(baseUrl, s.id),
  };
}

function cleanDomain(input: string): string {
  try {
    return normalizeDomain(input);
  } catch {
    throw badRequest(`"${input}" is not a valid domain.`, 'Pass a bare domain like "example.com".');
  }
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
    `Define conversions: POST /v1/sites/${s.id}/goals {"name":"Signup","type":"event","match":"signup"}.`,
    `Read numbers: GET /v1/sites/${s.id}/stats?period=7d&breakdown=channel (MCP: get_stats).`,
  ];
}

export async function createSite(ctx: Ctx, raw: unknown) {
  const input = parse(createSiteInput, raw);
  const domain = cleanDomain(input.domain);
  checkTimezone(input.timezone);
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
  // MAX_SITES_PER_ACCOUNT (hosted fair use). Unset = no cap.
  const max = Number(ctx.env.MAX_SITES_PER_ACCOUNT || 0);
  if (max > 0) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE account_id = ?").bind(ctx.accountId).first<{ n: number }>();
    if ((n?.n ?? 0) >= max) {
      throw new ApiError(
        403,
        "quota_exceeded",
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
    retention_days: input.retention_days ?? 400,
    allowed_hostnames: input.allowed_hostnames?.length ? JSON.stringify(input.allowed_hostnames.map((h) => h.toLowerCase())) : null,
    respect_dnt: input.respect_dnt ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  try {
    await db
      .prepare(
        `INSERT INTO sites (id, account_id, domain, name, timezone, visitor_id_mode, retention_days, allowed_hostnames, respect_dnt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const summary = await siteStub(ctx.env, s.id).summary();
  return { site: siteJson(s, ctx.baseUrl), data: "error" in summary ? null : summary };
}

export async function updateSite(ctx: Ctx, siteId: string, raw: unknown) {
  const input = parse(updateSiteInput, raw);
  const s = await loadSite(ctx, siteId);
  checkTimezone(input.timezone);
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
  await ctx.env.DB.prepare(
    `UPDATE sites SET domain = ?, name = ?, timezone = ?, visitor_id_mode = ?, retention_days = ?, allowed_hostnames = ?, respect_dnt = ?, updated_at = ?
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
    ctx.env.DB.prepare("DELETE FROM sites WHERE id = ? AND account_id = ?").bind(s.id, ctx.accountId),
  ]);
  await siteStub(ctx.env, s.id).destroy();
  return { deleted: s.id, note: "The site, its goals, share links and all stored events are gone." };
}

export async function getInstall(ctx: Ctx, siteId: string, framework?: Framework) {
  const s = await loadSite(ctx, siteId);
  return installInstructions(s, ctx.baseUrl, framework ?? "html", await proxyKeyFor(ctx.env, s.id));
}
