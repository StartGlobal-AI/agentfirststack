import { type AttackItem, PROTECTION_MODES, requireAuth } from "@afs/shared";
import { Hono } from "hono";
import { emailEnabled } from "./email";
import { emailAttack, emailLimitWarning, emailSiteQuiet } from "./email-messages";
import { type Bindings, DAY, type SiteEnv } from "./env";
import { siteBase } from "./google";
import { type Service, callService } from "./services";

/**
 * Keeping an eye on claimed projects, so their people hear about trouble before it costs them data:
 *
 *   - Usage: every service answers GET /v1/usage with each fair-use cap, what's used and whether
 *     reaching it drops incoming data (drops_data). GET /v1/usage here (MCP afs_get_usage) is all
 *     four in one answer. The hourly cron emails a project's people when a cap that drops data is
 *     at 80% or reached (limit_warning), at most once a week per cap and level (limit_warnings).
 *   - Attacks: analytics and tags add `attacks` (AttackItem in @afs/shared) to their usage answer:
 *     each site or container whose protection is active (under_attack: a spike; contained: a
 *     network past its daily share, set aside) or ended in the last 24 hours. GET /v1/usage here
 *     merges them, the dashboard shows them (Overview, Analytics, Tags), and the same hourly pass
 *     emails the project's people once per episode (site_attack; episode = service, resource id
 *     and since), and once more if a contained episode becomes under_attack. Told episodes are
 *     rows in limit_warnings (item "<service>.attack:<resource id>:<since>", level = the state).
 *   - Quiet sites: the daily cron emails them when an analytics site that had steady page views
 *     (at least 50 in a week, on 4 or more days) has had none for two whole days (site_quiet), once
 *     per outage. A site with its own enabled no_data alert is left to that alert.
 *
 * All are "alerts" emails (users.email_alerts). Unclaimed projects have nobody to tell and are
 * skipped; their agents read the same numbers in get_usage and the setup check.
 */

export const USAGE_SERVICES: Service[] = ["analytics", "tags", "mail", "replay"];
const BINDING = { analytics: "ANALYTICS", tags: "TAGS", mail: "MAIL", replay: "REPLAY" } as const;

/** One cap as the services report it (mail/src/service/usage.ts is the reference). */
export interface UsageItem {
  label?: string;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resets_at: number | null;
  unit: string;
  var: string;
  note?: string;
  drops_data?: boolean;
  per?: { id: string; label: string; used: number; remaining: number | null }[];
}
export interface ServiceUsage {
  day?: string;
  resets_at?: number;
  claimed?: boolean;
  limits?: Record<string, UsageItem>;
  /** analytics and tags: sites and containers whose attack protection is active or just ended. */
  attacks?: unknown;
  [k: string]: unknown;
}

/** A cap at or past NEAR of its limit (for one site, container or inbox when it applies to each). */
export interface LimitHit {
  /** "<service>.<limit>" or "<service>.<limit>:<resource id>" */
  item: string;
  service: Service;
  limit_name: string;
  label: string;
  resource: { id: string; label: string } | null;
  used: number;
  limit: number;
  percent: number;
  level: "near" | "reached";
  drops_data: boolean;
  /** Daily budgets: when they reset (unix ms); null for caps that don't reset. */
  resets_at: number | null;
  unit: string;
  note: string | null;
}

export const NEAR = 0.8;

/** Each service's usage, null where it couldn't be read (or this deployment doesn't run it). */
export async function projectUsage(env: Bindings, accountId: string): Promise<Record<Service, ServiceUsage | null>> {
  const entries = await Promise.all(
    USAGE_SERVICES.map(async (s) => {
      if (!env[BINDING[s]]) return [s, null] as const;
      const r = await callService<ServiceUsage>(env, s, accountId, "/v1/usage");
      return [s, r.ok && r.json && typeof r.json === "object" ? r.json : null] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Service, ServiceUsage | null>;
}

/** The caps at or past NEAR, most urgent first. */
export function limitHits(usage: Record<string, ServiceUsage | null>, opts: { dropsDataOnly?: boolean } = {}): LimitHit[] {
  const hits: LimitHit[] = [];
  for (const service of USAGE_SERVICES) {
    for (const [name, it] of Object.entries(usage[service]?.limits ?? {})) {
      if (!it || typeof it.limit !== "number" || !(it.limit > 0)) continue;
      if (opts.dropsDataOnly && !it.drops_data) continue;
      const rows: { used: number | null; resource: LimitHit["resource"] }[] = it.per?.length
        ? it.per.map((p) => ({ used: p.used, resource: { id: String(p.id), label: String(p.label ?? p.id) } }))
        : [{ used: it.used, resource: null }];
      for (const r of rows) {
        if (typeof r.used !== "number" || r.used < it.limit * NEAR) continue;
        hits.push({
          item: `${service}.${name}${r.resource ? `:${r.resource.id}` : ""}`,
          service,
          limit_name: name,
          label: it.label || name.replace(/_/g, " "),
          resource: r.resource,
          used: r.used,
          limit: it.limit,
          percent: Math.floor((r.used / it.limit) * 100),
          level: r.used >= it.limit ? "reached" : "near",
          drops_data: !!it.drops_data,
          resets_at: it.resets_at ?? null,
          unit: it.unit,
          note: it.note ?? null,
        });
      }
    }
  }
  return hits.sort((a, b) => (a.level === b.level ? b.used / b.limit - a.used / a.limit : a.level === "reached" ? -1 : 1));
}

// ---------- attacks ----------

/** The services whose usage answer carries `attacks` (the ones that take public browser traffic). */
export const ATTACK_SERVICES = ["analytics", "tags"] as const;
export type AttackService = (typeof ATTACK_SERVICES)[number];
/** An ended episode is shown this long after it ended. */
export const ENDED_SHOWN_MS = DAY;
const STATE_ORDER: Record<AttackItem["state"], number> = { under_attack: 0, contained: 1, ended: 2 };
const REASON_KINDS = new Set(["network_share", "spike", "datacenter"]);
const RESOURCE_ID = { analytics: /^site_[0-9a-z]{1,64}$/, tags: /^ctr_[0-9a-z]{1,64}$/ } as const;

export const attackActive = (a: AttackItem) => a.state === "under_attack" || a.state === "contained";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");

/** One entry of a service's `attacks`, checked (the service is the one that answered), or null. */
function cleanAttack(service: AttackService, raw: unknown, now: number): AttackItem | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const id = str(a.resource_id, 80);
  const state = a.state as AttackItem["state"];
  const since = num(a.since);
  if (!RESOURCE_ID[service].test(id) || typeof state !== "string" || !Object.hasOwn(STATE_ORDER, state) || since === null) return null;
  const endedAt = num(a.ended_at);
  if (state === "ended" && (endedAt === null || endedAt < now - ENDED_SHOWN_MS)) return null;
  const reasons = (Array.isArray(a.reasons) ? a.reasons : [])
    .slice(0, 10)
    .filter((r): r is { kind: AttackItem["reasons"][number]["kind"]; detail?: unknown } =>
      REASON_KINDS.has((r as { kind?: string })?.kind ?? ""),
    )
    .map((r) => ({ kind: r.kind, detail: str(r.detail) }));
  return {
    service,
    resource_id: id,
    resource_label: str(a.resource_label, 253) || id,
    state,
    mode: PROTECTION_MODES.includes(a.mode as AttackItem["mode"]) ? (a.mode as AttackItem["mode"]) : "auto",
    since,
    last_seen_at: num(a.last_seen_at) ?? since,
    ended_at: state === "ended" ? endedAt : null,
    reasons,
    quarantined: Math.max(0, Math.floor(num(a.quarantined) ?? 0)),
    next_steps: (Array.isArray(a.next_steps) ? a.next_steps : [])
      .filter((x): x is string => typeof x === "string")
      .slice(0, 6)
      .map((x) => x.slice(0, 500)),
  };
}

/** The analytics and tags `attacks`, in one list: under attack first, then contained, then ended; the latest first. */
export function attackItems(usage: Partial<Record<Service, ServiceUsage | null>>, now = Date.now()): AttackItem[] {
  const out: AttackItem[] = [];
  for (const service of ATTACK_SERVICES) {
    const list = usage[service]?.attacks;
    if (!Array.isArray(list)) continue;
    for (const raw of list.slice(0, 50)) {
      const a = cleanAttack(service, raw, now);
      if (a) out.push(a);
    }
  }
  return out.sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || y.last_seen_at - x.last_seen_at);
}

/** One service's attacks, for its dashboard tab's banner: that service's usage answer alone. */
export async function serviceAttacks(env: Bindings, accountId: string, service: AttackService): Promise<AttackItem[]> {
  if (!env[BINDING[service]]) return [];
  const r = await callService<ServiceUsage>(env, service, accountId, "/v1/usage");
  return r.ok && r.json && typeof r.json === "object" ? attackItems({ [service]: r.json }) : [];
}

/** GET /v1/usage: every service's caps for this project, the ones it's close to, and its attacks. */
export async function usageReport(env: Bindings, accountId: string) {
  const services = await projectUsage(env, accountId);
  const close = limitHits(services);
  const attacks = attackItems(services);
  const unavailable = USAGE_SERVICES.filter((s) => !!env[BINDING[s]] && !services[s]);
  return {
    project: { id: accountId },
    close_to_limits: close,
    attacks,
    services,
    unavailable,
    checked_at: Date.now(),
    note: `close_to_limits lists every cap at ${Math.round(NEAR * 100)}% of its limit or more, most urgent first; drops_data: true means reaching it loses incoming data (events, mail, sessions) instead of failing your own call. Daily budgets reset at 00:00 UTC. The project's people get an email when a drops_data cap gets there. attacks lists the analytics sites and tag containers getting suspicious traffic (under_attack: a spike; contained: a network past its daily share) or that did in the last 24 hours (ended); what was quarantined stays out of reports and budgets until it is released or purged, and the project's people get an email when one starts.`,
    next_steps: [
      ...(close.length
        ? [
            "Find what is using each cap (the service's own reads: stats and crawlers in analytics, container stats in tags, inboxes in mail, sessions in replay) and cut what isn't needed: bot or test traffic (allowed_hostnames, exclusions), old data (retention_days), old mail (delete messages).",
            "If the project really needs more, tell the owner: they can reply to any AgentFirstStack email.",
          ]
        : []),
      ...(attacks.some(attackActive)
        ? [
            "Suspicious traffic was set aside (attacks): review each one's quarantine as its next_steps say, tell the owner whether it looks like an attack or real visitors, then release (analytics) or purge it.",
          ]
        : []),
    ],
  };
}

export const usageApi = new Hono<SiteEnv>();
usageApi.get("/v1/usage", requireAuth<SiteEnv>(), async (c) => c.json(await usageReport(c.env, c.var.auth.accountId)));

// ---------- the crons ----------

interface DueProject {
  id: string;
  name: string | null;
}

/** Claimed, live projects whose `column` check is older than `before`, oldest first. */
async function dueProjects(db: D1Database, column: "usage_checked_at" | "quiet_checked_at", before: number, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name FROM accounts a LEFT JOIN project_health h ON h.account_id = a.id
        WHERE a.deleted_at IS NULL AND a.suspended_at IS NULL
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.account_id = a.id)
          AND (h.${column} IS NULL OR h.${column} < ?)
        ORDER BY COALESCE(h.${column}, 0), a.id LIMIT ?`,
    )
    .bind(before, limit)
    .all<DueProject>();
  return results;
}

async function markChecked(db: D1Database, column: "usage_checked_at" | "quiet_checked_at", accountId: string, now: number) {
  await db
    .prepare(
      `INSERT INTO project_health (account_id, ${column}) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET ${column} = excluded.${column}`,
    )
    .bind(accountId, now)
    .run();
}

/** Run `fn` over `items`, `n` at a time, until `deadline`. Returns how many ran. */
async function eachLimited<T>(items: T[], n: number, deadline: number, fn: (item: T) => Promise<void>) {
  let done = 0;
  for (let i = 0; i < items.length; i += n) {
    if (Date.now() >= deadline) break;
    await Promise.all(
      items.slice(i, i + n).map(async (item) => {
        try {
          await fn(item);
        } catch (e) {
          console.error(JSON.stringify({ event: "health.check_failed", error: String((e as Error)?.message ?? e) }));
        }
      }),
    );
    done += Math.min(n, items.length - i);
  }
  return done;
}

const WARN_AGAIN_AFTER = 7 * DAY;
const HOUR = 3_600_000;

/** The hits nobody was told about this week (a "reached" warning also covers "near"). */
async function freshHits(db: D1Database, accountId: string, hits: LimitHit[], now: number) {
  const { results } = await db
    .prepare("SELECT item, level FROM limit_warnings WHERE account_id = ? AND warned_at > ?")
    .bind(accountId, now - WARN_AGAIN_AFTER)
    .all<{ item: string; level: string }>();
  const told = new Set(results.map((r) => `${r.item}|${r.level}`));
  return hits.filter((h) => !told.has(`${h.item}|reached`) && !(h.level === "near" && told.has(`${h.item}|near`)));
}

/** An attack episode as a limit_warnings item: one per service, resource and start. */
export const attackItemKey = (a: AttackItem) => `${a.service}.attack:${a.resource_id}:${a.since}`;

/** The active episodes nobody was told about (a told under_attack also covers contained). */
async function freshAttacks(db: D1Database, accountId: string, attacks: AttackItem[]) {
  const items = [...new Set(attacks.map(attackItemKey))].slice(0, 50);
  const { results } = await db
    .prepare(`SELECT item, level FROM limit_warnings WHERE account_id = ? AND item IN (${items.map(() => "?").join(", ")})`)
    .bind(accountId, ...items)
    .all<{ item: string; level: string }>();
  const told = new Set(results.map((r) => `${r.item}|${r.level}`));
  return attacks.filter(
    (a) => items.includes(attackItemKey(a)) && !told.has(`${attackItemKey(a)}|under_attack`) && !told.has(`${attackItemKey(a)}|${a.state}`),
  );
}

const remember = (db: D1Database, accountId: string, rows: { item: string; level: string }[], now: number) =>
  db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO limit_warnings (account_id, item, level, warned_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(account_id, item, level) DO UPDATE SET warned_at = excluded.warned_at`,
        )
        .bind(accountId, r.item, r.level, now),
    ),
  );

/**
 * Hourly: every claimed project's usage; an email to its people about caps that drop data and are
 * close to (80%) or at their limit (a daily budget that resets within the hour isn't worth a
 * "near"), and one about sites and containers whose attack protection just started, from the
 * same answers.
 */
export async function checkProjectLimits(env: Bindings, base: string, now = Date.now(), opts: { limit?: number; budgetMs?: number } = {}) {
  if (!emailEnabled(env)) return { checked: 0, warned: 0, attacks: 0 };
  const projects = await dueProjects(env.DB, "usage_checked_at", now - 50 * 60_000, opts.limit ?? 200);
  let warned = 0;
  let attacked = 0;
  const checked = await eachLimited(projects, 5, Date.now() + (opts.budgetMs ?? 120_000), async (p) => {
    const usage = await projectUsage(env, p.id);
    const hits = limitHits(usage, { dropsDataOnly: true }).filter(
      (h) => !(h.level === "near" && h.resets_at !== null && h.resets_at - now < HOUR),
    );
    const fresh = hits.length ? await freshHits(env.DB, p.id, hits, now) : [];
    if (fresh.length) {
      await emailLimitWarning(env, base, { accountId: p.id, name: p.name, hits: fresh, now });
      await remember(
        env.DB,
        p.id,
        fresh.map((h) => ({ item: h.item, level: h.level })),
        now,
      );
      warned++;
    }
    const active = attackItems(usage, now).filter(attackActive);
    const news = active.length ? await freshAttacks(env.DB, p.id, active) : [];
    if (news.length) {
      await emailAttack(env, base, { accountId: p.id, name: p.name, attacks: news });
      await remember(
        env.DB,
        p.id,
        news.map((a) => ({ item: attackItemKey(a), level: a.state })),
        now,
      );
      attacked++;
    }
    await markChecked(env.DB, "usage_checked_at", p.id, now);
  });
  return { checked, warned, attacks: attacked };
}

/** Daily: warnings older than a month are forgotten. */
export async function pruneLimitWarnings(db: D1Database, now = Date.now()) {
  const r = await db
    .prepare("DELETE FROM limit_warnings WHERE warned_at < ?")
    .bind(now - 30 * DAY)
    .run();
  return r.meta.changes ?? 0;
}

// ---------- quiet sites ----------

/** A week with at least this many page views (on QUIET_MIN_DAYS days or more) is a working site. */
export const QUIET_MIN_WEEKLY = 50;
export const QUIET_MIN_DAYS = 4;

/**
 * Daily page views, oldest first, ending today (the site's timezone): has a working site gone
 * quiet? Quiet = no page view today, yesterday or the day before, after a steady week, and the
 * last page view at most 8 days ago (an older outage was reported then, or the site was retired).
 */
export function quietSpell(days: { date: string; pageviews?: number | null }[]): { last_date: string; per_day: number } | null {
  const pv = days.map((d) => Number(d.pageviews ?? 0) || 0);
  const n = pv.length;
  let last = -1;
  for (let i = n - 1; i >= 0; i--)
    if (pv[i]! > 0) {
      last = i;
      break;
    }
  if (last < 6 || last > n - 4 || last < n - 9) return null;
  const week = pv.slice(last - 6, last + 1);
  const total = week.reduce((a, b) => a + b, 0);
  if (total < QUIET_MIN_WEEKLY || week.filter((x) => x > 0).length < QUIET_MIN_DAYS) return null;
  return { last_date: days[last]!.date, per_day: Math.round(total / 7) };
}

interface Timeseries {
  results?: { date: string; pageviews?: number | null }[];
}

/** Daily: every claimed project's analytics sites; an email to its people for each that went quiet. */
export async function checkQuietSites(env: Bindings, base: string, now = Date.now(), opts: { limit?: number; budgetMs?: number } = {}) {
  if (!emailEnabled(env) || !env.ANALYTICS) return { checked: 0, quiet: 0 };
  const projects = await dueProjects(env.DB, "quiet_checked_at", now - 20 * HOUR, opts.limit ?? 300);
  let quiet = 0;
  const checked = await eachLimited(projects, 5, Date.now() + (opts.budgetMs ?? 120_000), async (p) => {
    const list = await callService<{ sites?: { id: string; domain: string }[] }>(env, "analytics", p.id, "/v1/sites");
    if (!list.ok) return; // try again tomorrow
    for (const site of (list.json?.sites ?? []).slice(0, 25)) {
      const ts = await callService<Timeseries>(
        env,
        "analytics",
        p.id,
        `/v1/sites/${encodeURIComponent(site.id)}/timeseries?period=30d&interval=day&metrics=pageviews`,
      );
      const spell = ts.ok ? quietSpell(ts.json?.results ?? []) : null;
      if (!spell) continue;
      // The site's own "Tracking stopped" alert already tells someone.
      const alerts = await callService<{ alerts?: { type: string; enabled: boolean }[] }>(
        env,
        "analytics",
        p.id,
        `/v1/sites/${encodeURIComponent(site.id)}/alerts`,
      );
      if ((alerts.json?.alerts ?? []).some((a) => a.type === "no_data" && a.enabled)) continue;
      await emailSiteQuiet(env, base, { accountId: p.id, name: p.name, site, lastDate: spell.last_date, perDay: spell.per_day });
      quiet++;
    }
    await markChecked(env.DB, "quiet_checked_at", p.id, now);
  });
  return { checked, quiet };
}
