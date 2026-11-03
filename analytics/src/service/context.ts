import { ApiError, accountSuspended, notFound } from "@afs/shared";
import type { Bindings } from "../env";
import type { Breakdown } from "../lib/filters";
import type {
  DoError,
  EnrichedEvent,
  FunnelRequest,
  Goal,
  IngestResponse,
  PaymentInput,
  PaymentOutcome,
  SiteSettings,
  StatsRequest,
  TimeseriesRequest,
  VisitorIdMode,
} from "../lib/types";
import { isDoError } from "../lib/types";
import type { Exclusions } from "../lib/exclusions";
import type { IngestPolicy } from "../do/site-do";

/** What every service call needs: bindings, the caller's account, and the public base URL. */
export interface Ctx {
  env: Bindings;
  accountId: string;
  baseUrl: string;
  /** cf-connecting-ip of the API request (get_exclusions shows it as your_ip); never stored */
  callerIp?: string | null;
}

/** D1 row of `sites`. */
export interface SiteRow {
  id: string;
  account_id: string;
  domain: string;
  name: string | null;
  timezone: string;
  visitor_id_mode: VisitorIdMode;
  retention_days: number;
  allowed_hostnames: string | null;
  respect_dnt: number;
  /** JSON Exclusions; NULL = none (column added in migration 0005) */
  exclusions?: string | null;
  /** 1 = count revenue the browser tracker sends (migration 0007; default 0) */
  browser_revenue?: number;
  /** 1 = user ids from afsa('identify') may link payments (migration 0007; default 0) */
  trust_browser_user_id?: number;
  created_at: number;
  updated_at: number;
}

type Obj = Record<string, unknown>;

/** The RPC surface of SiteDO, typed loosely (results are plain JSON objects). */
export interface SiteStub {
  configure(s: SiteSettings): Promise<{ ok: true }>;
  ingest(events: EnrichedEvent[], policy?: IngestPolicy): Promise<IngestResponse>;
  recordDrop(reason: string, sample: string | null): Promise<void>;
  stats(q: StatsRequest): Promise<Obj | DoError>;
  breakdown(q: StatsRequest & { breakdown: Breakdown }): Promise<Obj | DoError>;
  timeseries(q: TimeseriesRequest): Promise<Obj | DoError>;
  realtime(): Promise<Obj | DoError>;
  funnel(q: FunnelRequest): Promise<Obj | DoError>;
  sql(q: string, opts?: { budgetMs?: number }): Promise<Obj | DoError>;
  chargeSql(ms: number, budgetMs: number): Promise<void>;
  summary(): Promise<SiteSummary | DoError>;
  destroy(): Promise<{ ok: true }>;
  movers(q: Obj): Promise<Obj | DoError>;
  insights(q: Obj): Promise<Obj | DoError>;
  visitors(q: Obj): Promise<Obj | DoError>;
  visitor(key: string, limit?: number): Promise<Obj | DoError>;
  session(id: string): Promise<Obj | DoError>;
  journeys(q: Obj): Promise<Obj | DoError>;
  ingestPayments(records: PaymentInput[], policy?: IngestPolicy): Promise<{ results: PaymentOutcome[] } | DoError>;
  listPayments(q: Obj): Promise<Obj | DoError>;
  deletePayment(id: string): Promise<Obj | DoError>;
  paymentsSummary(): Promise<PaymentsSummary | DoError>;
  createAnnotation(a: Obj, max: number | null): Promise<Obj | DoError>;
  listAnnotations(q: Obj): Promise<Obj | DoError>;
  updateAnnotation(id: string, p: Obj): Promise<Obj | DoError>;
  deleteAnnotation(id: string): Promise<Obj | DoError>;
  schemaVersion(): Promise<number>;
}

export interface PaymentsSummary {
  payments_30d: number;
  unlinked_30d: number;
  test_mode_30d: number;
  last_payment_at: number | null;
}

export interface DropCount {
  count: number;
  last_at: number | null;
  /** exclusion drops only: the site's own rule that matched */
  rule?: string | null;
}

export interface SiteSummary {
  total_events: number;
  events_last_24h: number;
  browser_events: number;
  server_events: number;
  payment_events?: number;
  first_event_at: number | null;
  last_event_at: number | null;
  dropped_last_7d: Record<string, DropCount>;
  warnings_last_7d: Record<string, DropCount>;
  usage_today?: { day: string; events: number; bytes: number; refused: number };
  database_bytes?: number;
  /** strings visitors (or anyone with the public site id) sent: never interpolated into other fields */
  untrusted: {
    notice: string;
    last_event: Obj | null;
    hostnames_last_7d: { hostname: string | null; events: number }[];
    drop_samples: Record<string, string>;
    warning_samples: Record<string, string>;
  };
}

export function siteStub(env: Bindings, siteId: string): SiteStub {
  return env.SITE.get(env.SITE.idFromName(siteId)) as unknown as SiteStub;
}

export const SITE_ID_RE = /^site_[0-9a-z]{16}$/;

export async function loadSite(ctx: Ctx, siteId: string): Promise<SiteRow> {
  if (!SITE_ID_RE.test(siteId)) throw notFound("Site", "Site ids look like site_xxxxxxxxxxxxxxxx. GET /v1/sites lists yours.");
  const row = await ctx.env.DB.prepare("SELECT * FROM sites WHERE id = ? AND account_id = ?").bind(siteId, ctx.accountId).first<SiteRow>();
  if (!row) throw notFound("Site", "GET /v1/sites lists the sites this key can see.");
  return row;
}

export async function loadGoals(env: Bindings, siteId: string): Promise<Goal[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, type, match, value, threshold, created_at FROM goals WHERE site_id = ? ORDER BY created_at",
  )
    .bind(siteId)
    .all<Goal>();
  return results;
}

export function settingsFor(site: SiteRow, goals: Goal[]): SiteSettings {
  return {
    id: site.id,
    account_id: site.account_id,
    domain: site.domain,
    name: site.name,
    timezone: site.timezone,
    visitor_id_mode: site.visitor_id_mode,
    retention_days: site.retention_days,
    allowed_hostnames: site.allowed_hostnames ? (JSON.parse(site.allowed_hostnames) as string[]) : null,
    respect_dnt: !!site.respect_dnt,
    exclusions: parseExclusions(site.exclusions),
    browser_revenue: !!site.browser_revenue,
    trust_browser_user_id: !!site.trust_browser_user_id,
    created_at: site.created_at,
    goals,
  };
}

export function parseExclusions(v: string | null | undefined): Exclusions | null {
  if (!v) return null;
  try {
    const x = JSON.parse(v) as Partial<Exclusions>;
    return { ips: x.ips ?? [], paths: x.paths ?? [], hostnames: x.hostnames ?? [], countries: x.countries ?? [] };
  } catch {
    return null;
  }
}

/** Push the D1 truth (settings + goals) into the site's Durable Object. */
export async function pushSettings(env: Bindings, site: SiteRow): Promise<void> {
  await siteStub(env, site.id).configure(settingsFor(site, await loadGoals(env, site.id)));
}

/**
 * Call the DO; if it reports it was never configured (storage lost, or created before a deploy),
 * push settings and retry once. DO errors come back as values and become ApiErrors here.
 */
export async function callSite<T extends Obj>(env: Bindings, site: SiteRow, fn: (stub: SiteStub) => Promise<T | DoError>): Promise<T> {
  const stub = siteStub(env, site.id);
  let r = await fn(stub);
  if (isDoError(r) && r.error.code === "not_configured") {
    await pushSettings(env, site);
    r = await fn(stub);
  }
  if (isDoError(r) && r.error.code === "account_suspended") throw accountSuspended();
  if (isDoError(r)) throw new ApiError(DO_ERROR_STATUS[r.error.code] ?? 400, r.error.code, r.error.message, r.error.hint);
  return r;
}

const DO_ERROR_STATUS: Record<string, 403 | 404 | 409 | 429 | 507> = {
  not_found: 404,
  quota_exceeded: 403,
  conflict: 409,
  account_suspended: 403,
  storage_full: 507,
  daily_limit: 429,
  sql_budget_exhausted: 429,
};
