/**
 * Ad spend in the site's Durable Object: one row per (day, source, campaign) in the site's
 * timezone, so reports can put cost next to traffic and revenue: cost, ROAS (revenue / cost), CPA
 * (cost / conversions), CAC (cost / new customers) and cost per visit, in stats, breakdowns by
 * utm_source / utm_campaign / source, and day / week / month timeseries.
 *
 * Matching: a cost row's source is compared, lowercased, with the events' utm_source (and with the
 * source name for breakdown=source), its campaign with utm_campaign. Costs have no other
 * dimensions, so cost metrics are null (with a note) under any other filter or breakdown.
 */

import type { Filter, Metric } from "../lib/filters";
import { type Range, localDay, ymdString, zonedToUtc } from "../lib/time";
import type { Db } from "./common";
import { num, round } from "./common";

type MetricValues = Record<string, number | null>;

export const COSTS_SQL = [
  `CREATE TABLE IF NOT EXISTS costs (
    day TEXT NOT NULL, source TEXT NOT NULL, campaign TEXT NOT NULL DEFAULT '', medium TEXT,
    cost REAL NOT NULL, currency TEXT, original_cost REAL, original_currency TEXT, fx_rate REAL,
    clicks INTEGER, impressions INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (day, source, campaign)
  )`,
  "CREATE INDEX IF NOT EXISTS costs_source ON costs(source, day)",
];

export const COST_METRICS = ["cost", "roas", "cpa", "cac", "cost_per_visit"] as const satisfies readonly Metric[];
const COST_SET = new Set<string>(COST_METRICS);
/** What the cost metrics are computed from (queried too when only cost metrics are asked for). */
export const COST_BASES: Metric[] = ["revenue", "conversions", "customers", "visits"];
/** Dimensions costs can be split and filtered by. */
export const COST_DIMS = ["utm_source", "utm_campaign", "source"] as const;

export const isCostMetric = (m: string) => COST_SET.has(m);

export interface CostInput {
  day: string;
  source: string;
  campaign: string;
  medium: string | null;
  cost: number;
  currency: string | null;
  original_cost?: number | null;
  original_currency?: string | null;
  fx_rate?: number | null;
  clicks: number | null;
  impressions: number | null;
}

export interface CostOutcome {
  ok: boolean;
  existing?: boolean;
  changed?: boolean;
  reason?: string;
}

/** Upsert by (day, source, campaign): the same row again changes nothing, a new figure replaces it. */
export function upsertCosts(db: Db, rows: CostInput[], max: number, now = Date.now()): { results: CostOutcome[]; stored: number } {
  const results: CostOutcome[] = [];
  db.transaction(() => {
    let count = num(db.all("SELECT COUNT(*) AS n FROM costs")[0]?.n);
    for (const r of rows) {
      const cur = db.all("SELECT * FROM costs WHERE day = ? AND source = ? AND campaign = ?", [r.day, r.source, r.campaign])[0];
      const vals = [
        r.medium,
        round(r.cost, 4),
        r.currency,
        r.original_cost ?? r.cost,
        r.original_currency ?? r.currency,
        r.fx_rate ?? null,
        r.clicks,
        r.impressions,
      ];
      if (cur) {
        const same =
          num(cur.cost) === round(r.cost, 4) &&
          (cur.currency ?? null) === r.currency &&
          (cur.medium ?? null) === r.medium &&
          (cur.clicks ?? null) === r.clicks &&
          (cur.impressions ?? null) === r.impressions;
        if (!same)
          db.run(
            "UPDATE costs SET medium = ?, cost = ?, currency = ?, original_cost = ?, original_currency = ?, fx_rate = ?, clicks = ?, impressions = ?, updated_at = ? WHERE day = ? AND source = ? AND campaign = ?",
            [...vals, now, r.day, r.source, r.campaign],
          );
        results.push({ ok: true, existing: true, changed: !same });
        continue;
      }
      if (count >= max) {
        results.push({ ok: false, reason: "cost_rows_limit" });
        continue;
      }
      db.run(
        `INSERT INTO costs (day, source, campaign, medium, cost, currency, original_cost, original_currency, fx_rate, clicks, impressions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.day, r.source, r.campaign, ...vals, now, now],
      );
      count++;
      results.push({ ok: true, existing: false, changed: true });
    }
  });
  return { results, stored: num(db.all("SELECT COUNT(*) AS n FROM costs")[0]?.n) };
}

export interface CostsQuery {
  from: string;
  to: string;
  source?: string;
  campaign?: string;
  limit: number;
  offset: number;
}

export function listCosts(db: Db, q: CostsQuery) {
  const where = ["day >= ?", "day <= ?"];
  const args: (string | number)[] = [q.from, q.to];
  if (q.source) {
    where.push("source = ?");
    args.push(q.source);
  }
  if (q.campaign != null) {
    where.push("campaign = ?");
    args.push(q.campaign);
  }
  const w = where.join(" AND ");
  const rows = db.all(`SELECT * FROM costs WHERE ${w} ORDER BY day DESC, source, campaign LIMIT ? OFFSET ?`, [...args, q.limit, q.offset]);
  const head = db.all(
    `SELECT COUNT(*) AS n, COALESCE(SUM(cost), 0) AS cost, COUNT(DISTINCT currency) AS currencies FROM costs WHERE ${w}`,
    args,
  )[0];
  const total = num(head?.n);
  return {
    costs: rows.map((r) => ({
      date: r.day,
      source: r.source,
      campaign: r.campaign || null,
      medium: r.medium ?? null,
      cost: num(r.cost),
      currency: r.currency ?? null,
      ...(r.fx_rate != null ? { original: { cost: r.original_cost, currency: r.original_currency, fx_rate: r.fx_rate } } : {}),
      clicks: r.clicks ?? null,
      impressions: r.impressions ?? null,
      updated_at: r.updated_at,
    })),
    total,
    total_cost: round(num(head?.cost), 2),
    offset: q.offset,
    next_offset: q.offset + rows.length < total ? q.offset + rows.length : null,
  };
}

export function deleteCosts(db: Db, q: { from: string; to: string; source?: string; campaign?: string }) {
  const where = ["day >= ?", "day <= ?"];
  const args: string[] = [q.from, q.to];
  if (q.source) {
    where.push("source = ?");
    args.push(q.source);
  }
  if (q.campaign != null) {
    where.push("campaign = ?");
    args.push(q.campaign);
  }
  const n = num(db.all(`SELECT COUNT(*) AS n FROM costs WHERE ${where.join(" AND ")}`, args)[0]?.n);
  db.run(`DELETE FROM costs WHERE ${where.join(" AND ")}`, args);
  return { deleted: n };
}

// ------------------------------------------------------------------ in reports

/** The metrics to query: the requested ones plus what cost metrics are computed from. */
export function withCostBases(metrics: Metric[]): Metric[] {
  return metrics.some(isCostMetric) ? [...new Set<Metric>([...metrics, ...COST_BASES])] : metrics;
}

/** Cost filters from report filters: utm_source / utm_campaign == / != only; anything else can't apply to costs. */
export function costScope(filters: Filter[], hasWhere: boolean): { sql: string; args: string[] } | null {
  if (hasWhere) return null;
  const parts: string[] = [];
  const args: string[] = [];
  for (const f of filters) {
    const col = f.key === "utm_source" ? "source" : f.key === "utm_campaign" ? "campaign" : null;
    if (!col || (f.op !== "==" && f.op !== "!=") || f.values.some((v) => v.includes("*"))) return null;
    const vals = f.values.map((v) => v.toLowerCase());
    parts.push(`${col} ${f.op === "==" ? "" : "NOT "}IN (${vals.map(() => "?").join(", ")})`);
    args.push(...vals);
  }
  return { sql: parts.length ? `AND ${parts.join(" AND ")}` : "", args };
}

/** Days covered by a range, in the site timezone. */
const daysOf = (r: Pick<Range, "start" | "end" | "timezone">) => ({
  from: ymdString(localDay(r.start, r.timezone)),
  to: ymdString(localDay(r.end - 1, r.timezone)),
});

export function costTotal(db: Db, r: Pick<Range, "start" | "end" | "timezone">, scope: { sql: string; args: string[] }): number {
  const d = daysOf(r);
  return num(
    db.all(`SELECT COALESCE(SUM(cost), 0) AS c FROM costs WHERE day >= ? AND day <= ? ${scope.sql}`, [d.from, d.to, ...scope.args])[0]?.c,
  );
}

/** Cost per breakdown value (lowercased): source for utm_source and source, campaign for utm_campaign. */
export function costByValue(
  db: Db,
  dim: string,
  r: Pick<Range, "start" | "end" | "timezone">,
  scope: { sql: string; args: string[] },
): Map<string, number> {
  const d = daysOf(r);
  const col = dim === "utm_campaign" ? "campaign" : "source";
  const rows = db.all(
    `SELECT ${col} AS v, COALESCE(SUM(cost), 0) AS c FROM costs WHERE day >= ? AND day <= ? ${scope.sql} GROUP BY ${col}`,
    [d.from, d.to, ...scope.args],
  );
  return new Map(rows.map((x) => [String(x.v), num(x.c)]));
}

/** Cost per bucket, by the local noon of each cost day. */
export function costByBucket(
  db: Db,
  r: Pick<Range, "start" | "end" | "timezone">,
  bs: { label: string; start: number; end: number }[],
  scope: { sql: string; args: string[] },
): Map<string, number> {
  const d = daysOf(r);
  const rows = db.all(`SELECT day, COALESCE(SUM(cost), 0) AS c FROM costs WHERE day >= ? AND day <= ? ${scope.sql} GROUP BY day`, [
    d.from,
    d.to,
    ...scope.args,
  ]);
  const out = new Map<string, number>();
  for (const x of rows) {
    const [y, m, dd] = String(x.day).split("-").map(Number) as [number, number, number];
    const t = zonedToUtc(y, m, dd, 12, r.timezone);
    const b = bs.find((b) => t >= b.start && t < b.end);
    if (b) out.set(b.label, (out.get(b.label) ?? 0) + num(x.c));
  }
  return out;
}

/** Fill the cost metrics of one result from its cost, keeping only the requested metrics. */
export function fillCosts(m: MetricValues, cost: number | null, requested: Metric[]): MetricValues {
  const want = requested.filter(isCostMetric);
  if (!want.length) return m;
  const out: MetricValues = {};
  const v = (k: Metric) => num(m[k]);
  const ratio = (a: number, b: number, dp = 2) => (cost == null || !b ? null : round(a / b, dp));
  const values: Record<string, number | null> = {
    cost: cost == null ? null : round(cost, 2),
    roas: cost == null || !cost ? null : round(v("revenue") / cost, 2),
    cpa: cost == null ? null : ratio(cost, v("conversions")),
    cac: cost == null ? null : ratio(cost, v("customers")),
    cost_per_visit: cost == null ? null : ratio(cost, v("visits"), 3),
  };
  for (const k of requested) out[k] = isCostMetric(k) ? values[k]! : m[k]!;
  return out;
}

export const COST_NOTE =
  "Cost metrics (cost, roas, cpa, cac, cost_per_visit) come from POST /v1/sites/:id/costs, which has only date, source (matched with utm_source) and campaign (utm_campaign): they are null under other filters or breakdowns, and in hourly series.";
