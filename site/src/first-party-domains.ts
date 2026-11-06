import { ApiError, accountStanding, badRequest, capFor, conflict, notFound, readJson, requireAuth } from "@afs/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { Bindings, SiteEnv } from "./env";
import { siteBase } from "./google";
import { callService } from "./services";

/**
 * First-party domains: one CNAME on a subdomain of the customer's site (edge.example.com ->
 * fp.agentfirststack.com) that serves the project's analytics (/_a/*), tags (/_t/*) and replay
 * (/_r/*) collection from the site's own domain, with no server code. Ad blockers block requests
 * to analytics.* hosts (filter lists target them); a subdomain of the site with a neutral name
 * isn't on those lists.
 *
 * Built on Cloudflare for SaaS on the deployment's zone: each hostname is a custom hostname
 * (certificate by HTTP validation, once the CNAME is live) plus a Worker route `<hostname>/*` to
 * the site Worker, whose edge (src/first-party.ts firstPartyEdge) forwards the request to the
 * service with the visitor's IP and geo and proof that it is our edge (x-afs-internal +
 * x-afs-edge-host; @afs/shared edgeHost()). The services trust that like a valid proxy key.
 *
 * Needs the secret CF_SAAS_API_TOKEN (Zone: SSL and Certificates Edit, Workers Routes Edit) and the
 * vars CF_SAAS_ZONE_ID, CF_SAAS_FALLBACK_HOST and CF_SAAS_WORKER. Without them every call answers
 * 503 not_configured, and sites use the path proxy (GET /v1/sites/:id/install first_party_proxy).
 */

const CF_API = "https://api.cloudflare.com/client/v4";
/** GET reads a hostname's status from Cloudflare at most this often (D1 last_checked_at, across isolates). */
export const REFRESH_MS = 30_000;
/** The paths the edge serves on a first-party domain, per service. */
export const EDGE_PATHS = { analytics: "/_a", tags: "/_t", replay: "/_r" } as const;

/** Labels filter lists target: a first-party domain named like this gets blocked like analytics.* hosts. */
const TRACKING_LABEL =
  /^(?:analytics?|stats?|statistics|track|tracking|tracker|metrics?|pixels?|tags?|tagging|gtm|collect|collector|telemetry|beacons?)\d*$/;
const NEUTRAL_HINT =
  "Use a subdomain with a neutral name such as edge, go or www2 (edge.example.com); not analytics, stats, track, metrics, pixel, tag or collect: ad blockers' filter lists target those.";

export interface SaasConfig {
  token: string;
  zoneId: string;
  fallbackHost: string;
  worker: string;
}

/** The deployment's Cloudflare for SaaS settings, or null when any is missing (self-hosting without SaaS). */
export function saasConfig(env: Bindings): SaasConfig | null {
  const token = env.CF_SAAS_API_TOKEN?.trim();
  const zoneId = env.CF_SAAS_ZONE_ID?.trim();
  const fallbackHost = env.CF_SAAS_FALLBACK_HOST?.trim().toLowerCase().replace(/\.$/, "");
  const worker = env.CF_SAAS_WORKER?.trim();
  return token && zoneId && fallbackHost && worker ? { token, zoneId, fallbackHost, worker } : null;
}

const notConfigured = () =>
  new ApiError(
    503,
    "not_configured",
    "First-party domains aren't available on this deployment (Cloudflare for SaaS isn't set up).",
    "Serve collection from the site's own domain with the path proxy instead: GET /v1/sites/:id/install on analytics (first_party_proxy) has ready code for Cloudflare Workers, Next.js, Vercel, Netlify and nginx. Operator: docs/self-hosting.md, First-party domains.",
  );

// ---------- the Cloudflare API ----------

interface CfError {
  code: number;
  message: string;
}
interface CfAnswer<T> {
  ok: boolean;
  status: number;
  result: T | null;
  errors: CfError[];
}
interface CfValidationRecord {
  txt_name?: string;
  txt_value?: string;
  http_url?: string;
  http_body?: string;
  cname?: string;
  cname_target?: string;
}
export interface CfCustomHostname {
  id: string;
  hostname: string;
  status?: string;
  ssl?: {
    status?: string;
    method?: string;
    type?: string;
    validation_records?: CfValidationRecord[];
    validation_errors?: { message?: string }[];
  };
  ownership_verification?: { type?: string; name?: string; value?: string };
  verification_errors?: string[];
}
interface CfRoute {
  id: string;
  pattern: string;
  script?: string;
}

async function cf<T>(cfg: SaasConfig, method: string, path: string, body?: unknown): Promise<CfAnswer<T>> {
  try {
    const res = await fetch(`${CF_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: CfError[] } | null;
    return { ok: res.ok && j?.success !== false, status: res.status, result: j?.result ?? null, errors: j?.errors ?? [] };
  } catch (e) {
    console.error("cloudflare api call failed", method, path, e);
    return { ok: false, status: 0, result: null, errors: [{ code: 0, message: "The Cloudflare API didn't answer." }] };
  }
}

const cfMessage = (r: CfAnswer<unknown>) => r.errors.map((e) => e.message).join("; ") || `HTTP ${r.status}`;

/** Cloudflare refused or failed: who can fix it decides the code and hint. */
function cfFailed(what: string, r: CfAnswer<unknown>): ApiError {
  if (r.status === 401 || r.status === 403)
    return new ApiError(
      503,
      "not_configured",
      `Cloudflare refused to ${what}: the deployment's API token lacks a permission (${cfMessage(r)}).`,
      "Operator: CF_SAAS_API_TOKEN needs Zone > SSL and Certificates > Edit and Zone > Workers Routes > Edit on the SaaS zone (docs/self-hosting.md). Meanwhile use the path proxy (analytics GET /v1/sites/:id/install, first_party_proxy).",
    );
  if (r.status >= 400 && r.status < 500 && r.status !== 429)
    return new ApiError(
      400,
      "hostname_refused",
      `Cloudflare refused to ${what}: ${cfMessage(r)}`,
      `Check the hostname (a subdomain of the site that isn't in use for anything else), or pick another one. ${NEUTRAL_HINT}`,
    );
  return new ApiError(
    502,
    "cloudflare_unavailable",
    `Cloudflare didn't ${what} (${cfMessage(r)}).`,
    "Retry in a minute: the call is safe to repeat.",
  );
}

const zonePath = (cfg: SaasConfig, rest: string) => `/zones/${encodeURIComponent(cfg.zoneId)}${rest}`;

/** Create the custom hostname, or adopt the one Cloudflare already has for it (a retry after a partial failure). */
async function createCustomHostname(cfg: SaasConfig, hostname: string): Promise<CfCustomHostname> {
  const r = await cf<CfCustomHostname>(cfg, "POST", zonePath(cfg, "/custom_hostnames"), {
    hostname,
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  });
  if (r.ok && r.result) return r.result;
  const found = await cf<CfCustomHostname[]>(cfg, "GET", zonePath(cfg, `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`));
  const same = found.ok ? found.result?.find((h) => h.hostname === hostname) : undefined;
  if (same) return same;
  throw cfFailed(`add ${hostname} as a custom hostname`, r);
}

/** Route `<hostname>/*` to the site Worker, or adopt the route that already exists. */
async function createRoute(cfg: SaasConfig, hostname: string): Promise<CfRoute> {
  const pattern = `${hostname}/*`;
  const r = await cf<CfRoute>(cfg, "POST", zonePath(cfg, "/workers/routes"), { pattern, script: cfg.worker });
  if (r.ok && r.result) return r.result;
  const all = await cf<CfRoute[]>(cfg, "GET", zonePath(cfg, "/workers/routes"));
  const same = all.ok ? all.result?.find((x) => x.pattern === pattern) : undefined;
  if (same) return same;
  throw cfFailed(`route ${pattern} to the Worker`, r);
}

/** DELETE that treats "already gone" as done. */
async function cfDelete(cfg: SaasConfig, path: string, what: string): Promise<void> {
  const r = await cf<unknown>(cfg, "DELETE", zonePath(cfg, path));
  if (!r.ok && r.status !== 404) throw cfFailed(`remove ${what}`, r);
}

// ---------- rows and status ----------

export type DomainStatus = "pending" | "active" | "failed";

export interface DomainRow {
  hostname: string;
  account_id: string;
  cf_hostname_id: string | null;
  route_id: string | null;
  status: DomainStatus;
  cf_status: string | null;
  ssl_status: string | null;
  records: string | null;
  errors: string | null;
  created_at: number;
  updated_at: number;
  last_checked_at: number | null;
}

interface DnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  value: string;
  required: boolean;
  purpose: string;
}

const FAILED_HOST = new Set(["moved", "deleted", "blocked"]);
const FAILED_SSL = new Set(["validation_timed_out", "issuance_timed_out", "deployment_timed_out", "deactivated", "expired", "deleted"]);

/** Our status from Cloudflare's two: active only when the hostname and its certificate both are. */
export function statusOf(cfStatus: string | null | undefined, sslStatus: string | null | undefined): DomainStatus {
  if ((cfStatus && FAILED_HOST.has(cfStatus)) || (sslStatus && FAILED_SSL.has(sslStatus))) return "failed";
  return cfStatus === "active" && sslStatus === "active" ? "active" : "pending";
}

/** What a custom hostname tells us, as the row's columns. */
function fromCf(h: CfCustomHostname) {
  const records: DnsRecord[] = [];
  const own = h.ownership_verification;
  if (own?.name && own.value && h.status !== "active")
    records.push({
      type: "TXT",
      name: own.name,
      value: own.value,
      required: false,
      purpose: "Optional: proves the hostname is yours before the CNAME is live (pre-validation). Not needed once the CNAME exists.",
    });
  for (const v of h.ssl?.validation_records ?? [])
    if (v.txt_name && v.txt_value && h.ssl?.status !== "active")
      records.push({
        type: "TXT",
        name: v.txt_name,
        value: v.txt_value,
        required: false,
        purpose: "Optional: lets the certificate be issued before the CNAME is live. Not needed once the CNAME exists.",
      });
  const errors = [...(h.verification_errors ?? []), ...(h.ssl?.validation_errors ?? []).map((e) => e.message ?? "").filter(Boolean)].map(
    (e) => String(e).slice(0, 300),
  );
  return {
    cf_hostname_id: h.id,
    cf_status: h.status ?? null,
    ssl_status: h.ssl?.status ?? null,
    status: statusOf(h.status, h.ssl?.status),
    records: JSON.stringify(records),
    errors: JSON.stringify(errors),
  };
}

const parseList = <T>(s: string | null): T[] => {
  try {
    const v = s ? JSON.parse(s) : [];
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

async function rowOf(db: D1Database, hostname: string): Promise<DomainRow | null> {
  return db.prepare("SELECT * FROM first_party_domains WHERE hostname = ?").bind(hostname).first<DomainRow>();
}

/** Re-read the hostname's status from Cloudflare when the last read is older than REFRESH_MS (or always with `force`). */
export async function refreshDomain(env: Bindings, row: DomainRow, opts: { force?: boolean; now?: number } = {}): Promise<DomainRow> {
  const now = opts.now ?? Date.now();
  const cfg = saasConfig(env);
  if (!cfg || !row.cf_hostname_id) return row;
  if (!opts.force && row.last_checked_at && now - row.last_checked_at < REFRESH_MS) return row;
  const r = await cf<CfCustomHostname>(cfg, "GET", zonePath(cfg, `/custom_hostnames/${encodeURIComponent(row.cf_hostname_id)}`));
  let next: DomainRow;
  if (r.ok && r.result) next = { ...row, ...fromCf(r.result), updated_at: now, last_checked_at: now };
  else if (r.status === 404)
    next = {
      ...row,
      status: "failed",
      cf_status: "deleted",
      errors: JSON.stringify(["Cloudflare no longer has this custom hostname. DELETE it here and add it again."]),
      updated_at: now,
      last_checked_at: now,
    };
  else return row; // Cloudflare didn't answer: keep what we knew, try again on the next read
  await env.DB.prepare(
    `UPDATE first_party_domains SET cf_status = ?, ssl_status = ?, status = ?, records = ?, errors = ?, updated_at = ?, last_checked_at = ?
      WHERE hostname = ? AND account_id = ?`,
  )
    .bind(next.cf_status, next.ssl_status, next.status, next.records, next.errors, now, now, row.hostname, row.account_id)
    .run();
  forgetHost(row.hostname);
  return next;
}

// ---------- validation ----------

const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** "edge.example.com" or "https://edge.example.com/" -> "edge.example.com"; null when it isn't a bare hostname. */
export function parseHostname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.length > 300) return null;
  try {
    const u = new URL(s.includes("://") ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.port || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
    const host = u.hostname.replace(/\.$/, "");
    return HOST_RE.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** https://example.com -> https://analytics.example.com (service hosts derive from the apex). */
const serviceUrl = (base: string, svc: string) => {
  const u = new URL(base);
  return `${u.protocol}//${svc}.${u.host}`;
};

const bareDomain = (d: string) =>
  d
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

/** The deployment's own zones: hosts under them can never be a customer's first-party domain. */
function ownZones(env: Bindings, base: string): string[] {
  const zones = [hostOf(base), hostOf(env.PUBLIC_BASE_URL), hostOf(env.AUTH_ISSUER)];
  const fallback = env.CF_SAAS_FALLBACK_HOST?.trim().toLowerCase().replace(/\.$/, "");
  if (fallback?.includes(".")) zones.push(fallback.split(".").slice(1).join("."));
  return [...new Set(zones.filter((z): z is string => !!z && z.includes(".")).map(bareDomain))];
}

interface ProjectResource {
  id: string;
  domain: string;
}
interface ProjectDomains {
  sites: ProjectResource[];
  containers: ProjectResource[];
  replaySites: ProjectResource[];
  /** a service that's bound but didn't answer: its domains are unknown */
  unreadable: string[];
}

/** The project's analytics sites, tag containers and replay sites (only the services this deployment runs). */
async function projectDomains(env: Bindings, accountId: string): Promise<ProjectDomains> {
  const read = async (svc: "analytics" | "tags" | "replay", path: string, key: "sites" | "containers") => {
    const binding = { analytics: env.ANALYTICS, tags: env.TAGS, replay: env.REPLAY }[svc];
    if (!binding) return { list: [] as ProjectResource[], ok: true };
    const r = await callService<Record<string, ProjectResource[] | undefined>>(env, svc, accountId, path);
    return { list: r.ok ? (r.json?.[key] ?? []) : [], ok: r.ok };
  };
  const [a, t, r] = await Promise.all([
    read("analytics", "/v1/sites", "sites"),
    read("tags", "/v1/containers", "containers"),
    read("replay", "/v1/sites", "sites"),
  ]);
  const unreadable = [!a.ok && "analytics", !t.ok && "tags", !r.ok && "replay"].filter((x): x is string => !!x);
  return { sites: a.list, containers: t.list, replaySites: r.list, unreadable };
}

/** Is `hostname` a subdomain (not the site's own host) of `domain`? */
const under = (hostname: string, domain: string) => {
  const base = bareDomain(domain);
  return base.includes(".") && hostname.endsWith(`.${base}`) && hostname !== `www.${base}`;
};

const allDomains = (p: ProjectDomains) => [
  ...new Set([...p.sites, ...p.containers, ...p.replaySites].map((x) => x.domain.trim().toLowerCase().replace(/\.$/, ""))),
];

/** Refusals for a hostname that isn't a subdomain of the project's sites, or is one of ours. */
function checkHostname(env: Bindings, base: string, hostname: string, project: ProjectDomains) {
  const zone = ownZones(env, base).find((z) => hostname === z || hostname.endsWith(`.${z}`));
  if (zone)
    throw badRequest(
      `${hostname} is on this platform's own domain (${zone}).`,
      `A first-party domain is a subdomain of the customer's site, e.g. edge.example.com for example.com. ${NEUTRAL_HINT}`,
    );
  const domains = allDomains(project);
  if (domains.some((d) => hostname === d || hostname === `www.${bareDomain(d)}` || hostname === bareDomain(d)))
    throw badRequest(
      `${hostname} is the website itself.`,
      `Use a new subdomain of it that serves nothing else, e.g. edge.${bareDomain(hostname)}: it gets a CNAME to this platform. ${NEUTRAL_HINT}`,
    );
  if (!domains.some((d) => under(hostname, d))) {
    if (project.unreadable.length)
      throw new ApiError(
        502,
        "service_unavailable",
        `Couldn't read the project's ${project.unreadable.join(" and ")} to check that ${hostname} belongs to one of its sites.`,
        "Retry in a minute: the call is safe to repeat.",
      );
    throw badRequest(
      domains.length
        ? `${hostname} isn't a subdomain of this project's websites (${domains.slice(0, 5).join(", ")}).`
        : "This project has no website yet: a first-party domain is a subdomain of one of its sites.",
      domains.length
        ? `Use a subdomain of one of them, e.g. edge.${bareDomain(domains[0]!)}. ${NEUTRAL_HINT}`
        : `Create the analytics site first (POST ${serviceUrl(base, "analytics")}/v1/sites {"domain":"example.com"}), then add edge.example.com here.`,
    );
  }
}

// ---------- answers ----------

interface Ctx {
  env: Bindings;
  accountId: string;
  /** The site's public URL (PUBLIC_BASE_URL or the request origin). */
  base: string;
}

/** The snippets that use the hostname, for the project's resources on that site. */
function snippetsFor(hostname: string, p: ProjectDomains) {
  const on = (x: ProjectResource) => under(hostname, x.domain);
  const h = `https://${hostname}`;
  return {
    analytics: p.sites.filter(on).map((s) => ({
      site_id: s.id,
      domain: s.domain,
      snippet: `<script defer src="${h}${EDGE_PATHS.analytics}/s.js" data-site="${s.id}"></script>`,
    })),
    tags: p.containers.filter(on).map((c) => ({
      container_id: c.id,
      domain: c.domain,
      snippet: `<script async src="${h}${EDGE_PATHS.tags}/c/${c.id}.js"></script>`,
    })),
    replay: {
      note: `Nothing to paste on pages with the analytics tracker loaded from ${hostname}: it loads the linked replay site's recorder from ${h}${EDGE_PATHS.replay}/ by itself. Only pages without the tracker use a replay snippet.`,
      sites: p.replaySites.filter(on).map((r) => ({
        replay_site_id: r.id,
        domain: r.domain,
        snippet: `<script defer src="${h}${EDGE_PATHS.replay}/r/${r.id}.js"></script>`,
      })),
    },
  };
}

export function domainJson(row: DomainRow, cfg: SaasConfig | null) {
  const extra = parseList<DnsRecord>(row.records);
  const target = cfg?.fallbackHost ?? "<this deployment's fallback host>";
  const dns: DnsRecord[] = [
    {
      type: "CNAME",
      name: row.hostname,
      value: target,
      required: true,
      purpose: "Routes the hostname to AgentFirstStack. If the site's DNS is on Cloudflare, DNS only (grey cloud) is simplest.",
    },
    ...extra,
  ];
  const h = `https://${row.hostname}`;
  return {
    hostname: row.hostname,
    status: row.status,
    hostname_status: row.cf_status,
    ssl_status: row.ssl_status,
    dns_records: dns,
    errors: parseList<string>(row.errors),
    serves: { analytics: `${h}${EDGE_PATHS.analytics}/*`, tags: `${h}${EDGE_PATHS.tags}/*`, replay: `${h}${EDGE_PATHS.replay}/*` },
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_checked_at: row.last_checked_at,
  };
}

function nextSteps(base: string, row: DomainRow, cfg: SaasConfig | null): string[] {
  const h = row.hostname;
  const swap = `Swap the snippets on every page to load from ${h} (snippets below: analytics <script defer src="https://${h}${EDGE_PATHS.analytics}/s.js" data-site="site_...">, tags <script async src="https://${h}${EDGE_PATHS.tags}/c/ctr_....js">; replay follows the analytics tracker), deploy, and open a page once.`;
  const check = `Then GET ${base}/v1/setup (MCP afs_check_setup): analytics.first_party passes once browser events arrive through ${h}.`;
  if (row.status === "active") return [`${h} is active.`, swap, check];
  const errors = parseList<string>(row.errors);
  if (row.status === "failed")
    return [
      `Cloudflare reports a problem with ${h}${errors.length ? `: ${errors.join("; ")}` : ` (hostname ${row.cf_status ?? "?"}, certificate ${row.ssl_status ?? "?"})`}.`,
      `Check the DNS record: CNAME ${h} -> ${cfg?.fallbackHost ?? "the fallback host"} (and no other A, AAAA or CNAME record for ${h}), then DELETE ${base}/v1/first-party-domains/${h} and POST it again.`,
      "Until then keep the snippets the pages use now.",
    ];
  return [
    `Add the DNS record at the site's DNS provider: CNAME ${h} -> ${cfg?.fallbackHost ?? "the fallback host"} (dns_records). If you can't change DNS, give the owner this one record to add, and keep the current snippets until it is active.`,
    `Then GET ${base}/v1/first-party-domains/${h} (MCP afs_list_first_party_domains) every minute or so until status is "active": usually a few minutes after the record is live, while Cloudflare issues the certificate.`,
    swap,
    check,
  ];
}

// ---------- the operations (REST and MCP) ----------

export const addDomainInput = z.object({
  hostname: z
    .string()
    .min(1)
    .max(300)
    .describe("A new subdomain of one of the project's websites, e.g. edge.example.com (not the website itself, not analytics.*)."),
});

/** POST /v1/first-party-domains: create (201), or return this project's existing one (200, existing: true). */
export async function addFirstPartyDomain(ctx: Ctx, raw: unknown) {
  const input = addDomainInput.safeParse(raw);
  const hostname = input.success ? parseHostname(input.data.hostname) : null;
  if (!hostname)
    throw badRequest(
      "`hostname` must be a bare hostname, like edge.example.com.",
      `Send {"hostname":"edge.example.com"}: a subdomain of the website. ${NEUTRAL_HINT}`,
    );
  const { env, accountId } = ctx;
  const cfg = saasConfig(env);
  const existing = await rowOf(env.DB, hostname);
  if (existing && existing.account_id !== accountId)
    throw conflict(
      `${hostname} is already a first-party domain of another project.`,
      "If it's yours, remove it there first (DELETE /v1/first-party-domains/:hostname with that project's key), or use another subdomain.",
    );
  if (existing) {
    const row = await refreshDomain(env, existing);
    return { status: 200 as const, body: await answer(ctx, row, cfg, true) };
  }
  if (!cfg) throw notConfigured();
  const project = await projectDomains(env, accountId);
  checkHostname(env, ctx.base, hostname, project);
  // MAX_FIRST_PARTY_DOMAINS_PER_ACCOUNT (UNCLAIMED_ for projects nobody claimed). Unset = no cap.
  const max = capFor(
    env as unknown as Record<string, unknown>,
    await accountStanding(env, accountId),
    "MAX_FIRST_PARTY_DOMAINS_PER_ACCOUNT",
    Infinity,
  );
  if (Number.isFinite(max)) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM first_party_domains WHERE account_id = ?").bind(accountId).first<number>("n");
    if ((n ?? 0) >= max)
      throw new ApiError(
        403,
        "quota_exceeded",
        `This project already has ${max} first-party domain${max === 1 ? "" : "s"}, the most allowed here.`,
        "One first-party domain serves analytics, tags and replay for a site; remove one you no longer use (DELETE /v1/first-party-domains/:hostname), or self-host for more.",
      );
  }
  // Claim the hostname first: of two concurrent creates, the primary key lets one through.
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `INSERT INTO first_party_domains (hostname, account_id, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)
     ON CONFLICT(hostname) DO NOTHING`,
  )
    .bind(hostname, accountId, now, now)
    .run();
  if (!claimed.meta.changes) return addFirstPartyDomain(ctx, raw); // lost the race: answer as a retry would
  let custom: CfCustomHostname;
  let route: CfRoute;
  try {
    custom = await createCustomHostname(cfg, hostname);
    try {
      route = await createRoute(cfg, hostname);
    } catch (e) {
      await cfDelete(cfg, `/custom_hostnames/${encodeURIComponent(custom.id)}`, "the custom hostname").catch(() => {});
      throw e;
    }
  } catch (e) {
    await env.DB.prepare("DELETE FROM first_party_domains WHERE hostname = ? AND account_id = ?").bind(hostname, accountId).run();
    throw e;
  }
  const cols = fromCf(custom);
  const row: DomainRow = {
    hostname,
    account_id: accountId,
    ...cols,
    route_id: route.id,
    created_at: now,
    updated_at: now,
    last_checked_at: now,
  };
  await env.DB.prepare(
    `UPDATE first_party_domains SET cf_hostname_id = ?, route_id = ?, status = ?, cf_status = ?, ssl_status = ?, records = ?, errors = ?,
       updated_at = ?, last_checked_at = ? WHERE hostname = ? AND account_id = ?`,
  )
    .bind(
      row.cf_hostname_id,
      row.route_id,
      row.status,
      row.cf_status,
      row.ssl_status,
      row.records,
      row.errors,
      now,
      now,
      hostname,
      accountId,
    )
    .run();
  forgetHost(hostname);
  return { status: 201 as const, body: await answer(ctx, row, cfg, false, project) };
}

async function answer(ctx: Ctx, row: DomainRow, cfg: SaasConfig | null, existing: boolean, project?: ProjectDomains) {
  const p = project ?? (await projectDomains(ctx.env, ctx.accountId));
  const label = row.hostname.split(".")[0] ?? "";
  return {
    first_party_domain: domainJson(row, cfg),
    existing,
    ...(existing ? { note: "This project already has this first-party domain; returned with its current status." } : {}),
    ...(TRACKING_LABEL.test(label)
      ? {
          warning: `"${label}" is a name ad blockers' filter lists target, so ${row.hostname} may be blocked like analytics.* hosts. ${NEUTRAL_HINT}`,
        }
      : {}),
    snippets: snippetsFor(row.hostname, p),
    next_steps: nextSteps(ctx.base, row, cfg),
  };
}

/** GET /v1/first-party-domains: the project's domains, each refreshed from Cloudflare when its last read is over 30 s old. */
export async function listFirstPartyDomains(ctx: Ctx) {
  const cfg = saasConfig(ctx.env);
  const { results } = await ctx.env.DB.prepare("SELECT * FROM first_party_domains WHERE account_id = ? ORDER BY created_at")
    .bind(ctx.accountId)
    .all<DomainRow>();
  const rows = await Promise.all(results.map((r) => refreshDomain(ctx.env, r)));
  const pending = rows.filter((r) => r.status !== "active");
  return {
    first_party_domains: rows.map((r) => domainJson(r, cfg)),
    available: !!cfg,
    next_steps: rows.length
      ? pending.length
        ? pending.flatMap((r) => nextSteps(ctx.base, r, cfg).slice(0, 2))
        : [`All active. Pages should load the snippets from them; GET ${ctx.base}/v1/setup checks that browser events arrive through them.`]
      : cfg
        ? [
            `Add one: POST ${ctx.base}/v1/first-party-domains {"hostname":"edge.example.com"} (MCP afs_add_first_party_domain): a subdomain of the website, then one CNAME. ${NEUTRAL_HINT}`,
          ]
        : [
            "First-party domains aren't available on this deployment: use the path proxy (analytics GET /v1/sites/:id/install, first_party_proxy).",
          ],
  };
}

async function ownRow(ctx: Ctx, raw: string): Promise<DomainRow> {
  const hostname = parseHostname(raw);
  const row = hostname ? await rowOf(ctx.env.DB, hostname) : null;
  if (!row || row.account_id !== ctx.accountId)
    throw notFound(`First-party domain ${hostname ?? raw}`, "GET /v1/first-party-domains lists this project's first-party domains.");
  return row;
}

/** GET /v1/first-party-domains/:hostname */
export async function getFirstPartyDomain(ctx: Ctx, raw: string) {
  const row = await refreshDomain(ctx.env, await ownRow(ctx, raw));
  const { existing: _e, note: _n, ...body } = await answer(ctx, row, saasConfig(ctx.env), true);
  return body;
}

/** DELETE /v1/first-party-domains/:hostname: the route and custom hostname in Cloudflare, then the row. */
export async function removeFirstPartyDomain(ctx: Ctx, raw: string) {
  const row = await ownRow(ctx, raw);
  await deleteInCloudflare(ctx.env, row);
  await ctx.env.DB.prepare("DELETE FROM first_party_domains WHERE hostname = ? AND account_id = ?").bind(row.hostname, ctx.accountId).run();
  forgetHost(row.hostname);
  return {
    deleted: row.hostname,
    next_steps: [
      `Pages that still load scripts from https://${row.hostname}/ stop being tracked: switch them to the path proxy or another first-party domain first (analytics GET /v1/sites/:id/install, first_party).`,
      `Remove the DNS record CNAME ${row.hostname} from the site's DNS.`,
    ],
  };
}

async function deleteInCloudflare(env: Bindings, row: DomainRow): Promise<void> {
  if (!row.route_id && !row.cf_hostname_id) return;
  const cfg = saasConfig(env);
  if (!cfg) throw notConfigured();
  if (row.route_id) await cfDelete(cfg, `/workers/routes/${encodeURIComponent(row.route_id)}`, "the Worker route");
  if (row.cf_hostname_id) await cfDelete(cfg, `/custom_hostnames/${encodeURIComponent(row.cf_hostname_id)}`, "the custom hostname");
}

/** A purged project's first-party domains: removed from Cloudflare (best effort) and forgotten. */
export async function purgeFirstPartyDomains(env: Bindings, accountId: string): Promise<number> {
  const { results } = await env.DB.prepare("SELECT * FROM first_party_domains WHERE account_id = ?").bind(accountId).all<DomainRow>();
  for (const row of results) {
    await deleteInCloudflare(env, row).catch((e) =>
      console.error(JSON.stringify({ event: "first_party_domain.purge_failed", hostname: row.hostname, error: String(e) })),
    );
    forgetHost(row.hostname);
  }
  if (results.length) await env.DB.prepare("DELETE FROM first_party_domains WHERE account_id = ?").bind(accountId).run();
  return results.length;
}

/** The project's first-party domains as stored (no Cloudflare read), for the setup check. */
export async function storedDomains(env: Bindings, accountId: string): Promise<DomainRow[] | null> {
  try {
    const { results } = await env.DB.prepare("SELECT * FROM first_party_domains WHERE account_id = ? ORDER BY created_at")
      .bind(accountId)
      .all<DomainRow>();
    return results;
  } catch {
    return null; // a deployment that hasn't applied the migration yet
  }
}

// ---------- the edge's host lookup ----------

export interface EdgeHost {
  hostname: string;
  account_id: string;
  status: DomainStatus;
}
const HOST_TTL_MS = 60_000;
const MAX_HOSTS = 5_000;
const hosts = new Map<string, { at: number; row: EdgeHost | null }>();

/** Forget the edge's cached lookup of a hostname (after it was added, refreshed or removed in this isolate). */
export function forgetHost(hostname: string): void {
  hosts.delete(hostname);
}

/**
 * The first-party domain a request's Host names, or null. Cached in memory for a minute, misses
 * too, so the platform's own pages cost no D1 read (their hosts are skipped before this anyway).
 */
export async function lookupHost(env: Bindings, hostname: string, now = Date.now()): Promise<EdgeHost | null> {
  const hit = hosts.get(hostname);
  if (hit && now - hit.at < HOST_TTL_MS) return hit.row;
  let row: EdgeHost | null = null;
  try {
    row = await env.DB.prepare("SELECT hostname, account_id, status FROM first_party_domains WHERE hostname = ?")
      .bind(hostname)
      .first<EdgeHost>();
  } catch (e) {
    console.error("first-party host lookup failed", e);
    return null; // not cached: the next request asks again
  }
  if (hosts.size >= MAX_HOSTS) hosts.delete(hosts.keys().next().value as string);
  hosts.set(hostname, { at: now, row });
  return row;
}

/** The platform's own hosts (the apex and its subdomains): never a first-party domain, never looked up. */
export function isPlatformHost(env: Bindings, hostname: string): boolean {
  for (const u of [env.PUBLIC_BASE_URL, env.AUTH_ISSUER, env.USER_CONTENT_BASE_URL]) {
    const h = hostOf(u);
    if (!h) continue;
    const apex = bareDomain(h);
    if (hostname === apex || hostname.endsWith(`.${apex}`)) return true;
  }
  return hostname === "localhost" || hostname.endsWith(".workers.dev") || /^[\d.]+$/.test(hostname) || hostname.includes(":");
}

// ---------- REST ----------

export const firstPartyDomainsApi = new Hono<SiteEnv>();
firstPartyDomainsApi.use("/v1/first-party-domains", requireAuth<SiteEnv>());
firstPartyDomainsApi.use("/v1/first-party-domains/*", requireAuth<SiteEnv>());
const ctxOf = (c: { env: Bindings; var: { auth: { accountId: string } }; req: { url: string } }): Ctx => ({
  env: c.env,
  accountId: c.var.auth.accountId,
  base: siteBase(c),
});

firstPartyDomainsApi.post("/v1/first-party-domains", async (c) => {
  const r = await addFirstPartyDomain(ctxOf(c), await readJson(c, z.unknown()));
  return c.json(r.body, r.status);
});
firstPartyDomainsApi.get("/v1/first-party-domains", async (c) => c.json(await listFirstPartyDomains(ctxOf(c))));
firstPartyDomainsApi.get("/v1/first-party-domains/:hostname", async (c) =>
  c.json(await getFirstPartyDomain(ctxOf(c), c.req.param("hostname"))),
);
firstPartyDomainsApi.delete("/v1/first-party-domains/:hostname", async (c) =>
  c.json(await removeFirstPartyDomain(ctxOf(c), c.req.param("hostname"))),
);
