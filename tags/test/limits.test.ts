import { describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES, platformApex, readTextBounded, targetsDeployment, targetsPlatform } from "../src/lib/http";
import { escapeHtml, interpolateHtml } from "../src/lib/html";
import { eventQuotaError } from "../src/service/budget";
import {
  capVar,
  circuitBreaker,
  containerCaps,
  deliveryBudgets,
  eventBudgets,
  limits,
  needsAggregate,
  standingCap,
  standingFlag,
  utcDay,
} from "../src/service/limits";

const claimed = { suspended: false, claimed: true };
const unclaimed = { suspended: false, claimed: false };

describe("storage and fan-out caps", () => {
  it("safe defaults when unset; 0 turns a cap off; junk falls back to the default", () => {
    expect(limits({})).toEqual({
      maxVersions: 50,
      maxDraftBytes: 512 * 1024,
      maxDestinations: 10,
      maxContainers: Number.POSITIVE_INFINITY,
      maxAccountBytes: 20 * 1024 * 1024,
      maxCustomCodeBytes: Number.POSITIVE_INFINITY,
    });
    expect(limits({ MAX_VERSIONS_PER_CONTAINER: "5", MAX_DRAFT_BYTES: "1000", MAX_DESTINATIONS_PER_CONTAINER: "3" })).toMatchObject({
      maxVersions: 5,
      maxDraftBytes: 1000,
      maxDestinations: 3,
    });
    expect(limits({ MAX_TAGS_BYTES_PER_ACCOUNT: "0", MAX_CONTAINERS_PER_ACCOUNT: "0" })).toMatchObject({
      maxAccountBytes: Number.POSITIVE_INFINITY,
      maxContainers: Number.POSITIVE_INFINITY,
    });
    expect(capVar("0", 10)).toBe(Number.POSITIVE_INFINITY);
    expect(capVar("", 10)).toBe(10);
    expect(capVar("-3", 10)).toBe(10);
    expect(capVar("1.5", 10)).toBe(10);
    expect(capVar("lots", 10)).toBe(10);
  });
  it("every cap reads UNCLAIMED_<NAME> first for unclaimed accounts (capFor), with 0 = off", () => {
    const vars = { MAX_CONTAINERS_PER_ACCOUNT: "10", UNCLAIMED_MAX_CONTAINERS_PER_ACCOUNT: "2", MAX_TAGS_BYTES_PER_ACCOUNT: "1000" };
    expect(limits(vars, unclaimed)).toMatchObject({ maxContainers: 2, maxAccountBytes: 1000 });
    expect(limits(vars, claimed)).toMatchObject({ maxContainers: 10 });
    expect(standingCap({ X: "5", UNCLAIMED_X: "0" }, unclaimed, "X", 7)).toBe(Number.POSITIVE_INFINITY);
    expect(standingCap({ X: "junk" }, claimed, "X", 7)).toBe(7);
    expect(
      containerCaps({ MAX_EVENTS_PER_CONTAINER_PER_DAY: "50000", UNCLAIMED_MAX_EVENTS_PER_CONTAINER_PER_DAY: "100" }, unclaimed),
    ).toEqual({
      eventsPerDay: 100,
      deliveriesPerDay: Number.POSITIVE_INFINITY,
      visitors: 250_000,
      dbBytes: 1024 * 1024 * 1024,
    });
    expect(deliveryBudgets({ MAX_DELIVERIES_PER_DAY: "1000", UNCLAIMED_MAX_DELIVERIES_PER_DAY: "10" }, unclaimed)).toEqual({
      perAccount: Number.POSITIVE_INFINITY,
      platform: 10,
    });
    expect(deliveryBudgets({ MAX_DELIVERIES_PER_DAY: "1000", UNCLAIMED_MAX_DELIVERIES_PER_DAY: "10" }, claimed).platform).toBe(1000);
  });
  it("custom code flag: claimed accounts default to allowed, unclaimed to refused", () => {
    expect(standingFlag({}, claimed, "ALLOW_CUSTOM_CODE", true, false)).toBe(true);
    expect(standingFlag({}, unclaimed, "ALLOW_CUSTOM_CODE", true, false)).toBe(false);
    expect(standingFlag({ UNCLAIMED_ALLOW_CUSTOM_CODE: "true" }, unclaimed, "ALLOW_CUSTOM_CODE", true, false)).toBe(true);
    expect(standingFlag({ ALLOW_CUSTOM_CODE: "false" }, claimed, "ALLOW_CUSTOM_CODE", true, false)).toBe(false);
    // The claimed switch doesn't open it up for unclaimed accounts.
    expect(standingFlag({ ALLOW_CUSTOM_CODE: "true" }, unclaimed, "ALLOW_CUSTOM_CODE", true, false)).toBe(false);
  });
  it("event budgets per account and platform-wide: off when unset or 0, UNCLAIMED_ values for unclaimed accounts", () => {
    const off = { perAccount: Number.POSITIVE_INFINITY, platform: Number.POSITIVE_INFINITY };
    expect(eventBudgets({})).toEqual(off);
    expect(needsAggregate(eventBudgets({}))).toBe(false);
    expect(eventBudgets({ MAX_EVENTS_PER_ACCOUNT_PER_DAY: "0", MAX_EVENTS_PER_DAY: "0" }, unclaimed)).toEqual(off);
    const vars = {
      MAX_EVENTS_PER_ACCOUNT_PER_DAY: "100000",
      UNCLAIMED_MAX_EVENTS_PER_ACCOUNT_PER_DAY: "5000",
      MAX_EVENTS_PER_DAY: "5000000",
      UNCLAIMED_MAX_EVENTS_PER_DAY: "2000000",
    };
    expect(eventBudgets(vars, claimed)).toEqual({ perAccount: 100_000, platform: 5_000_000 });
    expect(eventBudgets(vars, unclaimed)).toEqual({ perAccount: 5000, platform: 2_000_000 });
    // Without an UNCLAIMED_ value, unclaimed accounts get the plain one; "0" turns it off for them alone.
    expect(eventBudgets({ MAX_EVENTS_PER_DAY: "10" }, unclaimed).platform).toBe(10);
    expect(eventBudgets({ MAX_EVENTS_PER_DAY: "10", UNCLAIMED_MAX_EVENTS_PER_DAY: "0" }, unclaimed).platform).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(needsAggregate(eventBudgets({ MAX_EVENTS_PER_DAY: "10" }))).toBe(true);
  });
  it("event quota refusals: 429 quota_exceeded for every scope, saying when they reset", () => {
    for (const scope of ["container", "account", "platform"] as const)
      for (const kind of ["browser", "server"] as const) {
        const e = eventQuotaError({}, { scope, kind, limit: 10, used: 7 });
        expect([e.status, e.code], `${scope} ${kind}`).toEqual([429, "quota_exceeded"]);
        expect(`${e.message} ${e.hint}`, `${scope} ${kind}`).toMatch(/00:00 UTC/);
      }
    expect(eventQuotaError({}, { scope: "account", kind: "browser", limit: 10 }).message).toBe(
      "This account received its 10 browser events for today across its containers; hits are dropped until 00:00 UTC.",
    );
    // The platform's answers say it's reached and when it resets, never a deployment-wide number.
    for (const kind of ["browser", "server"] as const) {
      const e = eventQuotaError({}, { scope: "platform", kind, limit: 123_456, used: 98_765 });
      expect(`${e.message} ${e.hint}`).not.toMatch(/\d{3}/);
      expect(e.message).toMatch(/daily budget of (browser|backend) events is reached.*until 00:00 UTC/);
    }
    // The per-container answers are unchanged.
    expect(eventQuotaError({}, { scope: "container", kind: "browser", limit: 10 }).message).toBe(
      "This container received its 10 browser events for today; hits are dropped until 00:00 UTC.",
    );
    expect(eventQuotaError({}, { scope: "container", kind: "server", limit: 10, used: 7 }).hint).toBe(
      "Send fewer (or smaller batches) and retry after 00:00 UTC. GET /v1/containers/:id shows stats.today.",
    );
    // Account and platform hints point to claiming when the deployment has a site.
    expect(eventQuotaError({ AUTH_ISSUER: "https://afs.test/" }, { scope: "account", kind: "browser", limit: 1 }).hint).toMatch(
      /POST https:\/\/afs\.test\/v1\/claim-link/,
    );
    expect(eventQuotaError({ AUTH_ISSUER: "https://afs.test" }, { scope: "container", kind: "browser", limit: 1 }).hint).not.toMatch(
      /claim/,
    );
  });
  it("circuit breaker defaults and the UTC day", () => {
    expect(circuitBreaker({})).toEqual({ failures: 20, openMs: 60 * 60_000 });
    expect(circuitBreaker({ CIRCUIT_BREAKER_FAILURES: "0", CIRCUIT_BREAKER_MINUTES: "0" })).toEqual({
      failures: Number.POSITIVE_INFINITY,
      openMs: 60 * 60_000,
    });
    expect(utcDay(Date.UTC(2026, 10, 3, 23, 59))).toBe("2026-11-03");
  });
});

describe("bounded response reads", () => {
  const stream = (chunks: number, size: number) => {
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ >= chunks) return c.close();
        c.enqueue(new Uint8Array(size).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    return { res: new Response(body), cancelled: () => cancelled, pulled: () => sent };
  };
  it("stops at the cap and cancels the rest of the body", async () => {
    const s = stream(10_000, 16 * 1024); // a 160 MB answer
    const r = await readTextBounded(s.res, MAX_RESPONSE_BYTES);
    expect(MAX_RESPONSE_BYTES).toBe(64 * 1024);
    expect(r.text.length).toBe(64 * 1024);
    expect(r.truncated).toBe(true);
    expect(s.cancelled()).toBe(true);
    expect(s.pulled()).toBeLessThan(10);
  });
  it("reads small bodies whole", async () => {
    expect(await readTextBounded(new Response('{"ok":true}'), 100)).toEqual({ text: '{"ok":true}', truncated: false });
    expect(await readTextBounded(new Response(null, { status: 204 }), 100)).toEqual({ text: "", truncated: false });
  });
});

describe("destinations can't target this deployment", () => {
  const own = [new URL("https://tags.example.net"), new URL("http://localhost:8788")];
  it("by hostname (any port); a different localhost port is another service only in dev", () => {
    expect(targetsDeployment(new URL("https://tags.example.net/collect"), own, false)).toBe(true);
    expect(targetsDeployment(new URL("https://TAGS.example.net:8443/v1/signup"), own, false)).toBe(true);
    expect(targetsDeployment(new URL("https://hooks.example.net/x"), own, false)).toBe(false);
    expect(targetsDeployment(new URL("http://localhost:8788/collect"), own, true)).toBe(true);
    expect(targetsDeployment(new URL("http://localhost:8799/hook"), own, true)).toBe(false);
    expect(targetsDeployment(new URL("http://localhost:8799/hook"), own, false)).toBe(true);
  });
  it("the platform's shared apex: derived from its hosts, never a public suffix", () => {
    expect(platformApex(["tags.agentfirststack.com", "agentfirststack.com", "analytics.agentfirststack.com"])).toBe("agentfirststack.com");
    expect(platformApex(["tags.agentfirststack.com", "analytics.agentfirststack.com"])).toBe("agentfirststack.com");
    expect(platformApex(["tags.shop.co.uk", "analytics.shop.co.uk"])).toBe("shop.co.uk");
    expect(platformApex(["tags.a.co.uk", "analytics.b.co.uk"])).toBeNull(); // only co.uk in common
    expect(platformApex(["afs-tags.a.workers.dev", "afs-site.b.workers.dev"])).toBeNull();
    expect(platformApex(["tags.foo.com", "analytics.bar.com"])).toBeNull();
    expect(platformApex(["tags.example.com"])).toBeNull();
    expect(platformApex(["localhost", "127.0.0.1"])).toBeNull();
  });
  it("targetsPlatform: every host, its subdomains, and the shared apex with all of its subdomains", () => {
    const env = {
      PUBLIC_BASE_URL: "https://tags.agentfirststack.com",
      AUTH_ISSUER: "https://agentfirststack.com",
      ANALYTICS_BASE_URL: "https://analytics.agentfirststack.com",
    };
    const hit = (u: string, extra: string[] = []) => targetsPlatform(new URL(u), env, extra, false);
    for (const u of [
      "https://agentfirststack.com/v1/signup",
      "https://agentfirststack.com:8443/v1/signup",
      "https://mail.agentfirststack.com/v1/inboxes",
      "https://replay.agentfirststack.com/",
      "https://x.y.agentfirststack.com/",
      "https://Agentfirststack.COM./v1/signup",
    ])
      expect(hit(u), u).toBe(true);
    for (const u of ["https://agentfirststack.com.evil.test/", "https://notagentfirststack.com/", "https://hooks.example.net/"])
      expect(hit(u), u).toBe(false);
    // Hosts on different domains: each host and its subdomains (no common apex to block).
    const split = { PUBLIC_BASE_URL: "https://tags.foo.com", ANALYTICS_BASE_URL: "https://analytics.bar.com" };
    expect(targetsPlatform(new URL("https://x.analytics.bar.com/"), split, [], false)).toBe(true);
    expect(targetsPlatform(new URL("https://bar.com/"), split, [], false)).toBe(false);
    // The origin an API call came in on counts too.
    expect(targetsPlatform(new URL("https://api.tags.test/"), {}, ["https://tags.test"], false)).toBe(true);
  });
});

describe("custom_html templating escapes page data", () => {
  it("encodes markup, quotes, backticks and script-breaking characters", () => {
    const e = escapeHtml(`"><img src=x onerror=alert(1)>'\`\${x}\\`);
    expect(e).not.toMatch(/[<>"'`\\$(){}= ]/);
    expect(e).toBe("&#34;&#62;&#60;img&#32;src&#61;x&#32;onerror&#61;alert&#40;1&#41;&#62;&#39;&#96;&#36;&#123;x&#125;&#92;");
    expect(escapeHtml("Order_12.50, a@b.com:x-y")).toBe("Order_12.50, a@b.com:x-y".replace(/ /g, "&#32;"));
    expect(escapeHtml("€😀")).toBe("&#8364;&#128512;");
  });
  it("interpolates every {{var}} encoded; drops javascript:/vbscript: URLs; the template itself stays HTML", () => {
    const vars: Record<string, unknown> = {
      q: "</script><script>alert(1)</script>",
      u: " jAvA\tscript:alert(1)",
      v: "VBScript:x",
      n: 49.5,
      none: undefined,
    };
    const out = interpolateHtml(`<a href="{{u}}" title="{{ q }}">{{n}}</a><i>{{v}}{{none}}</i>`, (k) => vars[k]);
    expect(out).toBe(`<a href="" title="&#60;&#47;script&#62;&#60;script&#62;alert&#40;1&#41;&#60;&#47;script&#62;">49.5</a><i></i>`);
  });
});
