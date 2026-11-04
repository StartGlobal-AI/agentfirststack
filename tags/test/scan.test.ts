import html from "./fixtures/site-html";
import { ApiError } from "@afs/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateConfig } from "../src/config/validate";
import { readScanInput, scanInput } from "../src/service/api";
import {
  analyze,
  detectCtas,
  detectForms,
  detectTags,
  detectThankYouUrls,
  fetchPage,
  interestingLinks,
  MAX_HTML,
  MAX_SCAN_PAGES,
  MAX_SCAN_PATHS,
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

/** The shape of agentfirststack.com's homepage: nav links, a copy button, example code, a prompt template. */
const landing = `<!doctype html><html><head><title>AgentFirstStack</title>
<script type="application/ld+json">{"@type":"SoftwareApplication","description":"Replaces PostHog, Hotjar and GA4 (G-ABCDEF1234)"}</script>
<script>window.afsa=window.afsa||function(){(afsa.q=afsa.q||[]).push(arguments)}</script>
<script defer src="https://analytics.agentfirststack.com/s.js" data-site="site_6hmh1a6dbbn8mdfp"></script>
<script>if(!navigator.globalPrivacyControl)document.head.appendChild(Object.assign(document.createElement("script"),{async:true,src:"https://tags.agentfirststack.com/c/ctr_6znmv02cawfa9pb9.js"}))</script>
<!-- <script async src="https://www.googletagmanager.com/gtag/js?id=G-COMMENTED1"></script> -->
</head><body>
<header class="nav"><a class="brand" href="/" aria-label="AgentFirstStack home"><span>AgentFirstStack</span></a>
<nav class="nav-links" aria-label="Main">
<a href="#how">How it works</a>
<a href="/guides/getting-started">Get started</a>
<a href="/llms.txt">Manual</a>
<a href="https://github.com/StartGlobal-AI/agentfirststack">GitHub</a>
<a href="/signin">Sign in</a>
</nav></header>
<main>
<button class="btn btn-primary" type="button" data-copy data-cta="hero">Copy prompt for your agent</button>
<a class="btn btn-quiet" href="/llms.txt">Read the manual</a>
<button class="replay" type="button" data-replay hidden>Replay</button>
<p>Our analytics id is G-VISIBLE123 and we track sign-ups. Try fbq('init', '2222222222222222') yourself.</p>
<div class="tool"><code>create_site yourshop.com</code><span class="tool-res">site_9x2f</span></div>
<pre class="diff"><span>+ &lt;script defer src="https://analytics.agentfirststack.com/s.js" data-site="site_9x2f" /&gt;</span></pre>
<pre class="code"><script>posthog.init('phc_example')</script></pre>
<code><a href="/thank-you-example">example</a></code>
<a class="product-guide" href="/guides/sign-up-tracking">Sign up tracking, step by step</a>
<a class="btn" href="/docs/register-a-site">Register a site</a>
<a class="btn" href="/signup">Get started</a>
<a class="btn" href="/careers">Join the team</a>
<a class="btn" href="/pricing">Start free trial</a>
<ul class="mcp"><li><a href="/posthog-mcp">PostHog MCP</a></li><li><a href="/microsoft-clarity-mcp">Microsoft Clarity MCP</a></li></ul>
</main>
<footer><a href="https://startglobal.co">StartGlobal</a><a href="/privacy">Privacy</a><a href="https://github.com/StartGlobal-AI/agentfirststack">GitHub</a><a href="mailto:security@agentfirststack.com">Security</a></footer>
<template id="prompt-text">Paste &lt;script src="https://www.googletagmanager.com/gtm.js?id=GTM-TMPL123"&gt; <script>fbq('init','1111111111111111')</script> and POST /v1/signup</template>
<script src="/app.js" defer></script>
</body></html>`;

describe("scan reads only real tags and the page's real calls to action", () => {
  it("detects tags from script src, inline code and noscript fallbacks, never from links, text, example code or comments", () => {
    const d = detectTags(landing);
    expect(d.other).toEqual([]); // the /posthog-mcp and /microsoft-clarity-mcp links aren't tags
    expect(d.ga4).toEqual([]); // G- ids in JSON-LD, visible text and a comment
    expect(d.meta_pixel).toEqual([]); // fbq in text and inside <template>
    expect(d.gtm).toEqual([]);
    expect(d.our_analytics_sites).toEqual(["site_6hmh1a6dbbn8mdfp"]); // not the escaped site_9x2f in <pre>
    expect(d.our_containers).toEqual(["ctr_6znmv02cawfa9pb9"]); // injected by an inline loader
    expect(detectThankYouUrls(landing, "https://agentfirststack.com/")).toEqual([]); // the link inside <code>
    // A real PostHog or Clarity install is still found.
    const real = detectTags(
      `<script src="https://us-assets.i.posthog.com/static/array.js"></script><script>posthog.init('phc_x',{api_host:'https://us.i.posthog.com'})</script><script async src="https://www.clarity.ms/tag/abc"></script>`,
    );
    expect(real.other).toEqual(["Microsoft Clarity", "PostHog"]);
    expect(detectTags(`<script>!function(t,e){window.posthog=e}()</script>`).other).toEqual(["PostHog"]);
  });

  it("reports the main buttons and links: copy buttons, nav, header and outbound links, login; signup only when it means signup", () => {
    const ctas = detectCtas(landing, "/", "agentfirststack.com");
    const by = (sel: string) => ctas.find((c) => c.selector === sel);
    expect(by("button[data-copy]")).toMatchObject({
      text: "Copy prompt for your agent",
      kind: "copy",
      element: "button",
      area: "main",
      data_attributes: ["data-copy", "data-cta"],
    });
    expect(by('a[href="https://github.com/StartGlobal-AI/agentfirststack"]')).toMatchObject({
      kind: "outbound",
      outbound: true,
      area: "nav",
    });
    expect(by('a[href="/llms.txt"]')).toMatchObject({ kind: "other", area: "nav" });
    expect(by('a[href="/signin"]')).toMatchObject({ kind: "login", area: "nav" });
    expect(by('a[href="https://startglobal.co"]')).toMatchObject({ kind: "outbound", area: "footer" });
    expect(by("a[href^='mailto:']")).toMatchObject({ kind: "email" });
    // Signup: the label is a signup verb or the link goes to a signup page. Guides, docs and careers aren't.
    expect(by('a[href="/signup"]')?.kind).toBe("signup");
    expect(by('a[href="/pricing"]')?.kind).toBe("signup");
    expect(by('a[href="/guides/getting-started"]')?.kind).toBe("other");
    expect(by('a[href="/docs/register-a-site"]')?.kind).toBe("other");
    expect(by('a[href="/careers"]')?.kind).toBe("other");
    expect(ctas.filter((c) => c.kind === "signup").map((c) => c.href)).toEqual(["/signup", "/pricing"]);
    // Plain in-content links, hidden buttons and example code aren't calls to action.
    expect(by('a[href="/guides/sign-up-tracking"]')).toBeUndefined();
    expect(by('a[href="/posthog-mcp"]')).toBeUndefined();
    expect(ctas.some((c) => /Replay/.test(c.text))).toBe(false);
    expect(ctas.some((c) => c.href === "/thank-you-example")).toBe(false);
    // A footer link the nav already has is listed once; each selector + kind once.
    expect(ctas.filter((c) => c.href === "https://github.com/StartGlobal-AI/agentfirststack")).toHaveLength(1);
    const r = analyze([{ url: "https://agentfirststack.com/", html: landing }], "ctr_6znmv02cawfa9pb9");
    expect(r.container_installed).toBe(true);
    expect(r.suggested_config.tags!.find((t) => t.type === "analytics")?.params).toEqual({ site_id: "site_6hmh1a6dbbn8mdfp" });
  });

  it("forms inside <template> or example code aren't the page's forms", () => {
    const html = `<template><form id="tpl"><input type="email" name="email"></form></template><pre>&lt;form id="ex"&gt;</pre><form id="real" action="/subscribe"><input type="email" name="email"></form>`;
    expect(detectForms(html, "/").map((f) => f.selector)).toEqual(["form#real"]);
  });

  it("paths: the homepage plus up to 5; the 400 says so", () => {
    expect(MAX_SCAN_PATHS).toBe(5);
    expect(MAX_SCAN_PAGES).toBe(6);
    expect(readScanInput({ paths: ["/a", "/b", "/c", "/d", "/e"] }).paths).toHaveLength(5);
    let err: unknown;
    try {
      readScanInput({ paths: ["/a", "/b", "/c", "/d", "/e", "/f"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    const body = (err as ApiError).toJSON().error;
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/at most 5/);
    expect(body.hint).toMatch(/homepage \(or url\) plus up to 5 paths: 6 pages at most/);
    // MCP clients see the same limit in the tool's input schema and validation message.
    const schema = z.toJSONSchema(scanInput) as unknown as { properties: { paths: { maxItems: number; description: string } } };
    expect(schema.properties.paths.maxItems).toBe(5);
    expect(schema.properties.paths.description).toMatch(/at most 5/);
    const issue = scanInput.safeParse({ paths: Array(6).fill("/x") }).error!.issues[0]!;
    expect(issue.message).toMatch(/homepage \(or url\) plus up to 5 paths/);
  });
});
