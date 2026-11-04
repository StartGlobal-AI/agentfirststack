import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { applySubscriptions, listSubscriptions, mrrReport } from "../../src/do/subscriptions";
import { convert, expectedLatestDay, parseEcbXml } from "../../src/lib/fx";
import { DAY, NOW, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

/** The shape of the ECB's eurofxref files (rates are illustrative). */
export const ECB_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-11-03'>
      <Cube currency='USD' rate='1.0800'/>
      <Cube currency='GBP' rate='0.8400'/>
      <Cube currency='JPY' rate='162.50'/>
    </Cube>
    <Cube time='2026-11-02'>
      <Cube currency='USD' rate='1.0700'/>
      <Cube currency='GBP' rate='0.8300'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("ECB rates", () => {
  it("parses the daily and history files", () => {
    const days = parseEcbXml(ECB_SAMPLE);
    expect(days).toEqual([
      { day: "2026-11-03", rates: { USD: 1.08, GBP: 0.84, JPY: 162.5 } },
      { day: "2026-11-02", rates: { USD: 1.07, GBP: 0.83 } },
    ]);
    expect(parseEcbXml("<html>not it</html>")).toEqual([]);
  });

  it("converts through EUR and flags stale rates", () => {
    // 108 USD -> EUR at 1.08 = 100; USD -> GBP = 108 / 1.08 * 0.84 = 84
    expect(convert(108, "2026-11-03", { per_eur: 1.08, day: "2026-11-03" }, { per_eur: 1, day: "2026-11-03" })).toMatchObject({
      amount: 100,
      fallback: false,
    });
    expect(convert(108, "2026-11-03", { per_eur: 1.08, day: "2026-11-03" }, { per_eur: 0.84, day: "2026-11-03" }).amount).toBe(84);
    // A Sunday uses Friday's rate (not a fallback); ten days later it is.
    expect(convert(1, "2026-11-08", { per_eur: 1.08, day: "2026-11-06" }, { per_eur: 1, day: "2026-11-08" }).fallback).toBe(false);
    expect(convert(1, "2026-11-16", { per_eur: 1.08, day: "2026-11-06" }, { per_eur: 1, day: "2026-11-16" })).toMatchObject({
      fallback: true,
      day: "2026-11-06",
    });
  });

  it("knows when the next publication is due", () => {
    expect(expectedLatestDay(Date.UTC(2026, 10, 3, 16, 0))).toBe("2026-11-03"); // Tuesday after 15:30 UTC
    expect(expectedLatestDay(Date.UTC(2026, 10, 3, 9, 0))).toBe("2026-11-02");
    expect(expectedLatestDay(Date.UTC(2026, 10, 8, 12, 0))).toBe("2026-11-06"); // Sunday: Friday
  });
});

describe("converted money in the DO", () => {
  it("payments keep their original amount, currency and rate", () => {
    const db = memoryDb();
    engine.configure(db, settings({ currency: "EUR" }));
    payments.ingestPayments(
      db,
      [pay({ amount: 100, currency: "EUR", original_amount: 108, original_currency: "USD", fx_rate: 0.925926, fx_day: "2026-11-03" })],
      NOW,
    );
    payments.ingestPayments(
      db,
      [pay({ external_id: "pi_2", amount: 20, currency: "EUR", original_amount: 20, original_currency: "EUR" })],
      NOW,
    );
    const list = payments.listPayments(db, settings(), { start: NOW - DAY, end: NOW + DAY, limit: 10, offset: 0 }) as any;
    const byId = Object.fromEntries(list.payments.map((p: any) => [p.external_id, p]));
    expect(byId.pi_1).toMatchObject({
      amount: 100,
      currency: "EUR",
      original: { amount: 108, currency: "USD", fx_rate: 0.925926, fx_day: "2026-11-03", fx_fallback: false },
    });
    expect(byId.pi_2.original).toBeUndefined();
  });

  it("subscriptions stay on their first rate: exchange-rate moves aren't expansion", () => {
    const db = memoryDb();
    const s = settings({ currency: "EUR" });
    engine.configure(db, s);
    const base = {
      provider: "stripe",
      external_id: "sub_fx",
      customer: null,
      status: "active" as const,
      plan: "pro",
      currency: "USD",
      mrr: 108,
      price_mrr: 108,
      interval: "month" as const,
      interval_count: 1,
      quantity: 1,
      trial_start: null,
      trial_end: null,
      started_at: NOW - 20 * DAY,
      canceled_at: null,
      ended_at: null,
      cancel_at_period_end: false,
      visitor_id: null,
      session_id: null,
      user_id: null,
      livemode: true,
      fx_to: "EUR",
    };
    applySubscriptions(db, [{ ...base, ts: NOW - 20 * DAY, fx_rate: 1 / 1.08 }], NOW);
    // The rate moved; the price didn't: nothing changes.
    expect(applySubscriptions(db, [{ ...base, ts: NOW - DAY, fx_rate: 1 / 1.2 }], NOW)[0]).toMatchObject({ changed: false });
    // A real price change, still at the first rate.
    expect(applySubscriptions(db, [{ ...base, mrr: 216, price_mrr: 216, ts: NOW, fx_rate: 1 / 1.2 }], NOW)[0]!.changes).toEqual([
      "expansion",
    ]);
    const sub = (listSubscriptions(db, { limit: 5, offset: 0 }) as any).subscriptions[0];
    expect(sub).toMatchObject({ mrr: 200, currency: "EUR", original: { mrr: 216, currency: "USD" } });
    expect((mrrReport(db, s, { period: "30d" } as any, NOW) as any).current).toMatchObject({ mrr: 200, currency: "EUR" });
  });
});

describe("FxRates (security review finding 1)", () => {
  it("reads each currency once and resolves every day in memory", async () => {
    const { FxRates } = await import("../../src/service/fx");
    let queries = 0;
    const rows = {
      USD: [
        { day: "2026-11-02", per_eur: 1.07 },
        { day: "2026-11-03", per_eur: 1.08 },
      ],
    } as Record<string, { day: string; per_eur: number }[]>;
    const env = {
      DB: { prepare: () => ({ bind: (c: string) => ({ all: async () => (queries++, { results: rows[c] ?? [] }) }) }) },
    } as never;
    const r = new FxRates(env);
    const days = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-08", "2026-11-02"];
    const out = await Promise.all(days.map((d) => r.rate("USD", d)));
    expect(out.map((x) => x?.per_eur)).toEqual([1.07, 1.07, 1.08, 1.08, 1.07]);
    expect(await r.rate("EUR", "2026-11-03")).toEqual({ per_eur: 1, day: "2026-11-03" });
    expect(await r.rate("XYZ", "2026-11-03")).toBeNull();
    expect(queries).toBe(2); // USD once, XYZ once
  });
});
