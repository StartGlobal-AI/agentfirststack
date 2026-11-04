/**
 * Multi-touch attribution: each conversion (a goal, or a new purchase) in the period is credited
 * to the sessions the same person had before it within the lookback window, by a rule-based
 * model, and the credit is summed per value of a session dimension (channel, source, campaign).
 * Conversion paths list the most common sequences of those values.
 *
 * A person is a user id (across devices and days), an identified visitor's user, or a visitor id.
 * In cookieless mode an anonymous visitor id rotates daily (UTC): their touchpoints reach back to
 * that day only. Identified users and persistent mode see the whole lookback.
 *
 * Bounded: the most recent MAX_CONVERSIONS conversions, MAX_TOUCHPOINTS sessions each (the ones
 * closest to the conversion); `sampled` says when a cap was hit.
 */

import { median } from "../lib/stats-math";
import { type Frag, evCte, raw, sql } from "../lib/query";
import type { PeriodParams, SiteSettings } from "../lib/types";
import type { Filter } from "../lib/filters";
import { DAY, type Db, all, checkGoalFilters, ctxFor, guard, identityNote, num, periodOut, rangeFor, round, unknownGoals } from "./common";
import { SESSION_IDENT } from "./identities";
import { targetCond } from "./people";

export const MODELS = ["last_non_direct", "last_touch", "first_touch", "linear", "position_based", "time_decay"] as const;
export type Model = (typeof MODELS)[number];
export const ATTRIBUTION_DIMS = ["channel", "source", "utm_source", "utm_medium", "utm_campaign", "referrer", "entry_page"] as const;
export type AttributionDim = (typeof ATTRIBUTION_DIMS)[number];
export const MAX_CONVERSIONS = 5000;
export const MAX_TOUCHPOINTS = 20;
/** time_decay: a touchpoint this long before the conversion gets half the weight of one at it. */
export const HALF_LIFE_MS = 7 * DAY;

export interface AttributionRequest extends PeriodParams {
  filters: Filter[];
  goal?: string;
  model: Model;
  lookback_days: number;
  breakdown: AttributionDim;
  paths: boolean;
  limit: number;
}

export interface Touchpoint {
  ts: number;
  value: string;
  channel: string;
}

/** Credit per touchpoint (oldest first), summing to 1. */
export function credits(model: Model, tps: Touchpoint[], conversionTs: number): number[] {
  const n = tps.length;
  if (!n) return [];
  const one = (i: number) => tps.map((_, j) => (j === i ? 1 : 0));
  switch (model) {
    case "last_touch":
      return one(n - 1);
    case "first_touch":
      return one(0);
    case "last_non_direct": {
      for (let i = n - 1; i >= 0; i--) if (tps[i]!.channel !== "Direct") return one(i);
      return one(n - 1);
    }
    case "linear":
      return tps.map(() => 1 / n);
    case "position_based":
      if (n === 1) return [1];
      if (n === 2) return [0.5, 0.5];
      return tps.map((_, i) => (i === 0 || i === n - 1 ? 0.4 : 0.2 / (n - 2)));
    case "time_decay": {
      const w = tps.map((t) => 2 ** (-Math.max(0, conversionTs - t.ts) / HALF_LIFE_MS));
      const sum = w.reduce((a, b) => a + b, 0);
      return w.map((x) => x / sum);
    }
  }
}

const UNATTRIBUTED = "(no session)";

export function attribution(db: Db, settings: SiteSettings, q: AttributionRequest, now = Date.now()) {
  return guard(() => {
    const ge = checkGoalFilters(db, q.filters, q.where) ?? (q.goal ? unknownGoals(db, [q.goal]) : null);
    if (ge) return ge;
    if (!(ATTRIBUTION_DIMS as readonly string[]).includes(q.breakdown)) throw new Error("bad attribution dimension");
    const r = rangeFor(db, settings, q, now);
    const ctx = ctxFor(db, r, q);
    const lookback = q.lookback_days * DAY;
    const value: Frag = q.goal
      ? sql`COALESCE(e.revenue, (SELECT g.value FROM goals g WHERE g.name = ${q.goal}), 0)`
      : raw("COALESCE(e.revenue, 0)");
    const rows = all(
      db,
      sql`WITH ${evCte(ctx)},
      conv AS (SELECT e.id AS cid, e.ts, ${value} AS rev,
                 COALESCE('user:' || e.user_id, (SELECT i.canonical FROM identities i WHERE i.ident = e.visitor_id), e.visitor_id) AS person
               FROM ev e WHERE ${targetCond(q.goal)} ORDER BY e.ts DESC LIMIT ${MAX_CONVERSIONS}),
      sp AS (SELECT s.id, s.started_at, COALESCE(s.${raw(q.breakdown)}, '(none)') AS value, s.channel, ${raw(SESSION_IDENT)} AS person FROM sessions s
             WHERE s.last_seen_at >= (SELECT MIN(ts) FROM conv) - ${lookback} AND s.started_at <= (SELECT MAX(ts) FROM conv)),
      tp AS (SELECT c.cid, c.ts AS cts, c.rev, sp.started_at, sp.value, sp.channel,
               ROW_NUMBER() OVER (PARTITION BY c.cid ORDER BY sp.started_at DESC) AS rn
             FROM conv c JOIN sp ON sp.person = c.person AND sp.started_at <= c.ts AND sp.started_at >= c.ts - ${lookback})
      SELECT c.cid, c.ts AS cts, c.rev, tp.started_at, tp.value, tp.channel FROM conv c
      LEFT JOIN tp ON tp.cid = c.cid AND tp.rn <= ${MAX_TOUCHPOINTS}
      ORDER BY c.cid, tp.started_at`,
    );
    const byConv = new Map<number, { ts: number; rev: number; tps: Touchpoint[] }>();
    for (const x of rows) {
      const id = num(x.cid);
      const c = byConv.get(id) ?? { ts: num(x.cts), rev: num(x.rev), tps: [] };
      if (x.started_at != null) c.tps.push({ ts: num(x.started_at), value: String(x.value), channel: String(x.channel) });
      byConv.set(id, c);
    }
    const credit = new Map<string, { conversions: number; revenue: number }>();
    const add = (v: string, share: number, rev: number) => {
      const cur = credit.get(v) ?? { conversions: 0, revenue: 0 };
      cur.conversions += share;
      cur.revenue += share * rev;
      credit.set(v, cur);
    };
    const seqs = new Map<string, { path: string[]; conversions: number; revenue: number; days: number[]; touches: number[] }>();
    let revenue = 0;
    for (const c of byConv.values()) {
      revenue += c.rev;
      if (!c.tps.length) {
        add(UNATTRIBUTED, 1, c.rev);
        continue;
      }
      credits(q.model, c.tps, c.ts).forEach((w, i) => add(c.tps[i]!.value, w, c.rev));
      if (q.paths) {
        const path: string[] = [];
        for (const t of c.tps) if (path[path.length - 1] !== t.value) path.push(t.value);
        const shown = path.length > 5 ? ["…", ...path.slice(-4)] : path;
        const k = shown.join(" > ");
        const s = seqs.get(k) ?? { path: shown, conversions: 0, revenue: 0, days: [], touches: [] };
        s.conversions++;
        s.revenue += c.rev;
        s.days.push((c.ts - c.tps[0]!.ts) / DAY);
        s.touches.push(c.tps.length);
        seqs.set(k, s);
      }
    }
    const total = byConv.size;
    const results = [...credit.entries()]
      .filter(([, x]) => x.conversions > 0)
      .map(([v, x]) => ({
        value: v,
        conversions: round(x.conversions, 2),
        revenue: round(x.revenue, 2),
        share: total ? round((x.conversions / total) * 100, 1) : 0,
      }))
      .sort((a, b) => b.conversions - a.conversions || b.revenue - a.revenue || a.value.localeCompare(b.value))
      .slice(0, q.limit);
    const out: Record<string, unknown> = {
      period: periodOut(r),
      filters: q.filters,
      target: q.goal
        ? { type: "goal", goal: q.goal }
        : { type: "purchase", note: "new purchases (payments and revenue events, not renewals or refunds)" },
      model: q.model,
      lookback_days: q.lookback_days,
      breakdown: q.breakdown,
      conversions: total,
      revenue: round(revenue, 2),
      sampled: total >= MAX_CONVERSIONS,
      results,
      identity: {
        mode: settings.visitor_id_mode,
        note:
          settings.visitor_id_mode === "persistent"
            ? "Touchpoints are the person's sessions in the lookback: a user id links devices and days, a persistent visitor id links days."
            : `${identityNote(settings)} So an anonymous visitor's touchpoints reach back to the same UTC day only, whatever lookback_days says; identified users are linked across days and devices.`,
      },
    };
    if (q.paths) {
      out.paths = [...seqs.values()]
        .sort((a, b) => b.conversions - a.conversions || b.revenue - a.revenue)
        .slice(0, 20)
        .map((s) => ({
          path: s.path,
          conversions: s.conversions,
          revenue: round(s.revenue, 2),
          median_days_to_convert: round(median(s.days) ?? 0, 1),
          median_touchpoints: median(s.touches),
        }));
    }
    return out;
  });
}
