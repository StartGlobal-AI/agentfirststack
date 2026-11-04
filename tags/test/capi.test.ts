import { describe, expect, it } from "vitest";
import {
  buildLinkedinBody,
  buildLinkedinRequest,
  LINKEDIN_TOKEN_URL,
  LINKEDIN_URL,
  LINKEDIN_VERSION,
  linkedin,
  linkedinAccessToken,
  linkedinCredentials,
  linkedinTokenCacheKey,
} from "../src/destinations/linkedin";
import { buildPinterestRequest, pinterest, pinterestCredentials, pinterestEventName } from "../src/destinations/pinterest";
import { buildRedditRequest, REDDIT_USER_AGENT, reddit, redditCredentials, redditEventType } from "../src/destinations/reddit";
import { buildSnapRequest, snap, snapCredentials, snapEventName } from "../src/destinations/snap";
import type { Connector, DispatchEvent, SendContext } from "../src/destinations/types";
import { buildXBody, buildXRequest, x, xCredentials } from "../src/destinations/x";
import { oauth1Header, oauth1Signature, percentEncode, signatureBaseString } from "../src/lib/oauth1";
import { sha256HexSync } from "../src/lib/sha256";

const TS = Date.UTC(2026, 10, 3, 12, 30, 45, 123); // 2026-11-03T12:30:45.123Z
const em = sha256HexSync("jane@example.com");
const ph = sha256HexSync("16505551212");
const ph164 = sha256HexSync("+16505551212");
const fn = sha256HexSync("jane");
const ln = sha256HexSync("doe");
const US = "79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621"; // sha256("us")

/** connectors.test.ts's fixture, plus the click ids, cookies and send_to of the new platforms. */
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
    click_ids: {
      gclid: "Cj0KCQgclid",
      ttclid: "ttclid123",
      li_fat_id: "df5gf5-gh6t7-ph4j7h-fgf6n1",
      epik: "dj0yJnU9epik",
      rdt_cid: "rdtcid-123",
      ScCid: "7b3a7917-a82a-47e8-9728-e1b3b045abb2",
      twclid: "23opevjt88psuo13lu8d020qkn",
    },
    fbp: "fb.1.1596403881668.1116446470",
    fbc: "fb.1.1554763741205.AbCdEf",
    ttp: "ttp123",
    scid: "scid-cookie-value",
    rdt_uuid: "1700000000000.5a8b0c2d-uuid",
    user: { em, ph, ph_e164: ph164, country: "us" },
    consent: { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" },
    send_to: {
      ga4: { event_name: "purchase" },
      meta: { event_name: "Purchase" },
      tiktok: { event_name: "CompletePayment" },
      google_ads: {},
      analytics: {},
      linkedin: { conversion_id: "1234567" },
      pinterest: { event_name: "checkout" },
      reddit: { event_name: "Purchase" },
      snap: { event_name: "PURCHASE" },
      x: { event_id: "tw-o1abc-ol288" },
    },
    ...over,
  };
}

/** An event with nothing to match on. */
const anonymous = () =>
  event({ user: {}, click_ids: {}, ip: undefined, user_agent: undefined, user_id: undefined, rdt_uuid: undefined, scid: undefined });

type Seen = { url: string; init: RequestInit };
function ctx(reply: (url: string, init: RequestInit) => Response, seen: Seen[] = [], test = false): SendContext {
  return {
    test,
    env: {},
    destinationId: "dst_x",
    containerId: "ctr_x",
    fetch: (async (u: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(u), init: init! });
      return reply(String(u), init!);
    }) as typeof fetch,
  };
}
const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const headersOf = (s: Seen) => s.init.headers as Record<string, string>;
const bodyOf = (s: Seen) => JSON.parse(String(s.init.body));

const creds = {
  linkedin: linkedinCredentials.parse({ ad_account_id: "512345678", access_token: "AQX-linkedin-access-token-0123456789" }),
  pinterest: pinterestCredentials.parse({ ad_account_id: "549755885175", access_token: "pina_secret-pinterest-token-0123456789" }),
  reddit: redditCredentials.parse({ pixel_id: "a2_abc123def456", access_token: "reddit-secret-token-0123456789", test_id: "t2_testid123" }),
  snap: snapCredentials.parse({ pixel_id: "1ec32188-754e-4be2-8e55-c949a984a39f", access_token: "snap-secret-token-0123456789" }),
  x: xCredentials.parse({
    pixel_id: "o1abc",
    consumer_key: "xvz1evFS4wEEPTGEFPHBog",
    consumer_secret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    access_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    access_token_secret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  }),
};

/** What each platform answers on success. */
const SUCCESS: Record<string, () => Response> = {
  linkedin: () => json(201),
  pinterest: () => json(200, { num_events_received: 1, num_events_processed: 1, events: [{ status: "processed" }] }),
  reddit: () => json(200, { data: { message: "Successfully processed 1 conversion events." } }),
  snap: () => json(200, { status: "VALID", reason: "Events have been processed successfully." }),
  x: () => json(200, { data: { conversions_processed: 1, debug_id: "ff02e052" }, request: { params: { account_id: "18ce552mlaq" } } }),
};

const CONNECTORS: [string, Connector<any>, Record<string, unknown>][] = [
  ["linkedin", linkedin, creds.linkedin],
  ["pinterest", pinterest, creds.pinterest],
  ["reddit", reddit, creds.reddit],
  ["snap", snap, creds.snap],
  ["x", x, creds.x],
];

const SECRET_FIELDS = ["access_token", "consumer_secret", "access_token_secret", "refresh_token", "client_secret"];

describe("conversion API connectors: shared contract", () => {
  it("each exports a mapped, consent-gated connector whose example passes its schema", () => {
    for (const [type, c] of CONNECTORS) {
      expect(c.type).toBe(type);
      expect(c.needsMapping, type).toBe(true);
      expect(c.requiredConsent, type).toEqual(["ad_user_data"]);
      expect(c.credentials.safeParse(c.example).success, type).toBe(true);
      expect(typeof c.naturalKey(c.example)).toBe("string");
      for (const f of c.publicFields) expect(SECRET_FIELDS, `${type}.${f}`).not.toContain(f);
      expect(c.docs).toMatch(/^https:\/\//);
      expect(c.testMode.length).toBeGreaterThan(20);
    }
  });
  it("credential schemas reject bad ids and unknown fields", () => {
    expect(linkedinCredentials.safeParse({ ...linkedin.example, ad_account_id: "urn:li:sponsoredAccount:1" }).success).toBe(false);
    expect(pinterestCredentials.safeParse({ ...pinterest.example, ad_account_id: "act_123" }).success).toBe(false);
    expect(redditCredentials.safeParse({ ...reddit.example, pixel_id: "abc123" }).success).toBe(false);
    expect(snapCredentials.safeParse({ ...snap.example, pixel_id: "1234567890" }).success).toBe(false);
    expect(xCredentials.safeParse({ ...x.example, pixel_id: "tw-o1abc-ol288" }).success).toBe(false);
    expect(xCredentials.safeParse({ ...x.example, access_token_secret: "short" }).success).toBe(false);
    expect(pinterestCredentials.safeParse({ ...pinterest.example, extra: 1 }).success).toBe(false);
  });
  it("classify 2xx / 400 / 429 / 500, and never echo a secret in the recorded request", async () => {
    for (const [type, c, cr] of CONNECTORS) {
      const ok = await c.send(event(), cr, ctx(SUCCESS[type]!));
      expect(ok, type).toMatchObject({ ok: true, retryable: false });
      for (const f of SECRET_FIELDS) if (typeof cr[f] === "string") expect(JSON.stringify(ok.request), `${type} ${f}`).not.toContain(cr[f]);
      const bad = await c.send(
        event(),
        cr,
        ctx(() => json(400, { message: "bad", error: { message: "bad" } })),
      );
      expect(bad, type).toMatchObject({ ok: false, retryable: false, http_status: 400 });
      expect(bad.error, type).toMatch(/400/);
      expect(
        await c.send(
          event(),
          cr,
          ctx(() => json(429, { message: "slow down" })),
        ),
        type,
      ).toMatchObject({ ok: false, retryable: true });
      expect(
        await c.send(
          event(),
          cr,
          ctx(() => json(500, { message: "oops" })),
        ),
        type,
      ).toMatchObject({ ok: false, retryable: true });
      expect(
        await c.send(
          event(),
          cr,
          ctx(() => json(503)),
        ),
        type,
      ).toMatchObject({ ok: false, retryable: true });
      const down = await c.send(
        event(),
        cr,
        ctx(() => {
          throw new Error("network down");
        }),
      );
      expect(down, type).toMatchObject({ ok: false, retryable: true });
    }
  });
  it("don't follow redirects", async () => {
    for (const [type, c, cr] of CONNECTORS) {
      const seen: Seen[] = [];
      const r = await c.send(
        event(),
        cr,
        ctx(() => new Response(null, { status: 302, headers: { location: "https://evil.example" } }), seen),
      );
      expect(seen.at(-1)!.init.redirect, type).toBe("manual");
      expect(r.ok, type).toBe(false);
    }
  });
  it("skip events they can't match", () => {
    for (const [type, c] of CONNECTORS) {
      expect(c.skipReason!(event()), type).toBeNull();
      expect(c.skipReason!(anonymous()), type).toMatch(/no identifier/);
    }
  });
});

describe("LinkedIn Conversions API", () => {
  it("builds the documented request", () => {
    const r = buildLinkedinRequest(event({ user: { em, fn, ln, country: "us", external_id: "cust-42" } }), creds.linkedin, "tok-123");
    expect(r.url).toBe("https://api.linkedin.com/rest/conversionEvents");
    expect(r.url).toBe(LINKEDIN_URL);
    expect(r.method).toBe("POST");
    expect(r.headers).toEqual({
      authorization: "Bearer tok-123",
      "linkedin-version": LINKEDIN_VERSION,
      "x-restli-protocol-version": "2.0.0",
    });
    expect(LINKEDIN_VERSION).toMatch(/^20\d{4}$/);
    expect(r.body).toEqual({
      conversion: "urn:lla:llaPartnerConversion:1234567",
      conversionHappenedAt: TS,
      conversionValue: { currencyCode: "USD", amount: "49.5" },
      user: {
        userIds: [
          { idType: "SHA256_EMAIL", idValue: em },
          { idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: "df5gf5-gh6t7-ph4j7h-fgf6n1" },
          { idType: "PLAINTEXT_IP_ADDRESS", idValue: "203.0.113.7" },
        ],
        userInfo: { hashedFirstName: fn, hashedLastName: ln, countryCode: "US" },
        externalIds: [sha256HexSync("cust-42")],
      },
      eventId: "evt.abc123",
    });
  });
  it("maps Insight Tag conversion ids to Conversions API rules, keeps userIds even when empty, drops IPv6", () => {
    const c = linkedinCredentials.parse({ ...creds.linkedin, conversion_rules: { "1234567": "7654321" } });
    expect((buildLinkedinBody(event(), c) as { conversion: string }).conversion).toBe("urn:lla:llaPartnerConversion:7654321");
    const other = event({ send_to: { linkedin: { conversion_id: "999" } } });
    expect((buildLinkedinBody(other, c) as { conversion: string }).conversion).toBe("urn:lla:llaPartnerConversion:999");
    const b = buildLinkedinBody(event({ user: { fn, ln }, click_ids: {}, ip: "2001:db8::1", value: undefined }), c) as Record<string, any>;
    expect(b.user.userIds).toEqual([]);
    expect(b.user.userInfo).toEqual({ hashedFirstName: fn, hashedLastName: ln, countryCode: "US" });
    expect(b.conversionValue).toBeUndefined();
    expect(linkedin.skipReason!(event({ user: {}, click_ids: {}, ip: "2001:db8::1" }))).toMatch(/no identifier/);
  });
  it("needs an access token or a full refresh tuple", () => {
    expect(() => linkedin.check!(creds.linkedin, {})).not.toThrow();
    expect(() => linkedin.check!({ ad_account_id: "512345678" }, {})).toThrow(/access_token/);
    expect(() => linkedin.check!({ ad_account_id: "512345678", refresh_token: "r".repeat(30) }, {})).toThrow(/together/);
    expect(() =>
      linkedin.check!(
        { ad_account_id: "512345678", refresh_token: "r".repeat(30), client_id: "client123", client_secret: "secret123" },
        {},
      ),
    ).not.toThrow();
  });
  it("sends with the stored token and says how to fix 401 / 403", async () => {
    const seen: Seen[] = [];
    await linkedin.send(event(), creds.linkedin, ctx(SUCCESS.linkedin!, seen));
    expect(seen[0]!.url).toBe(LINKEDIN_URL);
    expect(headersOf(seen[0]!).authorization).toBe(`Bearer ${creds.linkedin.access_token}`);
    expect(headersOf(seen[0]!)["linkedin-version"]).toBe(LINKEDIN_VERSION);
    expect(bodyOf(seen[0]!).eventId).toBe("evt.abc123");
    const r401 = await linkedin.send(
      event(),
      creds.linkedin,
      ctx(() => json(401, { message: "Invalid access token", status: 401 })),
    );
    expect(r401).toMatchObject({ ok: false, retryable: false });
    expect(r401.error).toMatch(/Invalid access token.*60 days/);
    const r403 = await linkedin.send(
      event(),
      creds.linkedin,
      ctx(() => json(403, { message: "Not enough permissions" })),
    );
    expect(r403.error).toMatch(/non-viewer role/);
  });
  it("refreshes access tokens, cached by a hash of the refresh tuple, and retries once on a stale cached token", async () => {
    const base = linkedinCredentials.parse({
      ad_account_id: "512345678",
      refresh_token: "AQW-refresh-token-tenant-a-0123456789",
      client_id: "861hhm46p48to2",
      client_secret: "gPecS7yqHkyyShvR",
    });
    const other = { ...base, refresh_token: "AQW-refresh-token-tenant-b-0123456789" };
    expect(await linkedinTokenCacheKey(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(await linkedinTokenCacheKey(other)).not.toBe(await linkedinTokenCacheKey(base));
    expect(await linkedinTokenCacheKey({ ...base, client_secret: "another-secret" })).not.toBe(await linkedinTokenCacheKey(base));
    let minted = 0;
    let rejectNext = false;
    const seen: Seen[] = [];
    const c = ctx((url, init) => {
      if (url === LINKEDIN_TOKEN_URL) {
        const form = new URLSearchParams(String(init.body));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("client_id")).toBe(base.client_id);
        minted++;
        return json(200, { access_token: `token-${minted}-for-${form.get("refresh_token")}`, expires_in: 5_184_000 });
      }
      if (rejectNext) {
        rejectNext = false;
        return json(401, { message: "Expired" });
      }
      return json(201);
    }, seen);
    expect((await linkedinAccessToken(base, c)).token).toBe(`token-1-for-${base.refresh_token}`);
    expect((await linkedinAccessToken(other, c)).token).toBe(`token-2-for-${other.refresh_token}`);
    expect(await linkedinAccessToken(base, c)).toMatchObject({ token: `token-1-for-${base.refresh_token}`, cached: true });
    expect(minted).toBe(2);
    // A send with a cached token that LinkedIn rejects mints a new one and retries once.
    rejectNext = true;
    seen.length = 0;
    const r = await linkedin.send(event(), base, c);
    expect(r.ok).toBe(true);
    expect(minted).toBe(3);
    expect(seen.map((s) => s.url)).toEqual([LINKEDIN_URL, LINKEDIN_TOKEN_URL, LINKEDIN_URL]);
    expect(headersOf(seen[2]!).authorization).toBe(`Bearer token-3-for-${base.refresh_token}`);
    expect(JSON.stringify(r.request)).not.toContain(base.client_secret);
  });
  it("a failed refresh is reported without the secrets", async () => {
    const c = linkedinCredentials.parse({
      ad_account_id: "512345678",
      refresh_token: "AQW-refresh-token-revoked-0123456789",
      client_id: "861hhm46p48to2",
      client_secret: "gPecS7yqHkyyShvR",
    });
    const r = await linkedin.send(
      event(),
      c,
      ctx(() => json(400, { error: "invalid_request", error_description: "The provided authorization grant or refresh token is invalid" })),
    );
    expect(r).toMatchObject({ ok: false, retryable: false, http_status: 400 });
    expect(r.error).toMatch(/refresh failed: invalid_request/);
    expect(JSON.stringify(r)).not.toContain("gPecS7yqHkyyShvR");
    expect(JSON.stringify(r)).not.toContain("AQW-refresh-token-revoked");
  });
});

describe("Pinterest Conversions API", () => {
  it("builds the documented request", () => {
    const r = buildPinterestRequest(
      event({ user: { em, ph, fn, ln, ct: "san francisco", st: "ca", zp: "94105", country: "us", external_id: "cust-42" } }),
      creds.pinterest,
      false,
    );
    expect(r.url).toBe("https://api.pinterest.com/v5/ad_accounts/549755885175/events");
    expect(r.method).toBe("POST");
    expect(r.headers).toEqual({ authorization: `Bearer ${creds.pinterest.access_token}` });
    const d = (r.body as { data: Record<string, any>[] }).data[0]!;
    expect(d).toMatchObject({
      event_name: "checkout",
      action_source: "web",
      event_time: Math.floor(TS / 1000),
      event_id: "evt.abc123",
      event_source_url: "https://example.com/thank-you",
    });
    expect(d.opt_out).toBeUndefined();
    expect(d.user_data).toEqual({
      em: [em],
      ph: [ph],
      fn: [fn],
      ln: [ln],
      ct: [sha256HexSync("sanfrancisco")],
      st: [sha256HexSync("ca")],
      zp: [sha256HexSync("94105")],
      country: [US],
      external_id: [sha256HexSync("cust-42")],
      client_ip_address: "203.0.113.7",
      client_user_agent: "Mozilla/5.0 Chrome/130",
      click_id: "dj0yJnU9epik",
    });
    expect(d.custom_data).toEqual({
      currency: "USD",
      value: "49.5",
      order_id: "T-1001",
      content_ids: ["sku1"],
      contents: [{ id: "sku1", item_name: "Shirt", item_price: "24.75", quantity: 2 }],
      num_items: 2,
    });
  });
  it("test mode is ?test=true (from ctx.test or event.test)", async () => {
    expect(buildPinterestRequest(event(), creds.pinterest, true).url).toBe(
      "https://api.pinterest.com/v5/ad_accounts/549755885175/events?test=true",
    );
    const seen: Seen[] = [];
    await pinterest.send(event({ test: true }), creds.pinterest, ctx(SUCCESS.pinterest!, seen));
    await pinterest.send(event(), creds.pinterest, ctx(SUCCESS.pinterest!, seen, true));
    await pinterest.send(event(), creds.pinterest, ctx(SUCCESS.pinterest!, seen));
    expect(seen.map((s) => s.url.endsWith("?test=true"))).toEqual([true, true, false]);
  });
  it("maps tag event names, opts out when ad personalization is denied, and needs email or ip + user agent", () => {
    expect(pinterestEventName("addtocart")).toBe("add_to_cart");
    expect(pinterestEventName("pagevisit")).toBe("page_visit");
    expect(pinterestEventName("Lead")).toBe("lead");
    expect(pinterestEventName("view_category")).toBe("view_category");
    const d = (
      buildPinterestRequest(event({ consent: { ad_user_data: "granted", ad_personalization: "denied" } }), creds.pinterest, false).body as {
        data: Record<string, unknown>[];
      }
    ).data[0]!;
    expect(d.opt_out).toBe(true);
    expect(pinterest.skipReason!(event({ user: { ph }, user_agent: undefined }))).toMatch(/no identifier/);
    expect(pinterest.skipReason!(event({ user: {} }))).toBeNull(); // ip + user agent
  });
  it("200 with an unprocessed event and 422 are final failures", async () => {
    const r = await pinterest.send(
      event(),
      creds.pinterest,
      ctx(() =>
        json(200, { num_events_received: 1, num_events_processed: 0, events: [{ status: "failed", error_message: "Invalid event_name" }] }),
      ),
    );
    expect(r).toMatchObject({ ok: false, retryable: false, http_status: 200 });
    expect(r.error).toMatch(/Invalid event_name/);
    const r422 = await pinterest.send(
      event(),
      creds.pinterest,
      ctx(() => json(422, { code: 4, message: "Not all events were processed", details: {} })),
    );
    expect(r422).toMatchObject({ ok: false, retryable: false });
    expect(r422.error).toMatch(/422: Not all events/);
  });
});

describe("Reddit Conversions API v3", () => {
  it("builds the documented request", () => {
    const gmail = sha256HexSync("janedoe@gmail.com");
    const r = buildRedditRequest(event({ user: { em, em_gads: gmail, ph_e164: ph164, external_id: "cust-42" } }), creds.reddit, false);
    expect(r.url).toBe("https://ads-api.reddit.com/api/v3/pixels/a2_abc123def456/conversion_events");
    expect(r.method).toBe("POST");
    expect(r.headers).toEqual({ authorization: `Bearer ${creds.reddit.access_token}`, "user-agent": REDDIT_USER_AGENT });
    const body = r.body as { data: { test_id?: string; events: Record<string, any>[] } };
    expect(body.data.test_id).toBeUndefined();
    expect(body.data.events[0]).toEqual({
      event_at: TS,
      action_source: "WEBSITE",
      event_source_url: "https://example.com/thank-you",
      referrer_url: "https://google.com/",
      type: { tracking_type: "PURCHASE" },
      click_id: "rdtcid-123",
      metadata: {
        conversion_id: "evt.abc123",
        order_id: "T-1001",
        currency: "USD",
        value: 49.5,
        item_count: 2,
        products: [{ id: "sku1", name: "Shirt", quantity: 2, item_price: 24.75 }],
      },
      user: {
        email: gmail,
        phone_number: ph164,
        external_id: sha256HexSync("cust-42"),
        ip_address: "203.0.113.7",
        user_agent: "Mozilla/5.0 Chrome/130",
        uuid: "1700000000000.5a8b0c2d-uuid",
      },
    });
  });
  it("test mode adds data.test_id only when configured", () => {
    const withId = buildRedditRequest(event(), creds.reddit, true).body as { data: { test_id?: string } };
    expect(withId.data.test_id).toBe("t2_testid123");
    const { test_id: _t, ...noId } = creds.reddit;
    expect((buildRedditRequest(event(), noId, true).body as { data: { test_id?: string } }).data.test_id).toBeUndefined();
  });
  it("maps pixel event names to v3 tracking types, custom names to CUSTOM, and denied personalization to LDU", () => {
    expect(redditEventType("SignUp")).toEqual({ tracking_type: "SIGN_UP" });
    expect(redditEventType("AddToCart")).toEqual({ tracking_type: "ADD_TO_CART" });
    expect(redditEventType("PAGE_VISIT")).toEqual({ tracking_type: "PAGE_VISIT" });
    expect(redditEventType("Newsletter Signup")).toEqual({ tracking_type: "CUSTOM", custom_event_name: "Newsletter Signup" });
    const ev = (
      buildRedditRequest(event({ consent: { ad_user_data: "granted", ad_personalization: "denied" } }), creds.reddit, false).body as {
        data: { events: Record<string, any>[] };
      }
    ).data.events[0]!;
    expect(ev.user.data_processing_options).toEqual({ modes: ["LDU"], country: "US", region: "CA" });
  });
  it("error bodies become a readable error", async () => {
    const r = await reddit.send(
      event(),
      creds.reddit,
      ctx(() =>
        json(400, {
          error: { code: 400, message: "There were 1 invalid conversion events.", fields: [{ field: "type", message: "required" }] },
        }),
      ),
    );
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect(r.error).toMatch(/invalid conversion events.*type: required/);
  });
});

describe("Snap Conversions API v3", () => {
  it("builds the documented request, token only in the (redacted) query string", async () => {
    const r = buildSnapRequest(
      event({ user: { em, ph, fn, ln, ct: "new york", st: "ny", zp: "10001", country: "us", external_id: "cust-42" } }),
      creds.snap,
      false,
    );
    expect(r.url).toBe(`https://tr.snapchat.com/v3/1ec32188-754e-4be2-8e55-c949a984a39f/events?access_token=${creds.snap.access_token}`);
    expect(r.method).toBe("POST");
    const d = (r.body as { data: Record<string, any>[] }).data[0]!;
    expect(d).toMatchObject({
      event_name: "PURCHASE",
      event_time: TS,
      event_id: "evt.abc123",
      action_source: "WEB",
      event_source_url: "https://example.com/thank-you",
    });
    expect(d.user_data).toEqual({
      em: [em],
      ph: [ph],
      fn: [fn],
      ln: [ln],
      ct: [sha256HexSync("newyork")],
      st: [sha256HexSync("ny")],
      zp: [sha256HexSync("10001")],
      country: [US],
      external_id: sha256HexSync("cust-42"),
      client_ip_address: "203.0.113.7",
      client_user_agent: "Mozilla/5.0 Chrome/130",
      sc_click_id: "7b3a7917-a82a-47e8-9728-e1b3b045abb2",
      sc_cookie1: "scid-cookie-value",
    });
    expect(d.custom_data).toEqual({
      currency: "USD",
      value: 49.5,
      order_id: "T-1001",
      content_ids: ["sku1"],
      contents: [{ id: "sku1", quantity: 2, item_price: 24.75 }],
      num_items: "2",
    });
    const seen: Seen[] = [];
    const sent = await snap.send(event(), creds.snap, ctx(SUCCESS.snap!, seen));
    expect(seen[0]!.url).toContain(`access_token=${creds.snap.access_token}`);
    expect(sent.request!.url).toBe("https://tr.snapchat.com/v3/1ec32188-754e-4be2-8e55-c949a984a39f/events?access_token=REDACTED");
  });
  it("test mode uses /events/validate", async () => {
    expect(buildSnapRequest(event(), creds.snap, true).url).toMatch(
      /\/v3\/1ec32188-754e-4be2-8e55-c949a984a39f\/events\/validate\?access_token=/,
    );
    const seen: Seen[] = [];
    const r = await snap.send(
      event({ test: true }),
      creds.snap,
      ctx(() => json(200, { status: "VALID", test_event: true }), seen),
    );
    expect(seen[0]!.url).toContain("/events/validate?");
    expect(r.ok).toBe(true);
    expect(r.request!.url).toContain("access_token=REDACTED");
  });
  it("names, offline events and answers that say INVALID", async () => {
    expect(snapEventName("purchase")).toBe("PURCHASE");
    expect(snapEventName("sign up")).toBe("SIGN_UP");
    expect(snapEventName("MyThing")).toBe("MyThing");
    const off = (buildSnapRequest(event({ page_url: undefined }), creds.snap, false).body as { data: Record<string, unknown>[] }).data[0]!;
    expect(off.action_source).toBe("OFFLINE");
    const invalid = {
      status: "INVALID",
      reason: "At least one of the events is invalid.",
      event_logs: [{ errors: { error_msgs: ["Insufficient PII"] } }],
    };
    const r200 = await snap.send(
      event(),
      creds.snap,
      ctx(() => json(200, invalid)),
    );
    expect(r200).toMatchObject({ ok: false, retryable: false });
    expect(r200.error).toMatch(/INVALID.*Insufficient PII/);
    const r400 = await snap.send(
      event(),
      creds.snap,
      ctx(() => json(400, invalid)),
    );
    expect(r400).toMatchObject({ ok: false, retryable: false });
    expect(r400.error).toMatch(/400: At least one of the events is invalid. Insufficient PII/);
  });
});

describe("X Ads Conversion API", () => {
  it("builds the documented body", () => {
    const r = buildXRequest(event(), creds.x);
    expect(r.url).toBe("https://ads-api.x.com/12/measurement/conversions/o1abc");
    expect(r.method).toBe("POST");
    expect(r.body).toEqual({
      conversions: [
        {
          conversion_time: "2026-11-03T12:30:45.123Z",
          event_id: "tw-o1abc-ol288",
          identifiers: [
            { twclid: "23opevjt88psuo13lu8d020qkn" },
            { hashed_email: em },
            { hashed_phone_number: ph164 },
            { ip_address: "203.0.113.7", user_agent: "Mozilla/5.0 Chrome/130" },
          ],
          conversion_id: "evt.abc123",
          event_source_url: "https://example.com/thank-you",
          value: 49.5,
          price_currency: "USD",
          number_items: 2,
          contents: [{ content_id: "sku1", content_name: "Shirt", content_price: 24.75, num_items: 2 }],
        },
      ],
    });
    expect((buildXBody(event({ items: [] })).conversions[0] as Record<string, unknown>).contents).toBeUndefined();
  });
  it("signs each request with OAuth 1.0a (a verifiable HMAC-SHA1 signature, fresh nonce)", async () => {
    const seen: Seen[] = [];
    const r = await x.send(event(), creds.x, ctx(SUCCESS.x!, seen));
    await x.send(event(), creds.x, ctx(SUCCESS.x!, seen));
    expect(r.ok).toBe(true);
    const parse = (h: string) =>
      Object.fromEntries([...h.replace(/^OAuth /, "").matchAll(/([a-z_]+)="([^"]*)"/g)].map((m) => [m[1]!, decodeURIComponent(m[2]!)]));
    const a = parse(headersOf(seen[0]!).authorization!);
    const b = parse(headersOf(seen[1]!).authorization!);
    expect(headersOf(seen[0]!).authorization).toMatch(/^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="/);
    expect(a).toMatchObject({
      oauth_consumer_key: creds.x.consumer_key,
      oauth_token: creds.x.access_token,
      oauth_signature_method: "HMAC-SHA1",
      oauth_version: "1.0",
    });
    expect(Math.abs(Number(a.oauth_timestamp) - Date.now() / 1000)).toBeLessThan(60);
    expect(a.oauth_nonce).not.toBe(b.oauth_nonce);
    const { oauth_signature, ...signed } = a;
    const keys = {
      consumerKey: creds.x.consumer_key,
      consumerSecret: creds.x.consumer_secret,
      token: creds.x.access_token,
      tokenSecret: creds.x.access_token_secret,
    };
    expect(await oauth1Signature("POST", seen[0]!.url, signed as Record<string, string>, keys)).toBe(oauth_signature);
    expect(bodyOf(seen[0]!).conversions[0].conversion_id).toBe("evt.abc123");
    for (const s of [creds.x.consumer_secret, creds.x.access_token_secret]) expect(JSON.stringify(r)).not.toContain(s);
  });
  it("refuses an event id from another pixel and treats 0 processed as a failure", async () => {
    let called = 0;
    const wrong = await x.send(
      event({ send_to: { x: { event_id: "tw-zz999-ol288" } } }),
      creds.x,
      ctx(() => (called++, SUCCESS.x!())),
    );
    expect(wrong).toMatchObject({ ok: false, retryable: false });
    expect(wrong.error).toMatch(/belongs to pixel zz999/);
    expect(called).toBe(0);
    const zero = await x.send(
      event(),
      creds.x,
      ctx(() => json(200, { data: { conversions_processed: 0 } })),
    );
    expect(zero).toMatchObject({ ok: false, retryable: false });
    const err = await x.send(
      event(),
      creds.x,
      ctx(() => json(400, { errors: [{ code: "INVALID_PARAMETER", message: "event_id is invalid" }] })),
    );
    expect(err.error).toMatch(/INVALID_PARAMETER: event_id is invalid/);
  });
  it("needs twclid, email or phone: IP and user agent alone are skipped", () => {
    expect(x.skipReason!(event({ user: {}, click_ids: {} }))).toMatch(/no identifier/);
    expect(x.skipReason!(event({ user: { ph_e164: ph164 }, click_ids: {} }))).toBeNull();
  });
});

describe("OAuth 1.0a signing (X's published 'Creating a signature' vector)", () => {
  // https://docs.x.com/fundamentals/authentication/oauth-1-0a/creating-a-signature
  const keys = {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  };
  const oauth = {
    oauth_consumer_key: keys.consumerKey,
    oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: "1318622958",
    oauth_token: keys.token,
    oauth_version: "1.0",
  };
  const status = { status: "Hello Ladies + Gentlemen, a signed OAuth request!" };
  const url = "https://api.x.com/1.1/statuses/update.json?include_entities=true";
  it("percent-encodes per RFC 3986", () => {
    expect(percentEncode("Hello Ladies + Gentlemen, a signed OAuth request!")).toBe(
      "Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21",
    );
    expect(percentEncode("Dogs, Cats & Mice")).toBe("Dogs%2C%20Cats%20%26%20Mice");
    expect(percentEncode("☃")).toBe("%E2%98%83");
    expect(percentEncode("-._~*'()")).toBe("-._~%2A%27%28%29");
  });
  it("builds the published signature base string", () => {
    expect(signatureBaseString("post", url, { ...status, ...oauth })).toBe(
      "POST&https%3A%2F%2Fapi.x.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
  });
  it("produces the published signatures (api.x.com, and the original api.twitter.com example)", async () => {
    expect(await oauth1Signature("POST", url, { ...status, ...oauth }, keys)).toBe("Ls93hJiZbQ3akF3HF3x1Bz8/zU4=");
    expect(
      await oauth1Signature(
        "POST",
        "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
        { ...status, ...oauth },
        keys,
      ),
    ).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });
  it("builds the Authorization header in the documented format", async () => {
    const header = await oauth1Header({
      method: "POST",
      url,
      credentials: keys,
      params: status,
      nonce: oauth.oauth_nonce,
      timestamp: 1318622958,
    });
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="Ls93hJiZbQ3akF3HF3x1Bz8%2FzU4%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"',
    );
  });
});
