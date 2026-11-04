/**
 * Currency conversion with the European Central Bank's euro foreign exchange reference rates
 * (free, no key, published around 16:00 CET on TARGET working days for about 30 currencies):
 *   daily:   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
 *   90 days: https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml
 * Rates are units of a currency per 1 EUR; X -> Y = amount / rate(X) x rate(Y). A day without a
 * publication (weekend, holiday, today before 16:00 CET) uses the latest earlier day, as the ECB
 * recommends; a rate more than STALE_DAYS older than the payment, or none at or before it, is
 * flagged (fx_fallback). Pure.
 */

export const ECB_DAILY = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const ECB_90D = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";
export const FX_SOURCE = "ECB euro foreign exchange reference rates";
export const STALE_DAYS = 5;

export type DayRates = { day: string; rates: Record<string, number> };

/** The <Cube time="..."> days of an ECB XML file, with their rates. */
export function parseEcbXml(xml: string, maxDays = 400): DayRates[] {
  const out: DayRates[] = [];
  const day = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g;
  let m: RegExpExecArray | null;
  while ((m = day.exec(xml)) && out.length < maxDays) {
    const rates: Record<string, number> = {};
    const rate = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9]+(?:\.[0-9]+)?)['"]\s*\/>/g;
    let r: RegExpExecArray | null;
    while ((r = rate.exec(m[2]!))) {
      const v = Number(r[2]);
      if (v > 0 && Number.isFinite(v)) rates[r[1]!] = v;
    }
    if (Object.keys(rates).length) out.push({ day: m[1]!, rates });
  }
  return out;
}

export const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface Rate {
  /** units per EUR */
  per_eur: number;
  /** the publication day used */
  day: string;
}

export interface Conversion {
  amount: number;
  rate: number;
  day: string;
  fallback: boolean;
}

/** from -> to for a payment on `day`, given each currency's rate (EUR is 1 on every day). */
export function convert(amount: number, day: string, from: Rate, to: Rate): Conversion {
  const rate = to.per_eur / from.per_eur;
  // EUR is 1 on every day: the publication that matters is the other currency's (or the older of two).
  const stale = (r: Rate) => r.day > day || daysBetween(r.day, day) > STALE_DAYS;
  const used = [from.day, to.day].filter((d) => d !== day).sort()[0] ?? day;
  const fallback = stale(from) || stale(to);
  return { amount: Math.round(amount * rate * 1000) / 1000, rate: Math.round(rate * 1e8) / 1e8, day: used, fallback };
}

/** The latest ECB publication day expected by `now`: today after 16:30 CET (15:30 UTC), else the working day before. */
export function expectedLatestDay(now: number): string {
  let t = now - (new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes() < 15 * 60 + 30 ? 86_400_000 : 0);
  for (;;) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) return dayOf(t);
    t -= 86_400_000;
  }
}
