import { beforeEach, describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { deleteIdentity, purgeEvents } from "../../src/do/privacy";
import { parseFilters } from "../../src/lib/filters";
import { cleanEvent } from "../../src/lib/ingest-rules";
import { cleanPath, compilePathRules, normalizePathRules, pathPatternToRegExp } from "../../src/lib/pathrules";
import { redactProps, redactText } from "../../src/lib/pii";
import { spamReferrer } from "../../src/lib/referrers";
import { DAY, MIN, NOW, ev, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("PII redaction", () => {
  it("replaces emails (plain and %40) and phone numbers with formatting cues", () => {
    expect(redactText("/unsubscribe/jane.doe+x@example.co.uk")).toBe("/unsubscribe/[email]");
    expect(redactText("/u/jane%40example.com/settings")).toBe("/u/[email]/settings");
    expect(redactText("call +1 (415) 555-0123 now")).toBe("call [phone] now");
    expect(redactText("+491701234567")).toBe("[phone]");
    expect(redactText("/c/%2B441234567890")).toBe("/c/[phone]");
    expect(redactText("(415) 555-0123 or 415-555-0123 or 415.555.0123")).toBe("[phone] or [phone] or [phone]");
  });

  it("keeps order ids, timestamps, dates, versions and short numbers", () => {
    for (const s of ["/orders/1234567890123", "1793686207976", "2026-11-03", "v1.2.3", "/p/42", "+12", "SKU-123-45", "ts=1730000000"])
      expect(redactText(s)).toBe(s);
  });

  it("redacts prop values only, and leaves props JSON untouched when nothing matches", () => {
    expect(redactProps('{"email":"a@b.io","plan":"pro"}')).toBe('{"email":"[email]","plan":"pro"}');
    const clean = '{"plan":"pro"}';
    expect(redactProps(clean)).toBe(clean);
  });
});

describe("path rules", () => {
  it("* matches one segment, ** anything; first match wins; replace is literal", () => {
    expect(pathPatternToRegExp("/users/*").test("/users/42")).toBe(true);
    expect(pathPatternToRegExp("/users/*").test("/users/42/settings")).toBe(false);
    expect(pathPatternToRegExp("/docs/**").test("/docs/a/b/c")).toBe(true);
    expect(pathPatternToRegExp("/a.b/*").test("/aXb/1")).toBe(false); // dots are literal
    const rules = compilePathRules([
      { match: "/users/*/settings", replace: "/users/:id/settings" },
      { match: "/users/*", replace: "/users/:id" },
    ]);
    expect(cleanPath("/users/42/settings", rules)).toEqual({ path: "/users/:id/settings", rule: "/users/*/settings" });
    expect(cleanPath("/users/42", rules)).toEqual({ path: "/users/:id", rule: "/users/*" });
    expect(cleanPath("/pricing", rules)).toEqual({ path: "/pricing", rule: null });
    expect(normalizePathRules([{ match: "users/*", replace: "/x" }]).problems).toHaveLength(1);
  });

  it("cleanEvent redacts, then applies path rules, and keeps the url in step", () => {
    const out = cleanEvent(ev({ pathname: "/reset/jane@example.com", url: "https://example.com/reset/jane@example.com" }), {
      path_rules: [{ match: "/reset/*", replace: "/reset/:token" }],
    });
    expect(out).toMatchObject({
      redacted: true,
      path_rule: "/reset/*",
      ev: { pathname: "/reset/:token", url: "https://example.com/reset/:token" },
    });
    const off = cleanEvent(ev({ pathname: "/u/a@b.io" }), { redact_pii: false });
    expect(off.ev.pathname).toBe("/u/a@b.io");
  });
});

describe("ingest: redaction, path rules and referrer spam in the DO", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
  });

  it("stores the cleaned path, props and referrer; the engagement beacon still finds its pageview", () => {
    engine.configure(db, settings({ path_rules: [{ match: "/u/*", replace: "/u/:id" }] }));
    engine.ingest(
      db,
      [
        ev({
          ts: NOW - 10 * MIN,
          pathname: "/u/jane@example.com",
          url: "https://example.com/u/jane@example.com",
          referrer: "mail.example/inbox/jane@example.com",
          referrer_host: "mail.example",
          source: "mail.example",
          channel: "Referral",
          props: '{"phone":"+1 415 555 0123"}',
        }),
        ev({ ts: NOW - 9 * MIN, name: "engagement", pathname: "/u/jane@example.com", engagement_ms: 5000 }),
      ],
      NOW,
    );
    const row = db.all("SELECT pathname, url, referrer, props, engagement_ms FROM events")[0];
    expect(row).toEqual({
      pathname: "/u/:id",
      url: "https://example.com/u/:id",
      referrer: "mail.example/inbox/[email]",
      props: '{"phone":"[phone]"}',
      engagement_ms: 5000,
    });
    expect(JSON.stringify(db.all("SELECT * FROM sessions"))).not.toContain("jane");
  });

  it("drops built-in referrer spam (referrer_spam) and the site's exclusions.referrers (excluded_referrer)", () => {
    expect(spamReferrer("www.semalt.com")).toBe("semalt.com");
    expect(spamReferrer("example.com")).toBeNull();
    engine.configure(db, settings({ exclusions: { ips: [], paths: [], hostnames: [], countries: [], referrers: ["spammy.example"] } }));
    const r = engine.ingest(
      db,
      [
        ev({ referrer_host: "semalt.com", referrer: "semalt.com", source: "semalt.com", channel: "Referral" }),
        ev({ referrer_host: "a.spammy.example", referrer: "a.spammy.example", source: "a.spammy.example", channel: "Referral" }),
        ev({}),
      ],
      NOW,
    );
    expect(r.results.map((x) => x.reason ?? "ok")).toEqual(["referrer_spam", "excluded_referrer", "ok"]);
    expect(engine.summary(db, NOW).dropped_last_7d).toMatchObject({
      referrer_spam: { count: 1 },
      excluded_referrer: { count: 1, rule: "spammy.example" },
    });
  });
});

describe("delete_visitor", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings());
    // anonymous visit, then the same visitor signs up (server event with user_id), then pays
    engine.ingest(db, [ev({ ts: NOW - 3 * DAY, visitor_hash: "va" })], NOW);
    engine.ingest(db, [ev({ ts: NOW - 3 * DAY + MIN, visitor_hash: "va", origin: "server", name: "signup", user_id: "u1" })], NOW);
    engine.ingest(
      db,
      [ev({ ts: NOW - DAY, visitor_hash: "vb", origin: "server", name: "login", user_id: "u1", country: "DE", city: "Berlin" })],
      NOW,
    );
    payments.ingestPayments(db, [pay({ external_id: "p1", user_id: "u1", amount: 20, ts: NOW - DAY + MIN, customer: "cust_hash" })], NOW, {
      trustBrowserUserId: true,
    });
    engine.ingest(db, [ev({ ts: NOW - MIN, visitor_hash: "other" })], NOW);
  });

  it("user:<id> deletes the user's sessions incl. pre-identify ones; payments stay as revenue with no link to them", () => {
    const usage = engine.usageOn(db, "2026-11-03").events;
    const res = deleteIdentity(db, "user:u1");
    expect(res).toEqual({ events_deleted: 3, sessions_deleted: 2, payments: { unlinked: 1 }, visitor_ids: 2 });
    expect(db.all("SELECT visitor_id FROM sessions")).toEqual([{ visitor_id: "other" }]);
    expect(db.all("SELECT visitor_id, session_id, user_id, city, revenue, channel FROM events WHERE origin = 'payment'")).toEqual([
      { visitor_id: "erased", session_id: "erased", user_id: null, city: null, revenue: 20, channel: "Direct" },
    ]);
    expect(db.all("SELECT customer FROM payments")).toEqual([{ customer: null }]);
    expect(engine.usageOn(db, "2026-11-03").events).toBe(usage); // budgets never given back
    expect(deleteIdentity(db, "user:u1")).toBeNull();
  });

  it("payments: delete removes them; a customer key finds the person through their payments", () => {
    const res = deleteIdentity(db, "customer:x", { customerHash: "cust_hash", payments: "delete" });
    // the customer's payment links to u1's session, so the whole person goes: both of u1's sessions
    expect(res).toMatchObject({ sessions_deleted: 2, events_deleted: 3, payments: { deleted: 1 } });
    expect(db.all("SELECT COUNT(*) AS n FROM payments")).toEqual([{ n: 0 }]);
    expect(deleteIdentity(db, "other")).toMatchObject({ sessions_deleted: 1, events_deleted: 1 });
  });
});

describe("purge by filter", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ allowed_hostnames: ["example.com", "staging.example.com"] }));
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 30 * MIN, hostname: "staging.example.com" }),
        ev({ ts: NOW - 29 * MIN, hostname: "staging.example.com", pathname: "/b" }),
        ev({ ts: NOW - 28 * MIN, pathname: "/live" }),
        ev({ ts: NOW - 20 * MIN, visitor_hash: "v2", hostname: "staging.example.com" }),
      ],
      NOW,
    );
    payments.ingestPayments(db, [pay({ visitor_id: "v2", ts: NOW - 19 * MIN })], NOW);
  });

  it("dry run counts; a real run deletes, removes empty sessions and recounts the rest; payments are skipped", () => {
    const req = { period: "24h" as const, filters: parseFilters("hostname==staging.example.com"), dry_run: true };
    const dry = purgeEvents(db, settings(), req, NOW) as any;
    expect(dry).toMatchObject({ dry_run: true, matched: { events: 3, sessions: 2, payment_events_skipped: 1 }, deleted: { events: 0 } });
    expect(db.all("SELECT COUNT(*) AS n FROM events")[0]!.n).toBe(5);
    const run = purgeEvents(db, settings(), { ...req, dry_run: false }, NOW) as any;
    expect(run).toMatchObject({ dry_run: false, deleted: { events: 3, sessions: 0 }, more: false });
    // v1's session keeps /live (entry and exit recomputed); v2's session keeps its payment
    expect(db.all("SELECT visitor_id, pageviews, entry_page, exit_page FROM sessions ORDER BY visitor_id")).toEqual([
      { visitor_id: "v1", pageviews: 1, entry_page: "/live", exit_page: "/live" },
      { visitor_id: "v2", pageviews: 0, entry_page: null, exit_page: null },
    ]);
    expect(db.all("SELECT name FROM events ORDER BY ts")).toEqual([{ name: "pageview" }, { name: "payment" }]);
  });
});

describe("validate_only and debug events", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ path_rules: [{ match: "/u/*", replace: "/u/:id" }] }));
  });

  it("a dry run reports the exact row, warnings and drops, and stores and counts nothing", () => {
    const r = engine.ingest(
      db,
      [
        ev({
          pathname: "/u/jane@x.io",
          revenue: 9,
          currency: "USD",
          ...{ source: "Google", channel: "Organic Search" as const, referrer_host: "www.google.com", referrer: "google.com" },
        }),
        ev({ hostname: "evil.example", visitor_hash: "v2" }),
        ev({ ts: NOW - MIN + 1000, name: "signup" }),
      ],
      NOW,
      { dryRun: true },
    );
    expect(r.results[0]).toMatchObject({
      ok: true,
      new_session: true,
      warnings: ["browser_revenue_ignored"],
      stored: { name: "pageview", pathname: "/u/:id", channel: "Organic Search", source: "Google", revenue: null, debug: false },
    });
    expect(r.results[1]).toMatchObject({ ok: false, reason: "hostname_not_allowed" });
    // the third event joins the session the first one would have opened, inside the same dry run
    expect(r.results[2]).toMatchObject({ ok: true, new_session: false, stored: { name: "signup", channel: "Organic Search" } });
    expect(db.all("SELECT COUNT(*) AS n FROM events")).toEqual([{ n: 0 }]);
    expect(db.all("SELECT COUNT(*) AS n FROM sessions")).toEqual([{ n: 0 }]);
    expect(engine.usageOn(db, "2026-11-03")).toMatchObject({ events: 0 });
    expect(engine.summary(db, NOW).dropped_last_7d).toEqual({});
  });

  it("debug events are stored, counted against budgets, left out of reports, visible with debug=only, purged after 7 days", () => {
    engine.ingest(db, [ev({ debug: true }), ev({ visitor_hash: "v2" })], NOW);
    expect(engine.usageOn(db, "2026-11-03").events).toBe(2);
    const visitors = (debug?: "include" | "only") =>
      (engine.stats(db, settings(), { period: "24h", metrics: ["visitors"], filters: [], debug }, NOW) as any).metrics.visitors;
    expect([visitors(), visitors("include"), visitors("only")]).toEqual([1, 2, 1]);
    const rt = engine.realtime(db, { filters: [], debug: "only" }, NOW) as any;
    expect(rt.recent_events.map((e: any) => [e.visitor_id, e.debug])).toEqual([["v1", true]]);
    expect(rt.visitors_last_30m).toBe(1);
    engine.ingest(db, [ev({ ts: NOW - 8 * DAY, debug: true, visitor_hash: "old" })], NOW - 8 * DAY);
    engine.purge(db, 400, NOW);
    expect(db.all("SELECT visitor_id FROM events WHERE debug = 1")).toEqual([{ visitor_id: "v1" }]);
  });

  it("realtime: window minutes, breakdown, filters and since", () => {
    engine.ingest(
      db,
      [
        ev({ ts: NOW - 50 * MIN, visitor_hash: "a", country: "DE" }),
        ev({ ts: NOW - 3 * MIN, visitor_hash: "b", country: "US", pathname: "/p" }),
        ev({ ts: NOW - 2 * MIN, visitor_hash: "c", country: "US" }),
      ],
      NOW,
    );
    const rt = engine.realtime(db, { minutes: 60, breakdown: "country", filters: [] }, NOW) as any;
    expect(rt.window).toMatchObject({ minutes: 60, visitors: 3, pageviews: 3 });
    expect(rt.window.breakdown).toEqual({
      property: "country",
      results: [
        { value: "US", visitors: 2 },
        { value: "DE", visitors: 1 },
      ],
    });
    const us = engine.realtime(db, { filters: parseFilters("country==US") }, NOW) as any;
    expect(us.visitors_last_30m).toBe(2);
    const tail = engine.realtime(db, { filters: [], since: NOW - 3 * MIN }, NOW) as any;
    expect(tail.recent_events.map((e: any) => e.visitor_id)).toEqual(["c"]);
    expect(tail.next_since).toBe(NOW - 2 * MIN);
  });
});
