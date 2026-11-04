/**
 * Site currency conversion. Rates: ECB reference rates (lib/fx.ts) stored per day in D1
 * (fx_rates), fetched by the cron (at most once every FX_RETRY_MS while the newest stored day is
 * older than the latest publication; the 90-day file when the table is empty or behind).
 *
 * Payments are converted here, at ingest: amount and currency become the site's, and the
 * original amount, currency, rate and rate day are kept beside them. Subscriptions get the rate
 * attached and are converted in the site's Durable Object, which keeps each subscription on the
 * rate it was first converted at (so exchange-rate moves never show up as expansion or contraction).
 */

import { parse } from "@afs/shared";
import { z } from "zod";
import type { Bindings } from "../env";
import {
  type Conversion,
  ECB_90D,
  ECB_DAILY,
  FX_SOURCE,
  type Rate,
  convert,
  dayOf,
  daysBetween,
  expectedLatestDay,
  parseEcbXml,
} from "../lib/fx";
import type { PaymentInput } from "../lib/types";
import type { SubscriptionRecord } from "../do/subscriptions";
import type { Fetcher } from "../lib/stripe-api";
import type { Ctx, SiteRow } from "./context";

export const FX_RETRY_MS = 2 * 3_600_000;
const MAX_FX_BYTES = 512 * 1024;

type Fx = {
  original_amount?: number | null;
  original_currency?: string | null;
  fx_rate?: number | null;
  fx_day?: string | null;
  fx_fallback?: boolean;
};
export type ConvertedPayment = PaymentInput & Fx;

// ------------------------------------------------------------------ rates

/** Cron step: fetch the ECB rates when a newer publication is due and a site uses a currency. One fetch at most. */
export async function refreshFxRates(
  env: Bindings,
  now: number,
  fetcher: Fetcher = (u, i) => fetch(u, i),
): Promise<Record<string, number>> {
  if (!(await env.DB.prepare("SELECT 1 AS x FROM sites WHERE currency IS NOT NULL LIMIT 1").first())) return {};
  const r = await refresh(env, now, fetcher);
  return r.fx === "fetched" ? { fx_days_fetched: r.fx_days ?? 0 } : r.fx === "fresh" || r.fx === "waiting" ? {} : { fx_fetch_failed: 1 };
}

async function refresh(env: Bindings, now: number, fetcher: Fetcher): Promise<{ fx: string; fx_days?: number }> {
  const latest = (await env.DB.prepare("SELECT MAX(day) AS d FROM fx_rates").first<{ d: string | null }>())?.d ?? null;
  const expected = expectedLatestDay(now);
  if (latest && latest >= expected) return { fx: "fresh" };
  const last = Number((await env.DB.prepare("SELECT v FROM fx_meta WHERE k = 'last_attempt'").first<{ v: string }>())?.v ?? 0);
  if (now - last < FX_RETRY_MS) return { fx: "waiting" };
  await env.DB.prepare("INSERT INTO fx_meta (k, v) VALUES ('last_attempt', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(String(now))
    .run();
  const url = !latest || daysBetween(latest, expected) > 3 ? ECB_90D : ECB_DAILY;
  let xml: string;
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/xml" } });
    if (!res.ok) return { fx: `ecb_${res.status}` };
    xml = (await res.text()).slice(0, MAX_FX_BYTES);
  } catch {
    return { fx: "ecb_unreachable" };
  }
  const days = parseEcbXml(xml, 100);
  const rows = days.flatMap((d) => Object.entries(d.rates).map(([c, r]) => ({ d: d.day, c, r })));
  if (!rows.length) return { fx: "ecb_empty" };
  await env.DB.prepare(
    `INSERT INTO fx_rates (day, currency, per_eur)
     SELECT json_extract(value, '$.d'), json_extract(value, '$.c'), json_extract(value, '$.r') FROM json_each(?) WHERE true
     ON CONFLICT(day, currency) DO UPDATE SET per_eur = excluded.per_eur`,
  )
    .bind(JSON.stringify(rows))
    .run();
  return { fx: "fetched", fx_days: days.length };
}

/**
 * The stored rates a request (or a whole cron run) converts with: each currency's rows are read
 * once, in one D1 query, then every day is resolved in memory (the latest publication at or before
 * it, else the earliest after it). Share one instance across a run to keep D1 queries bounded.
 */
export class FxRates {
  private byCurrency = new Map<string, Promise<{ days: string[]; rates: number[] }>>();
  /** D1 queries made (one per currency) */
  queries = 0;
  constructor(private readonly env: Bindings) {}

  private table(currency: string) {
    let t = this.byCurrency.get(currency);
    if (!t) {
      this.queries++;
      t = this.env.DB.prepare("SELECT day, per_eur FROM fx_rates WHERE currency = ? ORDER BY day LIMIT 4000")
        .bind(currency)
        .all<Rate>()
        .then(({ results }) => ({ days: results.map((r) => r.day), rates: results.map((r) => r.per_eur) }));
      this.byCurrency.set(currency, t);
    }
    return t;
  }

  async rate(currency: string, day: string): Promise<Rate | null> {
    if (currency === "EUR") return { per_eur: 1, day };
    const t = await this.table(currency);
    if (!t.days.length) return null;
    // the last index with days[i] <= day (binary search), else the first row
    let lo = 0;
    let hi = t.days.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t.days[mid]! <= day) {
        at = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const i = at < 0 ? 0 : at;
    return { day: t.days[i]!, per_eur: t.rates[i]! };
  }
}

async function conversion(amount: number, from: string, to: string, ts: number, rates: FxRates): Promise<Conversion | null> {
  const day = dayOf(ts);
  const [a, b] = await Promise.all([rates.rate(from, day), rates.rate(to, day)]);
  return a && b ? convert(amount, day, a, b) : null;
}

const isPayment = (r: unknown): r is PaymentInput =>
  typeof (r as PaymentInput).type === "string" && typeof (r as PaymentInput).amount === "number";

/**
 * Payments: converted to the site currency (originals kept). Subscriptions: the day's rate
 * attached (fx_to, fx_rate) for the DO. No site currency, the same currency, or no rate for it
 * (a currency the ECB doesn't publish): left as they are.
 */
export async function convertRecords<T extends PaymentInput | SubscriptionRecord>(
  env: Bindings,
  site: SiteRow,
  records: T[],
  rates: FxRates = new FxRates(env),
): Promise<T[]> {
  const to = site.currency ?? null;
  return Promise.all(
    records.map(async (r): Promise<T> => {
      const from = r.currency?.toUpperCase() ?? null;
      if (isPayment(r)) {
        const base = { ...r, original_amount: r.amount, original_currency: from };
        if (!to || !from || from === to || r.type === "link") return base as T;
        const c = await conversion(r.amount, from, to, r.ts, rates);
        if (!c) return base as T;
        return { ...base, amount: c.amount, currency: to, fx_rate: c.rate, fx_day: c.day, fx_fallback: c.fallback } as T;
      }
      if (!to || !from || from === to) return r;
      const c = await conversion(1, from, to, r.ts, rates);
      return c ? ({ ...r, fx_to: to, fx_rate: c.rate, fx_day: c.day, fx_fallback: c.fallback } as T) : r;
    }),
  );
}

/** Costs: converted to the site currency at their day's rate (originals kept); unconvertible ones left as they are. */
export async function convertCosts<T extends { cost: number; currency: string | null; day: string }>(
  env: Bindings,
  site: SiteRow,
  rows: T[],
): Promise<(T & { original_cost: number; original_currency: string | null; fx_rate: number | null })[]> {
  const to = site.currency ?? null;
  const rates = new FxRates(env);
  return Promise.all(
    rows.map(async (r) => {
      const base = { ...r, original_cost: r.cost, original_currency: r.currency, fx_rate: null as number | null };
      if (!to || !r.currency || r.currency === to) return base;
      const c = await conversion(r.cost, r.currency, to, Date.parse(`${r.day}T12:00:00Z`), rates);
      return c ? { ...base, cost: c.amount, currency: to, fx_rate: c.rate } : base;
    }),
  );
}

// ------------------------------------------------------------------ read

export const fxInput = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD. Default today (the latest publication at or before it)."),
  base: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .describe("Express rates per 1 of this currency. Default EUR (the ECB's base)."),
});

/** The rates conversion would use for a day (verifiable: what a payment on that day is converted with). */
export async function getFxRates(ctx: Ctx, raw: unknown) {
  const q = parse(fxInput, raw);
  const day = q.date ?? dayOf(Date.now());
  const pub = await ctx.env.DB.prepare("SELECT MAX(day) AS d FROM fx_rates WHERE day <= ?").bind(day).first<{ d: string | null }>();
  const used = pub?.d ?? (await ctx.env.DB.prepare("SELECT MIN(day) AS d FROM fx_rates").first<{ d: string | null }>())?.d ?? null;
  if (!used)
    return {
      source: FX_SOURCE,
      day: null,
      rates: {},
      note: "No rates stored yet: the cron fetches them from the ECB within minutes of the first run (and every working day after 16:00 CET).",
    };
  const { results } = await ctx.env.DB.prepare("SELECT currency, per_eur FROM fx_rates WHERE day = ?")
    .bind(used)
    .all<{ currency: string; per_eur: number }>();
  const perEur: Record<string, number> = { EUR: 1, ...Object.fromEntries(results.map((r) => [r.currency, r.per_eur])) };
  const base = (q.base ?? "EUR").toUpperCase();
  const b = perEur[base];
  if (!b) return { source: FX_SOURCE, day: used, base, rates: {}, note: `${base} is not among the ECB's reference currencies.` };
  const rates = Object.fromEntries(Object.entries(perEur).map(([c, r]) => [c, Math.round((r / b) * 1e6) / 1e6]));
  return {
    source: FX_SOURCE,
    url: ECB_DAILY,
    requested: day,
    day: used,
    base,
    fallback: used > day || daysBetween(used, day) > 5,
    rates,
  };
}
