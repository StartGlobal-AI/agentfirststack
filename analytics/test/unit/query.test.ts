import { describe, expect, it } from "vitest";
import { FilterError, parseFilters, parseMetrics } from "../../src/lib/filters";
import { guardSql } from "../../src/lib/sqlguard";
import { aggregateQuery, parseFunnelSteps, toGlob, valueCond, raw, whereFrag } from "../../src/lib/query";
import { buckets, offsetSegments, previousRange, resolvePeriod, tzOffsetMs, zonedToUtc } from "../../src/lib/time";

describe("filter parsing", () => {
  it("parses ops, OR values and escapes", () => {
    expect(parseFilters("country==US|CA;page~/blog;channel!=Direct;prop:plan!~free;utm_source==a\\;b")).toEqual([
      { key: "country", op: "==", values: ["US", "CA"] },
      { key: "page", op: "~", values: ["/blog"] },
      { key: "channel", op: "!=", values: ["Direct"] },
      { key: "prop:plan", op: "!~", values: ["free"] },
      { key: "utm_source", op: "==", values: ["a;b"] },
    ]);
  });
  it("allows spaces in values and empty input", () => {
    expect(parseFilters("channel==AI Assistants")).toEqual([{ key: "channel", op: "==", values: ["AI Assistants"] }]);
    expect(parseFilters("")).toEqual([]);
    expect(parseFilters(undefined)).toEqual([]);
  });
  it("rejects unknown keys, bad syntax, empty values", () => {
    expect(() => parseFilters("nope==1")).toThrow(FilterError);
    expect(() => parseFilters("country")).toThrow(FilterError);
    expect(() => parseFilters("country==")).toThrow(FilterError);
    expect(() => parseFilters("prop:bad key==1")).toThrow(FilterError);
    expect(() => parseFilters(Array(40).fill("country==US").join(";"))).toThrow(/Too many/);
  });
  it("metrics", () => {
    expect(parseMetrics("visitors, revenue", ["visitors"])).toEqual(["visitors", "revenue"]);
    expect(parseMetrics(undefined, ["visitors"])).toEqual(["visitors"]);
    expect(() => parseMetrics("visitors,bogus", [])).toThrow(/bogus/);
  });
});

describe("SQL building is parameterised", () => {
  const ctx = {
    start: 1,
    end: 2,
    hasGoals: true,
    hasGoalValues: true,
    filters: parseFilters("country==US' OR 1=1 --;prop:plan==x\")\\;DROP TABLE events\\;--"),
  };
  it("user values never appear in the SQL text", () => {
    const q = aggregateQuery(ctx, true);
    expect(q.sql).not.toContain("OR 1=1");
    expect(q.sql).not.toContain("DROP");
    expect(q.args).toContain("US' OR 1=1 --");
    expect(q.sql.split("?").length - 1).toBe(q.args.length);
  });
  it("(none) maps to IS NULL and != is null-safe", () => {
    expect(valueCond(raw("e.country"), "==", ["(none)"]).sql).toBe("(e.country IS NULL)");
    expect(valueCond(raw("e.country"), "!=", ["US"]).sql).toBe("(e.country IS NULL OR e.country NOT IN (?))");
  });
  it("where clause binds the range", () => {
    const w = whereFrag({ ...ctx, filters: [] });
    // debug (test) events are left out unless asked for
    expect(w).toEqual({ sql: "e.ts >= ? AND e.ts < ? AND e.debug = 0", args: [1, 2] });
    // include = test traffic too, never quarantine (debug = 2), which only debug=quarantined reads
    expect(whereFrag({ ...ctx, filters: [], debug: "include" })).toEqual({ sql: "e.ts >= ? AND e.ts < ? AND e.debug < 2", args: [1, 2] });
    expect(whereFrag({ ...ctx, filters: [], debug: "only" }).sql).toContain("e.debug = 1");
    expect(whereFrag({ ...ctx, filters: [], debug: "quarantined" }).sql).toContain("e.debug = 2");
  });
  it("glob escaping keeps * as the only wildcard", () => {
    expect(toGlob("/a?b[c]/*")).toBe("/a[?]b[[]c]/*");
  });
  it("funnel steps", () => {
    expect(parseFunnelSteps("/pricing, event:signup, goal:Purchase, page:thanks")).toEqual([
      { type: "page", pattern: "/pricing" },
      { type: "event", name: "signup" },
      { type: "goal", name: "Purchase" },
      { type: "page", pattern: "/thanks" },
    ]);
    expect(() => parseFunnelSteps("/only-one")).toThrow();
    expect(() => parseFunnelSteps("/a,bogus")).toThrow();
  });
});

describe("SQL guard", () => {
  it.each([
    "SELECT * FROM events",
    "select count(*) from events;",
    "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
    "SELECT 'delete from events; drop table x' AS s",
    "SELECT substr(pathname, 2) FROM events",
    "SELECT name FROM sqlite_master",
  ])("accepts %s", (q) => expect(guardSql(q).ok).toBe(true));
  it.each([
    ["DELETE FROM events", "SELECT"],
    ["SELECT 1; DELETE FROM events", "single"],
    ["WITH x AS (SELECT 1) DELETE FROM events", "DELETE"],
    ["WITH x AS (SELECT 1) INSERT INTO goals SELECT * FROM x", "INSERT"],
    ["WITH x AS (SELECT 1) REPLACE INTO goals VALUES (1)", "REPLACE"],
    ["SELECT 1 /* ; */ ; UPDATE events SET name = 'x'", "single"],
    ["PRAGMA table_info(events)", "SELECT"],
    ["SELECT * FROM pragma_table_info('events') -- \n; ATTACH 'x' AS y", "single"],
    ["SELECT * FROM _cf_KV", "_cf_"],
    ['SELECT * FROM "_cf_KV"', "_cf_"],
    // conservative: quoted identifiers keep their names, so one named like a keyword is refused
    ['SELECT "update" FROM (SELECT 1 AS "update")', "UPDATE"],
    ["SELECT load_extension('x')", "LOAD_EXTENSION"],
    ["", "Empty"],
  ])("rejects %s", (q, why) => {
    const r = guardSql(q);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain(why.toLowerCase());
  });
});

describe("SQL guard: runaway shapes", () => {
  it.each([
    // recursion, with and without the keyword (SQLite makes a self-referencing CTE recursive anyway)
    ["WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x", "recursive"],
    ["with recursive x as (select 1) select * from x", "recursive"],
    ["WITH x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT COUNT(*) FROM x", "refers to itself"],
    ['WITH "x"(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM "x") SELECT COUNT(*) FROM x', "refers to itself"],
    ["WITH a AS (SELECT 1), x(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM (x)) SELECT COUNT(*) FROM x", "refers to itself"],
    ["WITH x(n) AS (SELECT 1 UNION ALL SELECT x.n + 1 FROM events e JOIN x ON 1 = 1) SELECT COUNT(*) FROM x", "refers to itself"],
    ["SELECT * FROM (WITH x(n) AS NOT MATERIALIZED (SELECT 1 UNION ALL SELECT n + 1 FROM x) SELECT n FROM x)", "refers to itself"],
    // comma joins, anywhere
    ["SELECT COUNT(*) FROM events a, events b", "comma joins"],
    ["SELECT COUNT(*) FROM events AS a, events AS b, events AS c", "comma joins"],
    ["SELECT * FROM sessions WHERE id IN (SELECT e.session_id FROM events e, events f)", "comma joins"],
    ["WITH t AS (SELECT * FROM events) SELECT COUNT(*) FROM t, t AS u", "comma joins"],
    ["SELECT COUNT(*) FROM events a JOIN sessions s ON s.id = a.session_id, events c", "comma joins"],
    ["SELECT COUNT(*) FROM (SELECT * FROM events) a, events b", "comma joins"],
    // too many joins
    [
      "SELECT COUNT(*) FROM events a JOIN events b ON a.visitor_id = b.visitor_id JOIN events c ON c.visitor_id = b.visitor_id JOIN events d ON d.id = c.id",
      "at most 2 joins",
    ],
    [
      "WITH x AS (SELECT a.id FROM events a JOIN events b USING (visitor_id)) SELECT * FROM x JOIN sessions s ON 1 = 1 JOIN goals g ON 1 = 1",
      "at most 2 joins",
    ],
    // cartesian joins without a condition
    ["SELECT COUNT(*) FROM events a JOIN events b", "on or using"],
    ["SELECT COUNT(*) FROM events a CROSS JOIN events b", "on or using"],
    ["SELECT COUNT(*) FROM events a INNER JOIN events AS b WHERE a.id < b.id", "on or using"],
    ["SELECT COUNT(*) FROM events a LEFT JOIN (SELECT * FROM events) b", "on or using"],
  ])("rejects %s", (q, why) => {
    const r = guardSql(q);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.toLowerCase()).toContain(why);
  });

  it.each([
    "SELECT country, COUNT(DISTINCT visitor_id) v FROM events GROUP BY 1 ORDER BY 2 DESC LIMIT 10",
    "SELECT channel, COUNT(*) FROM events WHERE ts > 0 GROUP BY channel, country ORDER BY 2 DESC, 1 LIMIT 5, 10",
    "SELECT e.pathname, s.channel FROM events e JOIN sessions s ON s.id = e.session_id",
    "SELECT e.name, s.entry_page, g.name FROM events e LEFT JOIN sessions s ON s.id = e.session_id JOIN goals g ON g.match = e.name",
    "SELECT * FROM events JOIN sessions USING (visitor_id)",
    "SELECT * FROM events NATURAL JOIN sessions",
    // table-valued functions don't need ON
    "SELECT j.key, COUNT(*) FROM events e JOIN json_each(e.props) j WHERE e.props IS NOT NULL GROUP BY 1",
    "SELECT j.value FROM events e LEFT JOIN json_each(e.props) AS j",
    // non-recursive CTEs, including one whose column shares its name
    "WITH country AS (SELECT country, COUNT(*) AS n FROM events GROUP BY country) SELECT * FROM country ORDER BY n DESC",
    "WITH a AS (SELECT visitor_id FROM events), b AS (SELECT visitor_id FROM a) SELECT COUNT(*) FROM b",
    "WITH s(id, n) AS (SELECT session_id, COUNT(*) FROM events GROUP BY 1) SELECT * FROM s JOIN sessions USING (id)",
    // commas that aren't joins: select lists, IN lists, function args, window partitions, IS DISTINCT FROM
    "SELECT name, coalesce(country, 'none'), COUNT(*) OVER (PARTITION BY name, country) FROM events WHERE name IN ('a', 'b')",
    "SELECT country IS DISTINCT FROM 'US', city FROM events",
    "SELECT 'from a, b join c' AS s, x.n FROM (SELECT 1 AS n) AS x",
    "SELECT a FROM (SELECT 1 AS a UNION ALL SELECT 2) ORDER BY a",
  ])("accepts %s", (q) => expect(guardSql(q)).toMatchObject({ ok: true }));
});

describe("periods in the site timezone", () => {
  const NOW = Date.UTC(2026, 10, 3, 15, 30); // 2026-11-03 15:30 UTC
  it("today in UTC and in New York", () => {
    expect(resolvePeriod({ period: "today" }, "UTC", NOW)).toMatchObject({
      from: "2026-11-03",
      to: "2026-11-03",
      start: Date.UTC(2026, 10, 3),
      end: Date.UTC(2026, 10, 4),
      interval: "hour",
    });
    // New York is UTC-5 on Nov 3 2026 (DST ended Nov 1)
    expect(resolvePeriod({ period: "today" }, "America/New_York", NOW)).toMatchObject({
      start: Date.UTC(2026, 10, 3, 5),
      end: Date.UTC(2026, 10, 4, 5),
    });
  });
  it("half-hour offsets (Asia/Kolkata, UTC+5:30)", () => {
    expect(resolvePeriod({ period: "yesterday" }, "Asia/Kolkata", NOW)).toMatchObject({
      from: "2026-11-02",
      start: Date.UTC(2026, 10, 1, 18, 30),
    });
  });
  it("7d / 30d include today", () => {
    expect(resolvePeriod({ period: "7d" }, "UTC", NOW)).toMatchObject({ from: "2026-10-28", to: "2026-11-03" });
    expect(resolvePeriod({ period: "30d" }, "UTC", NOW)).toMatchObject({ from: "2026-10-05", to: "2026-11-03", interval: "day" });
  });
  it("24h is the last 24 whole hours", () => {
    const r = resolvePeriod({ period: "24h" }, "UTC", NOW);
    expect(r.end - r.start).toBe(24 * 3_600_000);
    expect(r.end).toBe(Date.UTC(2026, 10, 3, 16));
  });
  it("12mo, mtd, ytd, custom, all", () => {
    expect(resolvePeriod({ period: "12mo" }, "UTC", NOW)).toMatchObject({ from: "2025-12-01", to: "2026-11-03", interval: "month" });
    expect(resolvePeriod({ period: "mtd" }, "UTC", NOW)).toMatchObject({ from: "2026-11-01" });
    expect(resolvePeriod({ period: "ytd" }, "UTC", NOW)).toMatchObject({ from: "2026-01-01" });
    expect(resolvePeriod({ from: "2026-10-01", to: "2026-10-31" }, "UTC", NOW)).toMatchObject({
      period: "custom",
      start: Date.UTC(2026, 9, 1),
      end: Date.UTC(2026, 10, 1),
    });
    expect(resolvePeriod({ period: "all" }, "UTC", NOW, Date.UTC(2026, 5, 1, 12))).toMatchObject({ from: "2026-06-01", interval: "month" });
    expect(() => resolvePeriod({ from: "2026-13-01" }, "UTC", NOW)).toThrow();
    expect(() => resolvePeriod({ from: "2026-10-05", to: "2026-10-01" }, "UTC", NOW)).toThrow();
  });
  it("custom ranges across DST are exact local midnights", () => {
    // Europe/Berlin leaves DST on 2026-10-25: Oct 24 has +2h, Oct 26 has +1h
    const r = resolvePeriod({ from: "2026-10-24", to: "2026-10-25" }, "Europe/Berlin", NOW);
    expect(r.start).toBe(Date.UTC(2026, 9, 23, 22));
    expect(r.end).toBe(Date.UTC(2026, 9, 25, 23));
    expect(buckets(r, "hour").length).toBe(48); // 24 + 25 hours, the repeated 02:00 merges
    expect(offsetSegments(r.start, r.end, "Europe/Berlin")).toEqual([
      { from: r.start, offset: 7_200_000 },
      { from: Date.UTC(2026, 9, 25, 1), offset: 3_600_000 },
    ]);
  });
  it("compare=previous: same length before; in-progress periods compare the elapsed part", () => {
    const r = resolvePeriod({ period: "7d" }, "UTC", NOW);
    const p = previousRange(r, NOW)!;
    expect(p).toMatchObject({ from: "2026-10-21", to: "2026-10-27", partial: true });
    expect(p.end - p.start).toBe(NOW - r.start);
    const y = previousRange(resolvePeriod({ period: "yesterday" }, "UTC", NOW), NOW)!;
    expect(y).toMatchObject({ from: "2026-11-01", partial: false });
    expect(previousRange(resolvePeriod({ period: "all" }, "UTC", NOW, NOW), NOW)).toBeNull();
    expect(previousRange(resolvePeriod({ period: "mtd" }, "UTC", NOW), NOW)).toMatchObject({ from: "2026-10-01" });
  });
  it("buckets: day / week (Monday labels) / month", () => {
    const r = resolvePeriod({ period: "7d" }, "UTC", NOW);
    expect(buckets(r, "day").map((b) => b.label)).toEqual([
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
    ]);
    expect(buckets(r, "week").map((b) => b.label)).toEqual(["2026-10-26", "2026-11-02"]);
    expect(buckets(resolvePeriod({ period: "12mo" }, "UTC", NOW), "month").length).toBe(12);
  });
  it("tz helpers", () => {
    expect(tzOffsetMs(NOW, "Asia/Kolkata")).toBe(19_800_000);
    expect(zonedToUtc(2026, 3, 29, 2, "Europe/Berlin")).toBe(Date.UTC(2026, 2, 29, 1)); // DST gap resolves forward
  });
});
