import { describe, expect, it } from "vitest";
import type { ContainerConfig } from "../src/config/schema";
import { validateConfig } from "../src/config/validate";
import { analytics, analyticsBaseUrlProblem } from "../src/destinations/analytics";
import type { DispatchEvent } from "../src/destinations/types";
import { webhook } from "../src/destinations/webhook";
import { fetchableHost, isIpLiteral, isPublicSuffix } from "../src/lib/domain";
import { collectRateLimited, identityCookies } from "../src/service/collect";
import { normalizeDomain, normalizeHostnames } from "../src/service/containers";
import { planDispatch } from "../src/service/dispatch-plan";
import { mergeVisitor } from "../src/service/identity";
import { cleanCollectPayload, cleanServerEvent, serverDispatchEvent } from "../src/service/ingest";
import { collectSchema, serverEventSchema } from "../src/service/ingest-schema";
import { hostAllowed } from "../src/service/origin";
import { MAX_BROWSER_PARAMS, sanitizeText, summarizeResponse } from "../src/service/sanitize";
import { fetchPage, hasSnippet, isHomepage, MAX_SCAN_PAGES, scanSite, scanTarget, scriptSrcs } from "../src/service/scan";
import { checkDomain, customCodeIn, customCodeProblem, stripCustomCode, verifyToken } from "../src/service/verify";

const C = "ctr_abcdefgh12345678";
const granted = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" };

function event(over: Partial<DispatchEvent> = {}): DispatchEvent {
  return { event_id: "evt.abc123", name: "lead", ts: 1, source: "server", click_ids: {}, user: {}, consent: {}, send_to: {}, ...over };
}

describe("finding 7: hosts this service fetches or accepts", () => {
  it("public suffixes, IP literals and local names", () => {
    for (const h of ["com", "co.uk", "com.au", "github.io", "vercel.app", "pages.dev", "workers.dev"]) expect(isPublicSuffix(h)).toBe(true);
    for (const h of ["example.com", "bbc.co.uk", "myapp.github.io", "shop.example.net"]) expect(isPublicSuffix(h)).toBe(false);
    expect(isIpLiteral("203.0.113.9")).toBe(true);
    expect(isIpLiteral("[::1]")).toBe(true);
    expect(isIpLiteral(new URL("https://0x7f.1/").hostname)).toBe(true); // the URL parser normalises these
    for (const h of ["localhost", "203.0.113.9", "printer.local", "db.internal", "github.io", "intranet"])
      expect(fetchableHost(h)).toBe(false);
    expect(fetchableHost("shop.example.com")).toBe(true);
  });
  it("container domains can't be IP addresses or public suffixes; wildcards can't cover a public suffix", () => {
    expect(() => normalizeDomain("203.0.113.9")).toThrow(/IP address/);
    expect(() => normalizeDomain("0x7f.0.0.1")).toThrow(/IP address/);
    expect(() => normalizeDomain("https://github.io/")).toThrow(/public suffix/);
    expect(() => normalizeDomain("co.uk")).toThrow(/public suffix/);
    expect(normalizeDomain("myapp.github.io")).toBe("myapp.github.io");
    expect(normalizeDomain("localhost")).toBe("localhost");
    for (const w of ["*.com", "*.co.uk", "*.github.io", "*.vercel.app"]) expect(() => normalizeHostnames([w])).toThrow(/every site/);
    expect(normalizeHostnames(["*.staging.example.net", "localhost"])).toEqual(["*.staging.example.net", "localhost"]);
  });
  it("a public-suffix wildcard saved by older code matches nothing", () => {
    const s = { domain: "shop.test", allowed_hostnames: ["*.com", "*.example.net"] };
    expect(hostAllowed("evil.com", s)).toBe(false);
    expect(hostAllowed("a.example.net", s)).toBe(true);
    expect(hostAllowed("anyone.github.io", { domain: "github.io", allowed_hostnames: [] })).toBe(false);
  });
  it("scan targets: https on the default port, never an IP literal", () => {
    expect(() => scanTarget("acme.example", "http://acme.example/")).toThrow(/https/);
    expect(() => scanTarget("acme.example", "https://acme.example:8443/")).toThrow(/default https port/);
    expect(() => scanTarget("acme.example", "https://user:pw@acme.example/")).toThrow();
    expect(() => scanTarget("203.0.113.9")).toThrow(/can't be scanned/);
    expect(() => scanTarget("github.io")).toThrow(/can't be scanned/);
  });
  it("redirects to http (or another port) aren't followed", async () => {
    const calls: string[] = [];
    const f = (async (u: RequestInfo | URL) => {
      calls.push(String(u));
      return new Response(null, { status: 302, headers: { location: "http://acme.example/plain" } });
    }) as typeof fetch;
    const r = await fetchPage("https://acme.example/", "acme.example", f);
    expect(r.error).toMatch(/isn't https on acme.example/);
    expect(calls).toHaveLength(1);
    expect((await fetchPage("http://acme.example/", "acme.example", f)).error).toMatch(/Only https/);
    expect(calls).toHaveLength(1);
  });
  it(`a scan fetches at most ${MAX_SCAN_PAGES} pages, two at a time`, async () => {
    let inFlight = 0;
    let peak = 0;
    const calls: string[] = [];
    const links = Array.from({ length: 10 }, (_, i) => `<a href="/contact-${i}">Contact us</a>`).join("");
    const f = (async (u: RequestInfo | URL) => {
      calls.push(String(u));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(`<html><body>${links}</body></html>`, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    await scanSite("acme.example", C, { paths: ["/a", "/b", "/c", "/d", "/e"] }, f);
    expect(calls.length).toBeLessThanOrEqual(MAX_SCAN_PAGES);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("finding 4: what public ingest may store", () => {
  it("cleans keys and lengths in params, first_touch, utm, click_ids, consent and ids", () => {
    const firstTouch = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, "x".repeat(2000)]));
    const params = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, i % 2 ? "y".repeat(5000) : { nested: true }]));
    const p = cleanCollectPayload(
      collectSchema.parse({
        container_id: C,
        type: "conversion",
        name: "purchase",
        first_touch: { ...firstTouch, utm_source: "google", landing_page: "https://shop.test/", ts: 5 },
        utm: { utm_source: "google", junk_key: "x" },
        click_ids: { gclid: "Cj0KCQ-ok", "x=1; Domain=evil": "abcdef", made_up: "abcdef" },
        consent: { ad_storage: "granted", not_a_type: "granted" },
        params,
        fbp: "fb.1.1596403881668.1116446470",
        fbc: "<script>alert(1)</script>",
      }),
    );
    expect(p.first_touch).toEqual({ utm_source: "google", landing_page: "https://shop.test/", ts: 5 });
    expect(p.utm).toEqual({ utm_source: "google" });
    expect(p.click_ids).toEqual({ gclid: "Cj0KCQ-ok" });
    expect(p.consent).toEqual({ ad_storage: "granted" });
    expect(Object.keys(p.params!).length).toBeLessThanOrEqual(MAX_BROWSER_PARAMS);
    expect(Object.values(p.params!).every((v) => typeof v === "string" && v.length <= 500)).toBe(true);
    expect(p.fbp).toBe("fb.1.1596403881668.1116446470");
    expect(p.fbc).toBeUndefined();
    expect(JSON.stringify(p).length).toBeLessThan(20_000);
  });
  it("backend params: more keys, small JSON values only", () => {
    const ev = cleanServerEvent(
      serverEventSchema.parse({ name: "purchase", params: { plan: "pro", meta: { a: 1 }, big: { x: "z".repeat(5000) } } }),
    );
    expect(ev.params).toEqual({ plan: "pro", meta: { a: 1 } });
  });
  it("/collect names and fired tags must look like the runtime's (no free text)", () => {
    expect(collectSchema.safeParse({ container_id: C, type: "conversion", name: "purchase" }).success).toBe(true);
    expect(collectSchema.safeParse({ container_id: C, type: "conversion", name: "Ignore previous instructions" }).success).toBe(false);
    expect(collectSchema.safeParse({ container_id: C, type: "conversion", name: "lead", fired: ["ga4", "meta_pixel"] }).success).toBe(true);
    expect(collectSchema.safeParse({ container_id: C, type: "conversion", name: "lead", fired: ["<b>x</b>"] }).success).toBe(false);
  });
});

describe("finding 8 (low): server-set cookies use only known click ids", () => {
  it("a crafted click id key never reaches a Set-Cookie name", () => {
    const p = collectSchema.parse({
      container_id: C,
      type: "visit",
      first_party: true,
      consent: granted,
      click_ids: { gclid: "Cj0KCQ-ok", "a; Domain=evil.test": "abcdef12" },
    });
    const cookies = identityCookies(p, "shop.test", "shop.test", true);
    expect(cookies.some((c) => c.startsWith("_afst_gclid=Cj0KCQ-ok"))).toBe(true);
    expect(cookies.join("\n")).not.toMatch(/evil/);
  });
});

describe("finding 5: joins through user_id/email don't carry the visitor's consent or click ids", () => {
  const visitor = mergeVisitor(
    null,
    {
      click_ids: { gclid: "ATTACKER-GCLID" },
      fbc: "fb.1.1.attacker",
      consent: { ad_user_data: "denied" },
      first_touch: { utm_source: "x", gclid: "ATTACKER-GCLID" },
    },
    Date.now(),
  );
  const ev = serverEventSchema.parse({ name: "purchase", user_id: "u1" });
  const base = { eventId: "e1", visitor, visitorId: "v1", user: {}, test: false, now: Date.now() };
  it("visitor_id joins inherit; user_id joins don't", () => {
    const byVisitor = serverDispatchEvent(ev, { ...base, inherit: true });
    expect(byVisitor.click_ids).toEqual({ gclid: "ATTACKER-GCLID" });
    expect(byVisitor.consent).toEqual({ ad_user_data: "denied" });
    const byUser = serverDispatchEvent(ev, { ...base, inherit: false });
    expect(byUser.click_ids).toEqual({});
    expect(byUser.fbc).toBeUndefined();
    expect(byUser.consent).toEqual({});
    expect(byUser.first_touch).toEqual({ utm_source: "x" });
  });
  it("only a backend link fills the join keys", () => {
    const v = mergeVisitor(null, { user_id: "from-browser", user: { em: "a".repeat(64) } });
    expect(v.linked).toBeUndefined();
    const linked = mergeVisitor(v, { link: { user_id: "u1", em: "b".repeat(64) } });
    expect(linked.linked).toEqual({ user_id: "u1", em: "b".repeat(64) });
  });
});

describe("finding 1: fan-out", () => {
  const dests = [
    { id: "wh", type: "webhook", enabled: true, settings: {} },
    { id: "wh_all", type: "webhook", enabled: true, settings: { all_events: true } },
    { id: "an", type: "analytics", enabled: true, settings: {} },
  ];
  it("webhooks get only matched conversions unless they opt into all events", () => {
    expect(planDispatch(event(), dests, { matched: false }).map((t) => t.destination_id)).toEqual(["wh_all", "an"]);
    expect(planDispatch(event(), dests, { matched: true }).map((t) => t.destination_id)).toEqual(["wh", "wh_all", "an"]);
  });
  it("an open circuit skips the destination with the reason; an expired one is tried again", () => {
    const now = Date.now();
    const plan = planDispatch(event(), [{ ...dests[0]!, circuit_open_until: now + 60_000, consecutive_failures: 20 }], { now });
    expect(plan).toEqual([
      { destination_id: "wh", type: "webhook", status: "skipped", reason: expect.stringMatching(/circuit open .* 20 consecutive/) },
    ]);
    const later = planDispatch(event(), [{ ...dests[0]!, circuit_open_until: now - 1, consecutive_failures: 20 }], { now });
    expect(later[0]!.status).toBe("queued");
  });
  it("webhooks retry less than platform connectors", () => {
    expect(webhook.maxAttempts).toBe(3);
    expect(analytics.maxAttempts).toBeUndefined();
  });
  it("edge rate limits: per network and per container, conversions tighter", async () => {
    const seen: string[] = [];
    const limiter = (name: string, ok: boolean) => ({
      async limit({ key }: { key: string }) {
        seen.push(`${name}:${key}`);
        return { success: ok };
      },
    });
    const env = {
      COLLECT_IP_LIMITER: limiter("ip", true),
      COLLECT_CONTAINER_LIMITER: limiter("ctr", true),
      CONVERSION_IP_LIMITER: limiter("cip", false),
      CONVERSION_CONTAINER_LIMITER: limiter("cctr", true),
    } as never;
    expect(await collectRateLimited(env, "203.0.113.5", C, false)).toBeNull();
    expect(await collectRateLimited(env, "203.0.113.5", C, true)).toBe("conversions from this network");
    expect(seen).toEqual(["ip:203.0.113.5", `ctr:${C}`, "ip:203.0.113.5", `ctr:${C}`, "cip:203.0.113.5"]);
    expect(await collectRateLimited({} as never, "x", C, true)).toBeNull(); // unbound limiters never limit
  });
});

describe("finding 2: the analytics destination is not a proxy", () => {
  const env = { ANALYTICS_BASE_URL: "https://analytics.example.com", PUBLIC_BASE_URL: "https://tags.example.com", DEV_MODE: "false" };
  it("base_url: https, the analytics app's host, no query, no IP, not this deployment", () => {
    expect(analyticsBaseUrlProblem(undefined, env)).toBeNull();
    expect(analyticsBaseUrlProblem("https://analytics.example.com", env)).toBeNull();
    expect(analyticsBaseUrlProblem("http://203.0.113.9:8080/anything?x=", env)).toMatch(/https/);
    expect(analyticsBaseUrlProblem("https://203.0.113.9/", { ...env, ANALYTICS_BASE_URL: "" })).toMatch(/IP address/);
    expect(analyticsBaseUrlProblem("ftp://analytics.example.com/", env)).toMatch(/https/);
    expect(analyticsBaseUrlProblem("https://analytics.example.com/?x=", env)).toMatch(/query/);
    expect(analyticsBaseUrlProblem("https://analytics.example.com/?", env)).toMatch(/query/);
    expect(analyticsBaseUrlProblem("https://tags.example.com/collect", { ...env, ANALYTICS_BASE_URL: "" })).toMatch(/this tags deployment/);
    expect(analyticsBaseUrlProblem("https://evil.test/", env)).toMatch(/must be on analytics\.example\.com/);
    expect(() => analytics.check!({ site_id: "site_abc", api_key: "ana_xxxxxxxx", base_url: "https://evil.test" }, env)).toThrow();
  });
  it("is re-checked at send time (destinations saved by older code)", async () => {
    let fetched = false;
    const r = await analytics.send(
      event({ name: "purchase" }),
      { site_id: "site_abc", api_key: "ana_xxxxxxxx", base_url: "https://evil.test" },
      {
        test: false,
        env,
        destinationId: "d",
        containerId: C,
        fetch: (async () => {
          fetched = true;
          return new Response("{}");
        }) as typeof fetch,
      },
    );
    expect(r).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/must be on/) });
    expect(fetched).toBe(false);
  });
  it("webhook answers come back as a short sanitized summary, never the body", async () => {
    const page = `<html><head><title>Admin</title></head><body>${"secret ".repeat(5000)}<script>steal()</script></body></html>`;
    const r = await webhook.send(
      event({ name: "purchase" }),
      { url: "https://hooks.example.org/x", secret: "s".repeat(32) },
      { test: true, env, destinationId: "d", containerId: C, fetch: (async () => new Response(page, { status: 200 })) as typeof fetch },
    );
    expect(r.http_status).toBe(200);
    expect(typeof r.response).toBe("string");
    expect((r.response as string).length).toBeLessThanOrEqual(203);
    expect(r.response as string).not.toMatch(/[<>]/);
    expect(summarizeResponse({ received: true, signature_valid: true, html: "<b>x</b>", nested: { a: 1 } })).toEqual({
      received: true,
      signature_valid: true,
      html: "x",
      _omitted_fields: 1,
    });
    expect(sanitizeText(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0)}c`)).toBe("a b c");
  });
});

describe("finding 6: custom code needs a verified domain and a claimed account", () => {
  const cfg = {
    tags: [
      { id: "ga", type: "ga4", params: { measurement_id: "G-ABCDEF1234" }, triggers: ["all"] },
      { id: "h", type: "custom_html", params: { html: "<script>1</script>" }, triggers: ["all"] },
      { id: "j", type: "custom_js", params: { code: "console.log(1)" }, triggers: ["all"] },
      { id: "a", type: "analytics", params: { site_id: "site_abc", base_url: "https://evil.test" }, triggers: ["all"] },
      { id: "a2", type: "analytics", params: { site_id: "site_abc", base_url: "https://analytics.example.com" }, triggers: ["all"] },
    ],
    triggers: [{ id: "all", type: "page_view" }],
  } as unknown as ContainerConfig;
  const env = { ANALYTICS_BASE_URL: "https://analytics.example.com" };
  const row = { id: C, domain: "shop.example.com", verified_at: null };
  const claimed = { suspended: false, claimed: true };
  it("detects custom_html, custom_js and analytics scripts from another host", () => {
    expect(customCodeIn(cfg, env)).toEqual({ paths: ["tags.1", "tags.2", "tags.3.params.base_url"], bytes: 18 + 14 });
    expect(stripCustomCode(cfg, env).tags!.map((t) => t.id)).toEqual(["ga", "a2"]);
  });
  it("unclaimed: refused; claimed but unverified: refused; verified: within MAX_CUSTOM_CODE_BYTES", () => {
    expect(customCodeProblem(env, row, cfg, { suspended: false, claimed: false })).toMatchObject({ code: "custom_code_not_allowed" });
    expect(customCodeProblem(env, row, cfg, claimed)).toMatchObject({ code: "domain_not_verified" });
    expect(customCodeProblem(env, { ...row, verified_at: 1 }, cfg, claimed)).toBeNull();
    const capped: Record<string, string> = { ...env, MAX_CUSTOM_CODE_BYTES: "10" };
    expect(customCodeProblem(capped, { ...row, verified_at: 1 }, cfg, claimed)).toMatchObject({
      code: "custom_code_too_large",
    });
    expect(customCodeProblem(env, row, { tags: [cfg.tags![0]!], triggers: cfg.triggers } as ContainerConfig, claimed)).toBeNull();
    const v = validateConfig(cfg, { customCode: (c) => customCodeProblem(env, row, c, claimed) });
    expect(v.valid).toBe(false);
    expect(v.errors.map((e) => e.code)).toContain("domain_not_verified");
  });
  it("verification: the TXT record over DoH, else the snippet in a <script src> on https://<domain>/", async () => {
    const keyEnv = { ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" };
    const token = (await verifyToken(keyEnv, C))!;
    expect(token).toMatch(/^afs-verify=[a-f0-9]{32}$/);
    const doh = (answer: string[]) =>
      (async (u: RequestInfo | URL) => {
        const url = String(u);
        if (url.startsWith("https://cloudflare-dns.com/dns-query?name=_afs-verify.shop.example.com&type=TXT"))
          return Response.json({ Status: 0, Answer: answer.map((data) => ({ type: 16, data: `"${data}"` })) });
        return new Response(`<html><head><script async src="https://tags.example.com/c/${C}.js"></script></head></html>`);
      }) as typeof fetch;
    expect((await checkDomain(keyEnv, row, "dns", doh([token]))).verified).toBe("dns");
    expect((await checkDomain(keyEnv, row, "dns", doh(["afs-verify=wrong"]))).verified).toBeNull();
    expect((await checkDomain(keyEnv, row, "auto", doh([]))).verified).toBe("snippet");
    expect(hasSnippet(`<p>see /c/${C}.js</p>`, C)).toBe(false); // text mentioning it isn't the snippet
    expect(hasSnippet(`<script src="/_t/c/${C}.js"></script>`, C)).toBe(true);
  });
  it("domain proof: only a real <script src> tag, never text a page echoes", () => {
    const tag = `<script src="https://tags.example.com/c/${C}.js"></script>`;
    for (const echoed of [
      `<!-- ${tag} -->`,
      `<input name="q" value='${tag}'>`,
      `<meta content="${tag}">`,
      `<script>window.__STATE__ = {"comment": "${tag.replace(/"/g, "'")}"}</script>`,
      `<script type="application/json">{"html": "<script src='/c/${C}.js'>"}</script>`,
      `<textarea>${tag}</textarea>`,
      `<title>${tag}</title>`,
      `<noscript>${tag}</noscript>`,
      `<template>${tag}</template>`,
      `<style>/* ${tag} */</style>`,
      `&lt;script src="/c/${C}.js"&gt;`,
      `<script src="/c/${C}.json"></script><script src="/c/${C}.js.map"></script>`,
    ])
      expect(hasSnippet(`<html><body>${echoed}</body></html>`, C), echoed).toBe(false);
    for (const real of [
      tag,
      `<script async data-x=">" src='/_proxy/c/${C}.js?v=2'></script>`,
      `<SCRIPT defer src=/c/${C}.js></SCRIPT>`,
      `<!-- note --><script>var a = "</div>";</script><script src="/c/${C}.js"></script>`,
    ])
      expect(hasSnippet(`<html><head>${real}</head></html>`, C), real).toBe(true);
    expect(
      scriptSrcs(`<script src="a.js"></script><p src="b.js"></p><script>x("<script src=c.js>")</script><script src = "d.js">`),
    ).toEqual(["a.js", "d.js"]);
  });
  it("domain proof: only from https://<domain>/ (or www.) itself, answered 2xx; queries and other pages never count", async () => {
    const keyEnv = { ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" };
    const snippet = `<script src="https://tags.example.com/c/${C}.js"></script>`;
    const site = (pages: Record<string, { status?: number; body?: string; location?: string }>) =>
      (async (u: RequestInfo | URL) => {
        const p = pages[String(u)];
        if (!p) return new Response("not found", { status: 404 });
        return new Response(p.body ?? "", { status: p.status ?? 200, headers: p.location ? { location: p.location } : {} });
      }) as typeof fetch;
    const verify = (pages: Parameters<typeof site>[0]) => checkDomain(keyEnv, row, "snippet", site(pages));
    const home = "https://shop.example.com/";
    expect((await verify({ [home]: { body: snippet } })).verified).toBe("snippet");
    expect(
      (
        await verify({
          [home]: { status: 301, location: "https://www.shop.example.com/" },
          "https://www.shop.example.com/": { body: snippet },
        })
      ).verified,
    ).toBe("snippet");
    // The homepage sends the fetch somewhere that echoes a query (or to another page): not proof.
    const echo = `https://shop.example.com/?s=${encodeURIComponent(snippet)}`;
    const viaQuery = await verify({ [home]: { status: 302, location: echo }, [echo]: { body: `Results for ${snippet}` } });
    expect(viaQuery.verified).toBeNull();
    expect(viaQuery.checks[0]!.detail).toMatch(/only https:\/\/shop\.example\.com\/ or https:\/\/www\.shop\.example\.com\/ itself counts/);
    expect(
      (await verify({ [home]: { status: 302, location: "/landing" }, "https://shop.example.com/landing": { body: snippet } })).verified,
    ).toBeNull();
    expect((await verify({ [home]: { status: 404, body: snippet } })).verified).toBeNull();
    expect((await verify({ [home]: { body: `<!-- ${snippet} -->` } })).verified).toBeNull();
    // scan: a url with a query string never sets snippet_on_homepage.
    const scanned = await scanSite("shop.example.com", C, { url: echo, follow_links: false }, site({ [echo]: { body: snippet } }));
    expect(scanned.snippet_on_homepage).toBe(false);
    expect(isHomepage("https://shop.example.com/", "shop.example.com")).toBe(true);
    for (const u of [
      "https://shop.example.com/?",
      "https://shop.example.com/#x",
      "https://shop.example.com/index.html",
      "https://evil.shop.example.com/",
      "http://shop.example.com/",
    ])
      expect(isHomepage(u, "shop.example.com"), u).toBe(false);
  });
});
