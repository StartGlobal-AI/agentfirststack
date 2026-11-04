import { describe, expect, it } from "vitest";
import { CONNECTORS } from "../src/destinations";
import { buildAnalyticsBody } from "../src/destinations/analytics";
import { buildGa4Body, ga4Url } from "../src/destinations/ga4";
import {
  adsDateTime,
  buildDataManagerBody,
  buildUploadClickConversionsBody,
  googleAccessToken,
  googleAdsCredentials,
  rfc3339,
  tokenCacheKey,
} from "../src/destinations/google-ads";
import { buildMetaRequest } from "../src/destinations/meta";
import { buildTiktokBody } from "../src/destinations/tiktok";
import type { DispatchEvent } from "../src/destinations/types";
import { signWebhook, webhook, webhookUrlProblem } from "../src/destinations/webhook";
import { sha256HexSync } from "../src/lib/sha256";
import { aggregateStatus, planDispatch } from "../src/service/dispatch-plan";

const TS = Date.UTC(2026, 10, 3, 12, 30, 45, 123); // 2026-11-03T12:30:45.123Z
const em = sha256HexSync("jane@example.com");
const ph = sha256HexSync("16505551212");
const ph164 = sha256HexSync("+16505551212");

function event(over: Partial<DispatchEvent> = {}): DispatchEvent {
  return {
    event_id: "evt.abc123",
    name: "purchase",
    ts: TS,
    source: "browser",
    value: 49.5,
    currency: "USD",
    transaction_id: "T-1001",
    items: [{ item_id: "sku1", item_name: "Shirt", price: 24.75, quantity: 2 }],
    page_url: "https://example.com/thank-you",
    referrer: "https://google.com/",
    ip: "203.0.113.7",
    user_agent: "Mozilla/5.0 Chrome/130",
    geo: { country: "US", region: "California", region_code: "CA", city: "San Francisco" },
    visitor_id: "vis123.1700000000",
    ga_client_id: "123456789.1700000000",
    ga_session_id: "1700000123",
    click_ids: { gclid: "Cj0KCQgclid", ttclid: "ttclid123" },
    fbp: "fb.1.1596403881668.1116446470",
    fbc: "fb.1.1554763741205.AbCdEf",
    ttp: "ttp123",
    user: { em, ph, ph_e164: ph164, country: "us" },
    consent: { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
    send_to: {
      ga4: { event_name: "purchase" },
      meta: { event_name: "Purchase" },
      tiktok: { event_name: "CompletePayment" },
      google_ads: {},
      analytics: {},
    },
    ...over,
  };
}

describe("every connector", () => {
  it("accepts its documented example credentials", () => {
    for (const c of Object.values(CONNECTORS)) expect(c.credentials.safeParse(c.example).success, c.type).toBe(true);
  });
});

describe("Meta Conversions API payload", () => {
  const creds = { pixel_id: "1234567890123456", access_token: "EAAB".padEnd(30, "x"), test_event_code: "TEST123" };
  it("matches the documented shape", () => {
    const r = buildMetaRequest(event(), creds, false);
    expect(r.url).toBe(`https://graph.facebook.com/v26.0/1234567890123456/events?access_token=${creds.access_token}`);
    const body = r.body as { data: Record<string, unknown>[]; test_event_code?: string };
    expect(body.test_event_code).toBeUndefined();
    const d = body.data[0]!;
    expect(d).toMatchObject({
      event_name: "Purchase",
      event_time: Math.floor(TS / 1000),
      event_id: "evt.abc123",
      action_source: "website",
      event_source_url: "https://example.com/thank-you",
    });
    expect(d.user_data).toMatchObject({
      em: [em],
      ph: [ph],
      country: ["79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621"],
      client_ip_address: "203.0.113.7",
      client_user_agent: "Mozilla/5.0 Chrome/130",
      fbc: "fb.1.1554763741205.AbCdEf",
      fbp: "fb.1.1596403881668.1116446470",
    });
    expect(d.custom_data).toMatchObject({
      value: 49.5,
      currency: "USD",
      order_id: "T-1001",
      content_ids: ["sku1"],
      contents: [{ id: "sku1", quantity: 2, item_price: 24.75 }],
    });
  });
  it("adds test_event_code only in test mode", () => {
    expect((buildMetaRequest(event(), creds, true).body as { test_event_code?: string }).test_event_code).toBe("TEST123");
  });
  it("server events without a browser use system_generated", () => {
    const d = (
      buildMetaRequest(event({ user_agent: undefined, page_url: undefined }), creds, false).body as { data: { action_source: string }[] }
    ).data[0]!;
    expect(d.action_source).toBe("system_generated");
  });
});

describe("GA4 Measurement Protocol payload", () => {
  const creds = { measurement_id: "G-ABC123XYZ", api_secret: "secret123" };
  it("matches the documented shape", () => {
    const b = buildGa4Body(event({ user: { em, em_ga4: sha256HexSync("janedoe@gmail.com"), ph_e164: ph164 } }), creds) as Record<
      string,
      any
    >;
    expect(b.client_id).toBe("123456789.1700000000");
    expect(b.timestamp_micros).toBe(TS * 1000);
    expect(b.consent).toEqual({ ad_user_data: "GRANTED", ad_personalization: "GRANTED" });
    expect(b.user_data).toEqual({ sha256_email_address: [sha256HexSync("janedoe@gmail.com")], sha256_phone_number: [ph164] });
    expect(b.user_location).toEqual({ city: "San Francisco", region_id: "US-CA", country_id: "US" });
    expect(b.ip_override).toBeUndefined();
    expect(b.events[0].name).toBe("purchase");
    expect(b.events[0].params).toMatchObject({
      value: 49.5,
      currency: "USD",
      transaction_id: "T-1001",
      session_id: "1700000123",
      engagement_time_msec: 1,
    });
  });
  it("drops user_data when ad_user_data is denied, and uses the validation server in test", () => {
    const b = buildGa4Body(event({ consent: { ad_user_data: "denied" } }), creds) as Record<string, any>;
    expect(b.user_data).toBeUndefined();
    expect(b.consent.ad_user_data).toBe("DENIED");
    expect(ga4Url(creds, true)).toBe("https://www.google-analytics.com/debug/mp/collect?measurement_id=G-ABC123XYZ&api_secret=secret123");
    expect(ga4Url({ ...creds, region: "eu" }, false)).toContain("https://region1.google-analytics.com/mp/collect");
  });
});

describe("Google Ads payloads", () => {
  const creds = googleAdsCredentials.parse({
    customer_id: "123-456-7890",
    conversion_action_id: "987654321",
    login_customer_id: "111-222-3333",
    client_id: "cid.apps.googleusercontent.com",
    client_secret: "secret",
    refresh_token: "1//refresh-token",
  });
  it("strips hyphens from ids", () => {
    expect(creds.customer_id).toBe("1234567890");
    expect(creds.login_customer_id).toBe("1112223333");
  });
  it("Data Manager events:ingest body", () => {
    const b = buildDataManagerBody(
      event({ user: { em, em_gads: sha256HexSync("janedoe@gmail.com"), ph_e164: ph164 } }),
      creds,
      true,
    ) as Record<string, any>;
    expect(b.destinations).toEqual([
      {
        operatingAccount: { accountType: "GOOGLE_ADS", accountId: "1234567890" },
        loginAccount: { accountType: "GOOGLE_ADS", accountId: "1112223333" },
        productDestinationId: "987654321",
      },
    ]);
    expect(b.encoding).toBe("HEX");
    expect(b.validateOnly).toBe(true);
    expect(b.consent).toEqual({ adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" });
    expect(b.events[0]).toEqual({
      adIdentifiers: { gclid: "Cj0KCQgclid", landingPageDeviceInfo: { userAgent: "Mozilla/5.0 Chrome/130", ipAddress: "203.0.113.7" } },
      conversionValue: 49.5,
      currency: "USD",
      transactionId: "T-1001",
      eventTimestamp: "2026-11-03T12:30:45+00:00",
      eventSource: "WEB",
      userData: { userIdentifiers: [{ emailAddress: sha256HexSync("janedoe@gmail.com") }, { phoneNumber: ph164 }] },
    });
  });
  it("per-conversion conversion action override", () => {
    const b = buildDataManagerBody(event({ send_to: { google_ads: { conversion_action_id: "555" } } }), creds, false) as Record<
      string,
      any
    >;
    expect(b.destinations[0].productDestinationId).toBe("555");
  });
  it("Google Ads API uploadClickConversions body", () => {
    const b = buildUploadClickConversionsBody(event({ click_ids: { gclid: "G1", gbraid: "B1" } }), creds, false) as Record<string, any>;
    expect(b.partialFailure).toBe(true);
    expect(b.validateOnly).toBe(false);
    expect(b.conversions[0]).toEqual({
      gclid: "G1",
      conversionAction: "customers/1234567890/conversionActions/987654321",
      conversionDateTime: "2026-11-03 12:30:45+00:00",
      conversionValue: 49.5,
      currencyCode: "USD",
      orderId: "T-1001",
      userIdentifiers: [
        { userIdentifierSource: "FIRST_PARTY", hashedEmail: em },
        { userIdentifierSource: "FIRST_PARTY", hashedPhoneNumber: ph164 },
      ],
      consent: { adUserData: "GRANTED", adPersonalization: "GRANTED" },
    });
  });
  it("gbraid-only uploads omit user identifiers (Google ignores them)", () => {
    const b = buildUploadClickConversionsBody(event({ click_ids: { gbraid: "B1" } }), creds, false) as Record<string, any>;
    expect(b.conversions[0].gbraid).toBe("B1");
    expect(b.conversions[0].userIdentifiers).toBeUndefined();
  });
  it("date formats", () => {
    expect(rfc3339(TS)).toBe("2026-11-03T12:30:45+00:00");
    expect(adsDateTime(TS)).toBe("2026-11-03 12:30:45+00:00");
  });
  it("access tokens are cached by a hash of the whole credential tuple, never shared across credentials", async () => {
    const base = googleAdsCredentials.parse({
      customer_id: "1234567890",
      conversion_action_id: "987654321",
      client_id: "1234567890-abc.apps.googleusercontent.com",
      client_secret: "GOCSPX-secret-one",
      refresh_token: "1//0g-tenant-a-SAME-LAST-12",
    });
    // Same client id and the same last 12 characters of the refresh token (the old cache key).
    const other = { ...base, refresh_token: "1//0g-tenant-b-SAME-LAST-12" };
    expect(await tokenCacheKey(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(await tokenCacheKey(other)).not.toBe(await tokenCacheKey(base));
    expect(await tokenCacheKey({ ...base, client_secret: "GOCSPX-secret-two" })).not.toBe(await tokenCacheKey(base));
    expect(await tokenCacheKey({ ...base, login_customer_id: "1112223333" })).not.toBe(await tokenCacheKey(base));
    expect(await tokenCacheKey({ ...base })).toBe(await tokenCacheKey(base));
    let calls = 0;
    const ctx = {
      test: true,
      env: {},
      destinationId: "dst_x",
      containerId: "ctr_x",
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        const rt = new URLSearchParams(String(init?.body)).get("refresh_token");
        return Response.json({ access_token: `token-for-${rt}`, expires_in: 3600 });
      }) as typeof fetch,
    };
    expect((await googleAccessToken(base, ctx)).token).toBe(`token-for-${base.refresh_token}`);
    expect((await googleAccessToken(other, ctx)).token).toBe(`token-for-${other.refresh_token}`);
    expect((await googleAccessToken(base, ctx)).token).toBe(`token-for-${base.refresh_token}`);
    expect(calls).toBe(2);
  });
});

describe("TikTok Events API 2.0 payload", () => {
  it("matches the web event shape", () => {
    const b = buildTiktokBody(
      event(),
      { pixel_code: "C1A2B3C4D5E6F7G8H9I0", access_token: "x".repeat(32), test_event_code: "TEST1" },
      true,
    ) as Record<string, any>;
    expect(b.event_source).toBe("web");
    expect(b.event_source_id).toBe("C1A2B3C4D5E6F7G8H9I0");
    expect(b.test_event_code).toBe("TEST1");
    expect(b.data[0]).toMatchObject({
      event: "CompletePayment",
      event_time: Math.floor(TS / 1000),
      event_id: "evt.abc123",
      user: { email: em, phone: ph164, ttclid: "ttclid123", ttp: "ttp123", ip: "203.0.113.7", user_agent: "Mozilla/5.0 Chrome/130" },
      page: { url: "https://example.com/thank-you", referrer: "https://google.com/" },
      properties: { value: 49.5, currency: "USD", order_id: "T-1001", content_type: "product" },
    });
    expect(
      buildTiktokBody(event(), { pixel_code: "C1A2B3C4D5E6F7G8H9I0", access_token: "x".repeat(32), test_event_code: "TEST1" }, false)
        .test_event_code,
    ).toBeUndefined();
  });
});

describe("analytics app ingest payload", () => {
  it("passes the visitor's ip, ua and geo explicitly", () => {
    const b = buildAnalyticsBody(event({ analytics_visitor_id: "av1" }));
    expect(b.events[0]).toMatchObject({
      name: "purchase",
      timestamp: TS,
      url: "https://example.com/thank-you",
      visitor_id: "av1",
      ip: "203.0.113.7",
      user_agent: "Mozilla/5.0 Chrome/130",
      country: "US",
      region: "California",
      city: "San Francisco",
      revenue: { amount: 49.5, currency: "USD" },
      props: { event_id: "evt.abc123", transaction_id: "T-1001", source: "tags" },
      region_code: "CA",
      click_id_type: "gclid",
      click_id: "Cj0KCQgclid",
    });
    const ft = buildAnalyticsBody(
      event({ first_touch: { utm_source: "google", utm_campaign: "spring", landing_page: "x" }, click_ids: {} }),
    ).events[0]!;
    expect(ft).toMatchObject({ utm_source: "google", utm_campaign: "spring" });
    expect(ft).not.toHaveProperty("click_id_type");
  });
});

describe("webhook", () => {
  it("signs timestamp.body with HMAC-SHA256", async () => {
    const body = JSON.stringify({ hello: "world" });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("s3cret-value-123456"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`1700000000.${body}`)));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await signWebhook("s3cret-value-123456", 1700000000, body)).toBe(`sha256=${hex}`);
  });
  it("refuses this deployment's own hosts, at save time and at send time", async () => {
    const c = { url: "https://tags.example.net/collect", secret: "x".repeat(16) };
    expect(() => webhook.check!(c, { PUBLIC_BASE_URL: "https://tags.example.net" })).toThrow(/this deployment/);
    expect(() => webhook.check!(c, {}, ["https://tags.example.net"])).toThrow(/this deployment/);
    expect(() =>
      webhook.check!({ ...c, url: "https://hooks.example.net/x" }, { PUBLIC_BASE_URL: "https://tags.example.net" }),
    ).not.toThrow();
    let called = 0;
    const r = await webhook.send(event(), c, {
      test: false,
      fetch: (async () => (called++, new Response("{}"))) as typeof fetch,
      env: { PUBLIC_BASE_URL: "https://tags.example.net" },
      destinationId: "dst_x",
      containerId: "ctr_x",
    });
    expect(r).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/this deployment/) });
    expect(called).toBe(0);
  });
  it("refuses the platform's apex and every subdomain, IP literals and local names", async () => {
    const hosted = {
      PUBLIC_BASE_URL: "https://tags.example.net",
      AUTH_ISSUER: "https://example.net",
      ANALYTICS_BASE_URL: "https://analytics.example.net",
    };
    const bad = [
      "https://example.net/v1/signup",
      "https://EXAMPLE.net./v1/signup",
      "https://mail.example.net/v1/inboxes",
      "https://replay.example.net/x",
      "https://a.b.example.net/x",
      "https://203.0.113.9/hook",
      "https://[2001:db8::1]/hook",
      "https://intranet.local/hook",
      "https://localhost/hook",
      "http://hooks.example.org/x",
    ];
    for (const url of bad) expect(webhookUrlProblem(url, hosted), url).not.toBeNull();
    expect(webhookUrlProblem("https://example.net/v1/signup", hosted)).toMatch(/this deployment/);
    for (const url of ["https://hooks.example.org/x", "https://example.net.hooks.example.org/x", "https://notexample.net/x"])
      expect(webhookUrlProblem(url, hosted), url).toBeNull();
    // Only the apex the hosts share: a single tags host blocks itself and its subdomains, not its parent.
    expect(webhookUrlProblem("https://hooks.example.net/x", { PUBLIC_BASE_URL: "https://tags.example.net" })).toBeNull();
    expect(webhookUrlProblem("https://x.tags.example.net/x", { PUBLIC_BASE_URL: "https://tags.example.net" })).not.toBeNull();
    // Local dev: http to another localhost port (the smoke test's sink) is fine; the site's port isn't.
    const dev = { DEV_MODE: "true", AUTH_ISSUER: "http://localhost:8786", ANALYTICS_BASE_URL: "http://localhost:8787" };
    expect(webhookUrlProblem("http://127.0.0.1:9999/hook", dev)).toBeNull();
    expect(webhookUrlProblem("http://localhost:8786/v1/signup", dev)).not.toBeNull();
    // A destination saved before the platform's hosts were known is refused when it sends.
    let called = 0;
    const r = await webhook.send(
      event(),
      { url: "https://example.net/v1/signup", secret: "x".repeat(16) },
      {
        test: true,
        fetch: (async () => (called++, new Response("{}"))) as typeof fetch,
        env: hosted,
        destinationId: "d",
        containerId: "c",
      },
    );
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(called).toBe(0);
  });
  it("answers never relay anything that looks like a key or token", async () => {
    const key = `afs_${"k3y".repeat(14)}`;
    const send = (body: string) =>
      webhook.send(
        event(),
        { url: "https://hooks.example.org/x", secret: "x".repeat(16) },
        {
          test: true,
          fetch: (async () => new Response(body, { status: 201 })) as typeof fetch,
          env: {},
          destinationId: "d",
          containerId: "c",
        },
      );
    const json = await send(
      JSON.stringify({ api_key: key, account_id: "acct_8f3k2m9x1q7w4e6r", note: `your key is ${key}`, ok: true, count: 3 }),
    );
    expect(json.http_status).toBe(201);
    expect(json.response).toMatchObject({
      api_key: "[redacted]",
      account_id: "[redacted]",
      note: "your key is [redacted]",
      ok: true,
      count: 3,
    });
    const text = await send(`created: ${key} (store it)`);
    expect(text.response).toBe("created: [redacted] (store it)");
    for (const r of [json, text]) expect(JSON.stringify(r.response)).not.toMatch(/afs_|k3y/);
    // Short ordinary answers still come back.
    expect((await send('{"received":true,"status":"ok"}')).response).toEqual({ received: true, status: "ok" });
  });
  it("doesn't follow redirects (3xx is a final failure) and reads a bounded response", async () => {
    const seen: RequestInit[] = [];
    const ctx = (res: () => Response) => ({
      test: false,
      fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => (seen.push(init!), res())) as typeof fetch,
      env: {},
      destinationId: "dst_x",
      containerId: "ctr_x",
    });
    const c = { url: "https://hooks.example.net/x", secret: "x".repeat(16) };
    const r = await webhook.send(
      event(),
      c,
      ctx(() => new Response(null, { status: 307, headers: { location: "https://tags.example.net/collect" } })),
    );
    expect(seen[0]!.redirect).toBe("manual");
    expect(r).toMatchObject({ ok: false, retryable: false, http_status: 307, error: expect.stringMatching(/not followed/) });
    const big = await webhook.send(
      event(),
      c,
      ctx(() => new Response("y".repeat(5 * 1024 * 1024))),
    );
    expect(big.ok).toBe(true);
    expect(String(big.response).length).toBeLessThanOrEqual(2000);
  });
  it("platform connectors don't follow redirects either and clip huge answers", async () => {
    const { execute } = await import("../src/destinations/types");
    const seen: RequestInit[] = [];
    const r = await execute(
      { url: "https://graph.facebook.com/x", method: "POST", headers: {}, body: {} },
      {
        test: false,
        fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => (
          seen.push(init!), new Response("z".repeat(5 * 1024 * 1024))
        )) as typeof fetch,
        env: {},
        destinationId: "d",
        containerId: "c",
      },
    );
    expect(seen[0]!.redirect).toBe("manual");
    expect(String(r.response)).toMatch(/\.\.\.\(truncated\)$/);
    expect(String(r.response).length).toBeLessThan(5000);
  });
  it("requires https except localhost in DEV_MODE", () => {
    expect(() => webhook.check!({ url: "http://example.com/x", secret: "x".repeat(16) }, {})).toThrow();
    expect(() => webhook.check!({ url: "http://localhost:9/x", secret: "x".repeat(16) }, {})).toThrow();
    expect(() => webhook.check!({ url: "http://localhost:9/x", secret: "x".repeat(16) }, { DEV_MODE: "true" })).not.toThrow();
    expect(() => webhook.check!({ url: "https://example.com/x", secret: "x".repeat(16) }, {})).not.toThrow();
  });
});

describe("dispatch planning", () => {
  const dests = [
    { id: "ga", type: "ga4", enabled: true, settings: {} },
    { id: "me", type: "meta", enabled: true, settings: {} },
    { id: "ga_ads", type: "google_ads", enabled: true, settings: {} },
    { id: "wh", type: "webhook", enabled: true, settings: {} },
    { id: "off", type: "tiktok", enabled: false, settings: {} },
    { id: "filtered", type: "webhook", enabled: true, settings: { conversions: ["lead"] } },
  ];
  it("routes by mapping, skips GA4 when the browser tag sent it, honours filters", () => {
    const plan = planDispatch(event({ fired: ["ga4", "meta_pixel"] }), dests);
    expect(plan).toEqual([
      { destination_id: "ga", type: "ga4", status: "skipped", reason: expect.stringContaining("already sent") },
      { destination_id: "me", type: "meta", status: "queued" },
      { destination_id: "ga_ads", type: "google_ads", status: "queued" },
      { destination_id: "wh", type: "webhook", status: "queued" },
    ]);
  });
  it("the 'browser tag already fired' skip applies to a browser hit's own copy, never to a backend event", () => {
    // A forged /collect hit can claim fired: ["ga4", "analytics"]; that only affects its own copy.
    const browser = planDispatch(event({ fired: ["ga4", "analytics"] }), [
      ...dests,
      { id: "an", type: "analytics", enabled: true, settings: {} },
    ]);
    expect(browser.filter((p) => p.status === "skipped").map((p) => p.destination_id)).toEqual(["ga", "an"]);
    const server = planDispatch(event({ source: "server", fired: ["ga4", "analytics"] }), [
      ...dests,
      { id: "an", type: "analytics", enabled: true, settings: {} },
    ]);
    expect(server.find((p) => p.destination_id === "ga")).toMatchObject({ status: "queued" });
    expect(server.find((p) => p.destination_id === "an")).toMatchObject({ status: "queued" });
  });
  it("consent and missing identifiers", () => {
    const plan = planDispatch(event({ consent: { ad_user_data: "denied", analytics_storage: "granted" }, click_ids: {} }), dests);
    expect(plan.find((p) => p.type === "meta")).toMatchObject({ status: "skipped", reason: expect.stringContaining("consent") });
    const noIds = planDispatch(event({ click_ids: {}, user: {} }), dests);
    expect(noIds.find((p) => p.type === "google_ads")).toMatchObject({ status: "skipped", reason: expect.stringContaining("click id") });
  });
  it("platforms without send_to mapping are not targeted", () => {
    const plan = planDispatch(event({ send_to: {} }), dests);
    expect(plan.map((p) => p.type)).toEqual(["webhook"]);
  });
  it("aggregate status", () => {
    const r = (s: string) => ({ type: "x", status: s as "delivered", updated_at: 0 });
    expect(aggregateStatus({})).toBe("logged");
    expect(aggregateStatus({ a: r("queued") })).toBe("pending");
    expect(aggregateStatus({ a: r("delivered"), b: r("failed") })).toBe("partial");
    expect(aggregateStatus({ a: r("skipped") })).toBe("skipped");
    expect(aggregateStatus({ a: r("delivered"), b: r("skipped") })).toBe("delivered");
  });
});
