import { type AuthContext, ApiError, accountSuspended, notFound } from "@afs/shared";
import type { Bindings } from "../env";
import type { Breakdown } from "../lib/filters";
import type {
  DoError,
  EnrichedEvent,
  FunnelRequest,
  Goal,
  IngestResponse,
  PathRule,
  PaymentInput,
  PaymentOutcome,
  SiteSettings,
  StatsRequest,
  TimeseriesRequest,
  VisitorIdMode,
} from "../lib/types";
import { isDoError } from "../lib/types";
import type { Exclusions } from "../lib/exclusions";
import type { BudgetReason } from "../do/engine";
import type { LimitVars } from "../lib/limits";
import type { ChannelGroup } from "../lib/types";
import type { IngestPolicy, SubscriptionRecord } from "../do/site-do";
import type { SubscriptionOutcome } from "../do/subscriptions";
import type { CostInput, CostOutcome } from "../do/costs";
import type { CrawlHit } from "../do/crawlers";
import type { ImportRow } from "../lib/imports";

/** What every service call needs: bindings, the caller's account, and the public base URL. */
export interface Ctx {
  env: Bindings;
  accountId: string;
  /** The caller's credential (an API key, an OAuth access token, or internal auth from another Worker). */
  auth: AuthContext;
  baseUrl: string;
  /** origin of the API request itself (differs from baseUrl when PUBLIC_BASE_URL is set) */
  origin?: string;
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
  /** 1 = keep user properties from afsa('identify', id, props) (migration 0019; default 0) */
  browser_user_props?: number;
  /** 1 = user ids from afsa('identify') may link payments (migration 0007; default 0) */
  trust_browser_user_id?: number;
  /** linked replay site, rsite_...; the tracker loads its recorder (migration 0008; NULL = none) */
  replay_site_id?: string | null;
  /** set when verify proved the domain is the account's (migration 0009; NULL = not verified) */
  verified_at?: number | null;
  /** homepage | dns_txt | dev_localhost */
  verify_method?: string | null;
  /** JSON array of referrer host patterns (migration 0010; NULL = none of the site's own) */
  ignored_referrers?: string | null;
  /** JSON PathRule[] (migration 0010; NULL = none) */
  path_rules?: string | null;
  /** 1 = redact emails and phone numbers at ingest (migration 0010; default 1) */
  redact_pii?: number;
  /** JSON array of query parameter names that carry a site search term (migration 0013) */
  search_params?: string | null;
  /** JSON [{name, match}] content groups (migration 0013) */
  content_groups?: string | null;
  /** migration 0018: NULL = 30 minutes; JSON ChannelGroup[] */
  session_timeout_minutes?: number | null;
  channel_groups?: string | null;
  /** reporting currency, ISO 4217 (migration 0016; NULL = none: money stays in its own currency) */
  currency?: string | null;
  created_at: number;
  updated_at: number;
}

export const isVerified = (s: Pick<SiteRow, "verified_at">) => s.verified_at !== null && s.verified_at !== undefined;

type Obj = Record<string, unknown>;

/** The RPC surface of SiteDO, typed loosely (results are plain JSON objects). */
export interface SiteStub {
  configure(s: SiteSettings): Promise<{ ok: true }>;
  ingest(events: EnrichedEvent[], policy?: IngestPolicy): Promise<IngestResponse>;
  recordDrop(reason: string, sample: string | null): Promise<{ replay_site_id: string | null } | null>;
  stats(q: StatsRequest): Promise<Obj | DoError>;
  breakdown(q: StatsRequest & { breakdown: Breakdown | Breakdown[] }): Promise<Obj | DoError>;
  timeseries(q: TimeseriesRequest): Promise<Obj | DoError>;
  realtime(q?: Obj): Promise<Obj | DoError>;
  funnel(q: FunnelRequest): Promise<Obj | DoError>;
  sql(q: string, opts?: { budgetMs?: number }): Promise<Obj | DoError>;
  chargeSql(ms: number, budgetMs: number): Promise<void>;
  summary(): Promise<SiteSummary | DoError>;
  destroy(): Promise<{ ok: true }>;
  movers(q: Obj): Promise<Obj | DoError>;
  insights(q: Obj): Promise<Obj | DoError>;
  schema(q: Obj): Promise<Obj | DoError>;
  deleteVisitor(key: string, opts?: Obj): Promise<Obj | DoError>;
  purge(q: Obj): Promise<Obj | DoError>;
  alertNumbers(q: Obj): Promise<Obj | DoError>;
  digest(q: Obj): Promise<Obj | DoError>;
  retention(q: Obj): Promise<Obj | DoError>;
  paths(q: Obj): Promise<Obj | DoError>;
  attribution(q: Obj): Promise<Obj | DoError>;
  props(q: Obj): Promise<Obj | DoError>;
  visitors(q: Obj): Promise<Obj | DoError>;
  visitor(key: string, limit?: number): Promise<Obj | DoError>;
  session(id: string): Promise<Obj | DoError>;
  journeys(q: Obj): Promise<Obj | DoError>;
  ingestPayments(records: PaymentInput[], policy?: IngestPolicy): Promise<{ results: PaymentOutcome[]; refused?: BudgetReason } | DoError>;
  listPayments(q: Obj): Promise<Obj | DoError>;
  ingestSubscriptions(
    records: SubscriptionRecord[],
    policy?: IngestPolicy,
  ): Promise<{ results: SubscriptionOutcome[]; refused?: BudgetReason } | DoError>;
  listSubscriptions(q: Obj): Promise<Obj | DoError>;
  mrr(q: Obj): Promise<Obj | DoError>;
  upsertCosts(rows: CostInput[], max: number, vars?: LimitVars): Promise<{ results: CostOutcome[]; stored: number } | DoError>;
  listCosts(q: Obj): Promise<Obj | DoError>;
  items(q: Obj): Promise<Obj | DoError>;
  userProps(): Promise<Obj | DoError>;
  realtimeMap(q: Obj): Promise<Obj | DoError>;
  recordCrawls(
    hits: CrawlHit[],
    dailyBudget: number,
    room?: number,
    vars?: LimitVars,
  ): Promise<{ counted: number; refused: number; used_today: number; daily_budget: number | null } | DoError>;
  crawlers(q: Obj): Promise<Obj | DoError>;
  saveImport(
    id: string,
    meta: Obj,
    rows: ImportRow[],
    caps: { maxRows: number; maxImports: number },
    vars?: LimitVars,
  ): Promise<Obj | DoError>;
  listImports(): Promise<Obj | DoError>;
  compareImports(q: { source?: string; tool?: string }): Promise<Obj | DoError>;
  exportEvents(q: Obj, dailyBudget: number): Promise<Obj | DoError>;
  deleteImport(id: string): Promise<Obj | DoError>;
  listSessions(q: Obj, replay: { site_id: string; base: string } | null): Promise<Obj | DoError>;
  deleteCosts(q: Obj): Promise<{ deleted: number } | DoError>;
  deletePayment(id: string): Promise<Obj | DoError>;
  paymentsSummary(): Promise<PaymentsSummary | DoError>;
  createAnnotation(a: Obj, max: number | null): Promise<Obj | DoError>;
  listAnnotations(q: Obj): Promise<Obj | DoError>;
  updateAnnotation(id: string, p: Obj): Promise<Obj | DoError>;
  alertAnnotation(a: { alert_id: string; ts: number; title: string; description: string | null; details: Obj }): Promise<Obj | DoError>;
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

type GoalRow = Omit<Goal, "props"> & { props: string | null };

export const goalFromRow = (g: GoalRow): Goal => ({
  ...g,
  props: g.props ? (JSON.parse(g.props) as Record<string, string>) : null,
  counting: g.counting === "once_per_visit" ? "once_per_visit" : "every",
});

export async function loadGoals(env: Bindings, siteId: string): Promise<Goal[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, type, match, value, threshold, props, counting, created_at FROM goals WHERE site_id = ? ORDER BY created_at",
  )
    .bind(siteId)
    .all<GoalRow>();
  return results.map(goalFromRow);
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
    browser_user_props: !!site.browser_user_props,
    trust_browser_user_id: !!site.trust_browser_user_id,
    replay_site_id: site.replay_site_id ?? null,
    ignored_referrers: jsonList<string>(site.ignored_referrers),
    path_rules: jsonList<PathRule>(site.path_rules),
    redact_pii: site.redact_pii !== 0,
    search_params: jsonList<string>(site.search_params),
    content_groups: jsonList<{ name: string; match: string }>(site.content_groups),
    session_timeout_minutes: site.session_timeout_minutes ?? 30,
    channel_groups: jsonList<ChannelGroup>(site.channel_groups),
    currency: site.currency ?? null,
    created_at: site.created_at,
    goals,
  };
}

/** A JSON array column, or null when empty / unset / unreadable. */
export function jsonList<T>(v: string | null | undefined): T[] | null {
  if (!v) return null;
  try {
    const x = JSON.parse(v) as unknown;
    return Array.isArray(x) && x.length ? (x as T[]) : null;
  } catch {
    return null;
  }
}

export function parseExclusions(v: string | null | undefined): Exclusions | null {
  if (!v) return null;
  try {
    const x = JSON.parse(v) as Partial<Exclusions>;
    return {
      ips: x.ips ?? [],
      paths: x.paths ?? [],
      hostnames: x.hostnames ?? [],
      countries: x.countries ?? [],
      referrers: x.referrers ?? [],
    };
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
