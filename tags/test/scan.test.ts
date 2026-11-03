import html from "./fixtures/site-html";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate";
import {
  analyze,
  detectCtas,
  detectForms,
  detectTags,
  detectThankYouUrls,
  fetchPage,
  interestingLinks,
  MAX_HTML,
  scanSite,
  scanTarget,
} from "../src/service/scan";

describe("scan detection on fixture HTML", () => {
  const d = detectTags(html);
  it("finds Google ids", () => {
    expect(d.gtm).toEqual(["GTM-ABC1234"]);
    expect(d.ga4).toEqual(["G-QWERTY1234"]);
    expect(d.google_ads).toEqual(["AW-987654321"]);
    expect(d.google_ads_conversions).toEqual(["AW-987654321/AbC-dEf123"]);
    expect(d.gtag_consent_default).toBe(true);
  });
  it("finds pixels", () => {
    expect(d.meta_pixel).toEqual(["1234567890123456"]);
    expect(d.tiktok_pixel).toEqual(["CABCDEFGHIJ1234567890"]);
    expect(d.linkedin_insight).toEqual(["7654321"]);
    expect(d.microsoft_uet).toEqual(["56781234"]);
    expect(d.reddit_pixel).toEqual(["a2_abc123def"]);
    expect(d.x_pixel).toEqual(["o1abc"]);
    expect(d.pinterest_tag).toEqual(["2612345678901"]);
  });
  it("finds our container, analytics, consent platform, CMS and dataLayer events", () => {
    expect(d.our_containers).toEqual(["ctr_abcdefgh12345678"]);
    expect(d.our_analytics_sites).toEqual(["site_3k9x2m7q8w1e5r4t"]);
    expect(d.consent_platforms).toContain("Cookiebot");
    expect(d.platform).toContain("WordPress");
    expect(d.data_layer_events).toEqual(["purchase"]);
  });
  it("finds forms with selectors, fields and kinds", () => {
    const forms = detectForms(html, "/");
    expect(forms.map((f) => [f.selector, f.kind])).toEqual([
      ["form#contact", "contact"],
      ['form[action="https://list.example.com/subscribe"]', "newsletter"],
      ['form[action="/search"]', "search"],
    ]);
    expect(forms[0]).toMatchObject({
      action: "/api/contact",
      method: "post",
      has_email: true,
      has_phone: true,
      submit_text: "Send message",
    });
    expect(forms[0]!.fields.map((f) => f.name)).toEqual(["name", "email", "phone", "_redirect", "message"]);
  });
  it("finds CTAs and thank-you pages", () => {
    const ctas = detectCtas(html, "/");
    expect(ctas.map((c) => c.kind)).toEqual(expect.arrayContaining(["booking", "call", "purchase", "contact"]));
    expect(ctas.find((c) => c.kind === "call")!.selector).toBe("a[href^='tel:']");
    expect(ctas.find((c) => c.kind === "purchase")!.selector).toBe("#buy-btn");
    expect(detectThankYouUrls(html, "https://acme.example/")).toEqual(["/thank-you"]);
    expect(interestingLinks(html, "https://acme.example/")).toEqual(
      expect.arrayContaining(["https://acme.example/pricing", "https://acme.example/contact-us", "https://acme.example/book"]),
    );
  });
  it("suggests a config that validates, and marks page content untrusted", () => {
    const r = analyze([{ url: "https://acme.example/", html }], "ctr_abcdefgh12345678");
    expect(r.container_installed).toBe(true);
    expect(r.page_content._untrusted).toMatch(/untrusted|instructions/i);
    const cfg = r.suggested_config;
    expect(cfg.tags!.map((t) => t.type)).toEqual(
      expect.arrayContaining([
        "ga4",
        "google_ads",
        "meta_pixel",
        "tiktok_pixel",
        "linkedin_insight",
        "microsoft_uet",
        "reddit_pixel",
        "x_pixel",
        "pinterest_tag",
        "analytics",
      ]),
    );
    expect(cfg.conversions!.map((c) => c.name)).toEqual(expect.arrayContaining(["lead", "purchase", "phone_call_click"]));
    const v = validateConfig(cfg);
    expect(v.errors).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/Google Tag Manager/);
  });
  it("only scans the container's own domain", () => {
    expect(scanTarget("acme.example").toString()).toBe("https://acme.example/");
    expect(scanTarget("acme.example", "https://shop.acme.example/x").hostname).toBe("shop.acme.example");
    expect(() => scanTarget("acme.example", "https://evil.test/")).toThrow();
    expect(() => scanTarget("acme.example", "file:///etc/passwd")).toThrow();
  });
});

describe("scan fetches stay on the container's domain", () => {
  type Route = (url: string) => Response;
  const fake = (route: Route) => {
    const calls: { url: string; redirect?: string }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, redirect: init?.redirect });
      return route(url);
    }) as typeof fetch;
    return { f, calls };
  };
  const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });
  const page = (html = "<html><title>ok</title></html>") => new Response(html, { headers: { "content-type": "text/html" } });

  it("follows redirects by hand while they stay on the domain or a subdomain", async () => {
    const { f, calls } = fake((u) =>
      u === "https://acme.example/"
        ? redirect("https://www.acme.example/")
        : u === "https://www.acme.example/"
          ? redirect("/home", 301)
          : page(),
    );
    const r = await fetchPage("https://acme.example/", "acme.example", f);
    expect(r).toMatchObject({ url: "https://www.acme.example/home", status: 200 });
    expect(r.html).toContain("<title>ok</title>");
    expect(calls.map((c) => c.redirect)).toEqual(["manual", "manual", "manual"]);
  });
  it("does not follow a redirect off the domain", async () => {
    const { f, calls } = fake((u) => (u.startsWith("https://acme.example/") ? redirect("https://evil.test/steal") : page("SECRET")));
    const r = await fetchPage("https://acme.example/", "acme.example", f);
    expect(r.html).toBe("");
    expect(r.error).toMatch(/evil\.test.*not followed/);
    expect(calls).toHaveLength(1);
    // Lookalike hosts and non-http schemes are off-domain too.
    for (const to of ["https://evilacme.example/", "https://acme.example.evil.test/", "file:///etc/passwd"]) {
      const g = fake((u) => (u === "https://acme.example/" ? redirect(to) : page("SECRET")));
      expect((await fetchPage("https://acme.example/", "acme.example", g.f)).html).toBe("");
      expect(g.calls).toHaveLength(1);
    }
  });
  it("stops after 3 hops", async () => {
    let n = 0;
    const { f, calls } = fake(() => redirect(`https://acme.example/r${++n}`));
    const r = await fetchPage("https://acme.example/", "acme.example", f);
    expect(r.error).toMatch(/More than 3 redirects/);
    expect(calls).toHaveLength(4);
  });
  it("reads at most 1 MB of a page", async () => {
    const { f } = fake(() => page("x".repeat(3 * 1024 * 1024)));
    const r = await fetchPage("https://acme.example/", "acme.example", f);
    expect(MAX_HTML).toBe(1024 * 1024);
    expect(r.html.length).toBe(MAX_HTML);
  });
  it("scanSite uses the same guarded fetch for every page", async () => {
    const { f, calls } = fake((u) => (u === "https://acme.example/" ? page(html) : redirect("https://evil.test/")));
    const r = await scanSite("acme.example", "ctr_abcdefgh12345678", {}, f);
    expect(calls.every((c) => c.redirect === "manual" && new URL(c.url).hostname.endsWith("acme.example"))).toBe(true);
    expect(r.pages.filter((p) => p.error).every((p) => /not followed/.test(p.error!))).toBe(true);
  });
});
