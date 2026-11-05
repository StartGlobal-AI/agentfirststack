import { describe, expect, it } from "vitest";
import { automatedBrowser, clientIpFrom, deviceFrom, identityCookies, isTestHit } from "../src/service/collect";
import { installInstructions } from "../src/service/containers";
import { fromTrustedProxy, PROXY_KEY_HEADER, proxyKey } from "../src/service/proxy";
import { collectSchema } from "../src/service/ingest-schema";
import { compileScript } from "../src/service/script";

const granted = { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" } as const;

describe("/collect helpers", () => {
  it("re-sets identity cookies server-side only for first-party hits with consent", () => {
    const p = collectSchema.parse({
      container_id: "ctr_abcdefgh12345678",
      type: "visit",
      visitor_id: "vis12345.1700000000",
      click_ids: { gclid: "G-abc_123" },
      fbc: "fb.1.1700000000000.abc",
      consent: granted,
      first_party: true,
    });
    const c = identityCookies(p, "www.shop.test", "shop.test", true);
    expect(c).toEqual([
      "_afst_vid=vis12345.1700000000; Path=/; Max-Age=34128000; SameSite=Lax; Domain=shop.test; Secure",
      "_afst_gclid=G-abc_123; Path=/; Max-Age=7776000; SameSite=Lax; Domain=shop.test; Secure",
      "_fbc=fb.1.1700000000000.abc; Path=/; Max-Age=7776000; SameSite=Lax; Domain=shop.test; Secure",
    ]);
    expect(identityCookies({ ...p, first_party: false }, "www.shop.test", "shop.test", true)).toEqual([]);
    const denied = identityCookies({ ...p, consent: { ...granted, ad_storage: "denied" } }, "shop.test", "shop.test", false);
    expect(denied).toEqual(["_afst_vid=vis12345.1700000000; Path=/; Max-Age=34128000; SameSite=Lax; Domain=shop.test"]);
  });
  it("visitor IP: first X-Forwarded-For hop only from a trusted proxy, else cf-connecting-ip", () => {
    const r = new Request("https://t.test/collect", {
      headers: { "x-forwarded-for": "198.51.100.9, 104.16.0.1", "cf-connecting-ip": "104.16.0.1", "x-real-ip": "203.0.113.66" },
    });
    expect(clientIpFrom(r, true)).toBe("198.51.100.9");
    expect(clientIpFrom(r, false)).toBe("104.16.0.1");
    // x-real-ip is client-settable too: never used.
    expect(clientIpFrom(new Request("https://t.test/collect", { headers: { "x-real-ip": "203.0.113.66" } }), false)).toBeUndefined();
  });
  it("the proxy key is a per-container HMAC; a client-set first_party flag or a wrong key isn't trusted", async () => {
    const env = { ENCRYPTION_KEY: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=" };
    const a = await proxyKey(env, "ctr_abcdefgh12345678");
    const b = await proxyKey(env, "ctr_zzzzzzzz12345678");
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
    expect(await proxyKey({}, "ctr_abcdefgh12345678")).toBeNull();
    const req = (h: Record<string, string>) => new Request("https://t.test/collect", { method: "POST", headers: h });
    expect(await fromTrustedProxy(env, req({ [PROXY_KEY_HEADER]: a! }), "ctr_abcdefgh12345678")).toBe(true);
    expect(await fromTrustedProxy(env, req({ [PROXY_KEY_HEADER]: b! }), "ctr_abcdefgh12345678")).toBe(false); // another container's key
    expect(await fromTrustedProxy(env, req({ [PROXY_KEY_HEADER]: "x" }), "ctr_abcdefgh12345678")).toBe(false);
    expect(await fromTrustedProxy(env, req({}), "ctr_abcdefgh12345678")).toBe(false);
    expect(await fromTrustedProxy({}, req({ [PROXY_KEY_HEADER]: a! }), "ctr_abcdefgh12345678")).toBe(false);
  });
  it("install snippets carry the proxy key server-side, never in the page snippet", () => {
    const i = installInstructions("https://tags.example.net", { id: "ctr_abcdefgh12345678", domain: "shop.test" }, { key: "k".repeat(64) });
    const p = i.first_party_proxy as Record<string, string>;
    for (const k of ["cloudflare_worker", "nextjs", "netlify", "nginx"] as const)
      expect(p[k]).toContain(`x-afs-proxy-key`), expect(p[k]).toContain("k".repeat(64));
    expect(i.snippet).not.toContain("k".repeat(10));
    expect(p.snippet).not.toContain("k".repeat(10));
    expect(p.vercel).toMatch(/can't add request headers/);
  });
  it("install instructions leave the proxy key and configs out unless asked for", () => {
    const i = installInstructions("https://tags.example.net", { id: "ctr_abcdefgh12345678", domain: "shop.test" });
    const p = i.first_party_proxy as Record<string, string>;
    expect(JSON.stringify(i)).not.toMatch(/[a-f0-9]{64}/);
    expect(p.proxy_key).toBeUndefined();
    expect(p.cloudflare_worker).toBeUndefined();
    expect(p.how_to_get).toContain("/v1/containers/ctr_abcdefgh12345678/install?proxy=1");
    expect(p.how_to_get).toMatch(/get_install_instructions \{ "proxy": true \}/);
  });
  it("parses the user agent for GA4 device info", () => {
    const d = deviceFrom(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      "en-GB,en;q=0.9",
    );
    expect(d).toMatchObject({ category: "mobile", browser: "Mobile Safari", os: "iOS", language: "en-GB" });
  });
  it("compiles a script whose inlined JSON can't break out", () => {
    const js = compileScript("/*rt*/", {
      id: "ctr_abcdefgh12345678",
      v: 1,
      d: "x.test",
      cfg: { tags: [{ id: "h", type: "custom_html", params: { html: "</script><script>alert(1)</script>" }, triggers: ["t"] }] },
    });
    expect(js).not.toContain("</script>");
    expect(js).toContain("\\u003c/script>");
    expect(js.startsWith("/* AgentFirstStack tags ctr_abcdefgh12345678 v1 */")).toBe(true);
  });
  it("test traffic: the runtime's flag, any preview token (even an expired one), or ?afsa_debug=1 in the page URL", () => {
    const base = { container_id: "ctr_abcdefgh12345678", type: "visit" as const, page_url: "https://shop.test/" };
    expect(isTestHit(collectSchema.parse({ ...base, test: 1 }))).toBe(true);
    expect(isTestHit(collectSchema.parse({ ...base, test: true }))).toBe(true);
    expect(isTestHit(collectSchema.parse({ ...base, preview: "prv_expiredexpiredexpired00" }))).toBe(true);
    expect(isTestHit(collectSchema.parse({ ...base, page_url: "https://shop.test/p?utm_source=x&afsa_debug=1#top" }))).toBe(true);
    expect(isTestHit(collectSchema.parse(base))).toBe(false);
    expect(isTestHit(collectSchema.parse({ ...base, test: 0 }))).toBe(false);
    expect(isTestHit(collectSchema.parse({ ...base, page_url: "https://shop.test/?afsa_debug=0" }))).toBe(false);
    expect(isTestHit(collectSchema.parse({ ...base, page_url: "https://shop.test/?no_afsa_debug=1" }))).toBe(false);
    expect(() => collectSchema.parse({ ...base, test: "yes" })).toThrow();
  });
  it("an automated browser is one whose user agent says Headless and nothing else bot-like", () => {
    expect(
      automatedBrowser("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36"),
    ).toBe(true);
    expect(automatedBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36")).toBe(false);
    expect(automatedBrowser("Mozilla/5.0 (compatible; Googlebot/2.1) HeadlessChrome/130.0")).toBe(false);
    expect(automatedBrowser("HeadlessChrome/130 Lighthouse")).toBe(false);
    expect(automatedBrowser("Mozilla/5.0 (compatible; SemrushBot/7)")).toBe(false);
  });
});

describe("origin allow-list", async () => {
  const { hostAllowed, originHost } = await import("../src/service/origin");
  it("domain, subdomains, explicit hosts and wildcards", () => {
    const s = { domain: "shop.test", allowed_hostnames: ["localhost", "*.staging.example.net"] };
    expect(hostAllowed("shop.test", s)).toBe(true);
    expect(hostAllowed("www.shop.test", s)).toBe(true);
    expect(hostAllowed("evilshop.test", s)).toBe(false);
    expect(hostAllowed("localhost", s)).toBe(true);
    expect(hostAllowed("a.staging.example.net", s)).toBe(true);
    expect(hostAllowed("example.net", s)).toBe(false);
    expect(originHost("null", "https://www.shop.test/x")).toBe("www.shop.test");
  });
});
