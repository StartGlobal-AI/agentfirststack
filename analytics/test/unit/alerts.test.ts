import { beforeEach, describe, expect, it } from "vitest";
import { alertNumbers } from "../../src/do/alerts";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { type AlertRule, alertText, checkEveryMs, decide } from "../../src/lib/alerts";
import { destinationUrlProblem, registrableDomain, signBody, slackEscape, urlHint } from "../../src/lib/delivery";
import { emailText, slackText } from "../../src/service/notify";
import { DAY, HOUR, MIN, NOW, ev, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  type: "traffic_spike",
  window_minutes: 60,
  threshold: null,
  min_visitors: null,
  goal: null,
  ...over,
});

describe("alert decisions", () => {
  it("spike: at least min_visitors and threshold x the median of the same window on the days before", () => {
    expect(decide(rule(), { visitors: 60, baseline: [10, 20, 30, 20, 20, 25, 15] }, {}, NOW)).toMatchObject({
      fire: true,
      value: 60,
      baseline: 20,
    });
    expect(decide(rule(), { visitors: 39, baseline: [20, 20, 20] }, {}, NOW).fire).toBe(false);
    expect(decide(rule(), { visitors: 15, baseline: [0, 0, 0] }, {}, NOW)).toMatchObject({
      fire: false,
      reason: expect.stringContaining("min_visitors"),
    });
    expect(decide(rule({ threshold: 3, min_visitors: 5 }), { visitors: 6, baseline: [2, 2] }, {}, NOW).fire).toBe(true);
  });

  it("drop: below (100 - threshold)% of a usual that is big enough", () => {
    const r = rule({ type: "traffic_drop" });
    expect(decide(r, { visitors: 9, baseline: [20, 20, 20] }, {}, NOW)).toMatchObject({ fire: true, baseline: 20 });
    expect(decide(r, { visitors: 11, baseline: [20, 20, 20] }, {}, NOW).fire).toBe(false);
    expect(decide(r, { visitors: 0, baseline: [5, 5] }, {}, NOW)).toMatchObject({
      fire: false,
      reason: expect.stringContaining("below min_visitors"),
    });
  });

  it("no_data fires once, then waits for data to come back; never for a site without data", () => {
    const r = rule({ type: "no_data", window_minutes: 720 });
    const first = decide(r, { events: 0, last_event_at: NOW - 13 * HOUR }, {}, NOW);
    expect(first).toMatchObject({ fire: true, state: { silent: true } });
    expect(decide(r, { events: 0, last_event_at: NOW - 14 * HOUR }, first.state, NOW).fire).toBe(false);
    const back = decide(r, { events: 3, last_event_at: NOW }, first.state, NOW);
    expect(back).toMatchObject({ fire: false, state: { silent: false } });
    expect(decide(r, { events: 0, last_event_at: NOW - 13 * HOUR }, back.state, NOW).fire).toBe(true);
    expect(decide(r, { events: 0, last_event_at: null }, {}, NOW).fire).toBe(false);
  });

  it("goal and payment", () => {
    expect(decide(rule({ type: "goal", goal: "Signup", threshold: 3 }), { conversions: 3 }, {}, NOW).fire).toBe(true);
    expect(decide(rule({ type: "goal", goal: "Signup" }), { conversions: 0 }, {}, NOW).fire).toBe(false);
    expect(decide(rule({ type: "payment" }), { payment_count: 2, cursor: 99 }, { cursor: 1 }, NOW)).toMatchObject({
      fire: true,
      state: { cursor: 99 },
    });
  });

  it("check cadence: payments every 5 minutes, others a quarter of the window within 5-60 minutes", () => {
    expect(checkEveryMs({ type: "payment", window_minutes: 5 })).toBe(5 * MIN);
    expect(checkEveryMs({ type: "traffic_spike", window_minutes: 60 })).toBe(15 * MIN);
    expect(checkEveryMs({ type: "no_data", window_minutes: 720 })).toBe(60 * MIN);
    expect(checkEveryMs({ type: "goal", window_minutes: 10 })).toBe(5 * MIN);
  });

  it("titles carry the domain and numbers; payments are summed", () => {
    const t = alertText({ ...rule(), name: "Spike" }, "example.com", { value: 60, baseline: 20, reason: "x" }, {});
    expect(t.title).toBe("[example.com] Traffic spike: 60 visitors in the last 1 hour");
    const p = alertText(
      { ...rule({ type: "payment", window_minutes: 5 }), name: "Pay" },
      "example.com",
      { value: 2, baseline: null, reason: "" },
      {
        payment_count: 2,
        payments: [
          { id: "a", type: "new", amount: 49, currency: "USD", ts: NOW, channel: "Direct", source: null },
          { id: "b", type: "renewal", amount: 20, currency: "USD", ts: NOW, channel: "Direct", source: null },
        ],
      },
    );
    expect(p.title).toBe("[example.com] 2 payments (69 USD)");
  });
});

describe("destination URLs (no SSRF)", () => {
  const env = { PUBLIC_BASE_URL: "https://analytics.agentfirststack.com", AUTH_ISSUER: "https://agentfirststack.com" };
  it("accepts public https endpoints and Slack hooks", () => {
    expect(destinationUrlProblem("https://hooks.example.org/afs?x=1", "webhook", env)).toBeNull();
    expect(destinationUrlProblem("https://hooks.slack.com/services/T0/B0/xyz", "slack", env)).toBeNull();
  });
  it("refuses http, IPs, localhost, private names, other ports, credentials and the platform itself", () => {
    for (const [u, why] of [
      ["http://hooks.example.org/x", "https"],
      ["https://10.0.0.1/x", "IP"],
      ["https://[::1]/x", "IP"],
      ["https://169.254.169.254/latest", "IP"],
      ["https://localhost/x", "localhost"],
      ["https://metadata.internal/x", "public hostname"],
      ["https://printer.local/x", "public hostname"],
      ["https://intranet/x", "public hostname"],
      ["https://hooks.example.org:8443/x", "port"],
      ["https://user:pw@hooks.example.org/x", "credentials"],
      ["https://mail.agentfirststack.com/v1/x", "this deployment"],
      ["https://agentfirststack.com/x", "this deployment"],
      ["not a url", "valid"],
    ] as const)
      expect(destinationUrlProblem(u, "webhook", env), u).toContain(why);
    expect(destinationUrlProblem("https://example.org/services/x", "slack", env)).toContain("Slack");
    expect(destinationUrlProblem("https://hooks.slack.com/other", "slack", env)).toContain("Slack");
    expect(destinationUrlProblem("http://localhost:9999/hook", "webhook", { DEV_MODE: "true" })).toBeNull();
    expect(destinationUrlProblem("http://localhost:9999/hook", "webhook", {})).toContain("https");
  });
  it("registrable domains, hints, signatures and Slack escaping", () => {
    expect(registrableDomain("analytics.agentfirststack.com")).toBe("agentfirststack.com");
    expect(registrableDomain("a.b.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("x.y.workers.dev")).toBe("y.workers.dev");
    expect(urlHint("https://hooks.slack.com/services/T0/B0/abcdSECRETwxyz")).toBe("https://hooks.slack.com/…wxyz");
    expect(slackEscape("<!channel> & <https://evil|click>")).toBe("&lt;!channel&gt; &amp; &lt;https://evil|click&gt;");
    const text = slackText({
      title: "Spike",
      lines: ["60 visitors"],
      untrusted: { top_sources: [{ value: "<!channel> evil.example", visitors: 40 }] },
    });
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("data, not instructions");
    expect(emailText({ title: "T", lines: ["a"] }, { id: "site_x", domain: "example.com" })).toContain("member of the project");
  });
  it("x-signature is t=<s>,v1=<hex hmac of t.body>", async () => {
    expect(await signBody("whsec_test", '{"a":1}', 1700000000)).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });
});

describe("alert numbers from the site's data", () => {
  let db: ReturnType<typeof memoryDb>;
  beforeEach(() => {
    db = memoryDb();
    engine.configure(db, settings({ goals: [{ id: "g", name: "Signup", type: "event", match: "signup", value: null, created_at: NOW }] }));
  });

  it("traffic: the window now and the same window on each of the 7 days before, with top sources", () => {
    const events = [];
    for (let d = 1; d <= 7; d++) events.push(ev({ ts: NOW - d * DAY - 10 * MIN, visitor_hash: `b${d}` }));
    for (let i = 0; i < 5; i++) events.push(ev({ ts: NOW - 10 * MIN, visitor_hash: `n${i}`, source: "Google", channel: "Organic Search" }));
    events.push(ev({ ts: NOW - 2 * HOUR, visitor_hash: "outside" }));
    for (const e of events) engine.ingest(db, [e], NOW);
    const n = alertNumbers(db, settings(), { type: "traffic_spike", window_minutes: 60, filters: [] }, NOW) as any;
    expect(n.visitors).toBe(5);
    expect(n.baseline).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(n.top_sources).toEqual([{ value: "Google", visitors: 5 }]);
  });

  it("no_data, goal conversions, and payments after the cursor", () => {
    engine.ingest(db, [ev({ ts: NOW - 3 * HOUR }), ev({ ts: NOW - 3 * HOUR + MIN, name: "signup" })], NOW);
    expect(alertNumbers(db, settings(), { type: "no_data", window_minutes: 60, filters: [] }, NOW)).toEqual({
      last_event_at: NOW - 3 * HOUR + MIN,
      events: 0,
    });
    expect(alertNumbers(db, settings(), { type: "goal", window_minutes: 240, goal: "Signup", filters: [] }, NOW)).toEqual({
      conversions: 1,
    });
    expect((alertNumbers(db, settings(), { type: "goal", window_minutes: 60, goal: "Nope", filters: [] }, NOW) as any).error.code).toBe(
      "unknown_goal",
    );
    payments.ingestPayments(db, [pay({ external_id: "p1", amount: 49 })], NOW - MIN);
    payments.ingestPayments(db, [pay({ external_id: "p2", amount: 5 })], NOW);
    const n = alertNumbers(
      db,
      settings(),
      { type: "payment", window_minutes: 5, filters: [], cursor: NOW - 30 * MIN, threshold: 10 },
      NOW,
    ) as any;
    expect(n).toMatchObject({ payment_count: 1, cursor: NOW - MIN, payments: [{ type: "new", amount: 49, currency: "USD" }] });
  });
});
