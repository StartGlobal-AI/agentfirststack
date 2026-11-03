import { describe, expect, it } from "vitest";
import { visitorName } from "../../src/lib/names";
import {
  DAYS_TO_CONVERT_BUCKETS,
  changePercent,
  detectSpike,
  histogram,
  median,
  percentile,
  spikeDescription,
  spikeTitle,
  withShares,
} from "../../src/lib/stats-math";
import { comparisonRange, resolvePeriod } from "../../src/lib/time";

describe("stats maths", () => {
  it("median, nearest-rank p75, change %", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 75)).toBe(3);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80], 75)).toBe(60);
    expect(percentile([7], 75)).toBe(7);
    expect(changePercent(150, 100)).toBe(50);
    expect(changePercent(0, 0)).toBe(0);
    expect(changePercent(5, 0)).toBeNull();
  });

  it("histogram buckets with shares", () => {
    const h = histogram([0, 0, 1, 2, 3, 9, 40], DAYS_TO_CONVERT_BUCKETS);
    expect(h.map((b) => [b.label, b.count])).toEqual([
      ["same day", 2],
      ["1 day", 1],
      ["2-3 days", 2],
      ["4-7 days", 0],
      ["8-14 days", 1],
      ["15-30 days", 0],
      ["31+ days", 1],
    ]);
    expect(h[0]!.share).toBe(28.6);
    expect(histogram([], DAYS_TO_CONVERT_BUCKETS)[0]!.share).toBe(0);
  });

  it("shares of a total", () => {
    expect(
      withShares(
        [
          { v: "a", revenue: 75 },
          { v: "b", revenue: 25 },
        ],
        "revenue",
      ).map((r) => r.share),
    ).toEqual([75, 25]);
  });
});

describe("traffic spike detection", () => {
  const baseline = Array(14).fill(10);
  it("needs history, a minimum size and a multiple of the median", () => {
    expect(detectSpike({ visitors: 100, baseline: Array(6).fill(10), sources: [] })).toBeNull(); // too little history
    expect(detectSpike({ visitors: 19, baseline: Array(14).fill(1), sources: [] })).toBeNull(); // too small
    expect(detectSpike({ visitors: 24, baseline, sources: [] })).toBeNull(); // 2.4x < 2.5x
    expect(detectSpike({ visitors: 25, baseline, sources: [] })).toMatchObject({ visitors: 25, baseline: 10, factor: 2.5, source: null });
  });

  it("names the source with the biggest gain when it explains the jump", () => {
    const s = detectSpike({
      visitors: 120,
      baseline: [...baseline.slice(0, 13), 200], // one outlier doesn't move the median
      sources: [
        { name: "Google", visitors: 15, baseline_mean: 8 },
        { name: "Facebook", visitors: 100, baseline_mean: 1 },
      ],
    })!;
    expect(s).toMatchObject({ source: "Facebook", source_visitors: 100, baseline: 10, change_percent: 1100 });
    expect(spikeTitle(s)).toBe("Traffic spike from Facebook");
    expect(spikeDescription(s)).toBe("120 visitors vs a typical 10 (12x). Facebook brought 100.");
    // spread across many sources: no single driver
    const spread = detectSpike({
      visitors: 60,
      baseline,
      sources: ["a", "b", "c", "d", "e"].map((name) => ({ name, visitors: 12, baseline_mean: 2 })),
    })!;
    expect(spread.source).toBeNull();
    expect(spikeTitle(spread)).toBe("Traffic spike");
  });
});

describe("visitor names", () => {
  it("are stable, two words and differ across ids", () => {
    expect(visitorName("abc123")).toBe(visitorName("abc123"));
    expect(visitorName("abc123")).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    const names = new Set(Array.from({ length: 200 }, (_, i) => visitorName(`v${i}`)));
    expect(names.size).toBeGreaterThan(150);
  });
});

describe("comparison ranges", () => {
  const NOW = Date.UTC(2026, 10, 3, 15, 0); // Tuesday 3 Nov 2026
  it("year: the same dates a year earlier; in-progress periods compare the elapsed part", () => {
    const r = resolvePeriod({ period: "7d" }, "UTC", NOW);
    const y = comparisonRange(r, { mode: "year" }, NOW)!;
    expect(y).toMatchObject({ from: "2025-10-28", to: "2025-11-03", partial: true, mode: "year" });
    expect(y.end - y.start).toBe(NOW - r.start);
    const done = resolvePeriod({ from: "2026-10-01", to: "2026-10-31" }, "UTC", NOW);
    expect(comparisonRange(done, { mode: "year" }, NOW)).toMatchObject({ from: "2025-10-01", to: "2025-10-31", partial: false });
  });

  it("match_weekday: previous shifts earlier (no overlap), year moves to the nearest same weekday", () => {
    const r = resolvePeriod({ from: "2026-10-07", to: "2026-10-13" }, "UTC", NOW); // Wed..Tue, 7 days: already aligned
    expect(comparisonRange(r, { mode: "previous", match_weekday: true }, NOW)).toMatchObject({ from: "2026-09-30", to: "2026-10-06" });
    const m = resolvePeriod({ from: "2026-10-01", to: "2026-10-30" }, "UTC", NOW); // 30 days from Thursday
    const p = comparisonRange(m, { mode: "previous", match_weekday: true }, NOW)!;
    expect(p).toMatchObject({ from: "2026-08-27", to: "2026-09-25" }); // Thursday, and before 1 Oct
    expect(new Date(`${p.from}T00:00:00Z`).getUTCDay()).toBe(4);
    const y = comparisonRange(r, { mode: "year", match_weekday: true }, NOW)!;
    expect(new Date(`${y.from}T00:00:00Z`).getUTCDay()).toBe(3); // a Wednesday in 2025
    expect(y.from).toBe("2025-10-08");
  });

  it("custom needs both dates; all has nothing before it", () => {
    const r = resolvePeriod({ period: "30d" }, "UTC", NOW);
    expect(comparisonRange(r, { mode: "custom", from: "2026-01-01", to: "2026-01-31" }, NOW)).toMatchObject({
      from: "2026-01-01",
      to: "2026-01-31",
      partial: false,
    });
    expect(() => comparisonRange(r, { mode: "custom", from: "2026-01-01" }, NOW)).toThrow(/compare_to/);
    expect(comparisonRange(resolvePeriod({ period: "all" }, "UTC", NOW, NOW), { mode: "previous" }, NOW)).toBeNull();
  });

  it("24h: previous is the day before, year the same hours a year earlier", () => {
    const r = resolvePeriod({ period: "24h" }, "UTC", NOW);
    expect(comparisonRange(r, { mode: "previous" }, NOW)!.start).toBe(r.start - 86_400_000);
    expect(comparisonRange(r, { mode: "year" }, NOW)!.start).toBe(Date.UTC(2025, 10, 2, 16));
  });
});
