/**
 * The consent banner (consent_banner): config validation, the country rule and category mapping,
 * and the real bundled runtime + banner UI in the fake browser (served as /c/:id.js serves them):
 * Consent Mode v2 default before any Google tag and update on the choice, tags gated by category,
 * the dataLayer event, replay and analytics hooks, the stored choice (version, expiry), the
 * anonymous proof-of-consent hit, reopening, and the UI's law-shaped, accessible layers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { ContainerConfig } from "../src/config/schema";
import { contrast, parseConfig, validateConfig } from "../src/config/validate";
import { BANNER_CATEGORIES, bannerAsks, bannerState } from "../src/lib/consent";
import { dependsOnCountry } from "../src/service/script";
import { BASE, bannerUi, browser, el, type FakeEl, lastFocused, loadRuntimes, serve } from "./fixtures/browser";

beforeAll(async () => {
  await loadRuntimes();
});

type W = Record<string, unknown>;
const gtagCalls = (w: W) =>
  ((w.dataLayer as unknown[]) ?? [])
    .filter((x) => Object.prototype.toString.call(x) === "[object Arguments]")
    .map((a) => Array.from(a as ArrayLike<unknown>));
const consentCalls = (w: W, kind: "default" | "update") => gtagCalls(w).filter((c) => c[0] === "consent" && c[1] === kind);
const queue = (w: W, k: "afsr" | "afsa") => ((w[k] as { q?: ArrayLike<unknown>[] } | undefined)?.q ?? []).map((a) => Array.from(a));
const dlEvents = (w: W) => ((w.dataLayer as unknown[]) ?? []).filter((x) => (x as { event?: string })?.event === "afst_consent");
const afst = (w: W) => w.afst as (...a: unknown[]) => unknown;
const fired = (w: W) => (w.__afst_debug as { kind: string; msg: string }[]).filter((e) => e.kind === "fire").map((e) => e.msg);
const host = (w: W) =>
  w.__afst_cbh as { l: number; id: string; c: boolean[]; done: (a: boolean, d: boolean, p: boolean, m: string, lang?: string) => void };

const config: ContainerConfig = {
  triggers: [{ id: "all_pages", type: "page_view" }],
  tags: [
    { id: "ga4", type: "ga4", params: { measurement_id: "G-ABC123XYZ" }, triggers: ["all_pages"] },
    { id: "meta", type: "meta_pixel", params: { pixel_id: "1234567890123456" }, triggers: ["all_pages"] },
    { id: "stats", type: "custom_js", params: { code: "window.__stats = 1" }, triggers: ["all_pages"], consent: ["analytics_storage"] },
    { id: "prefs", type: "custom_js", params: { code: "window.__prefs = 1" }, triggers: ["all_pages"], consent: ["functionality_storage"] },
  ],
  consent_banner: { enabled: true, privacy_url: "https://shop.test/privacy" },
};

describe("consent_banner config", () => {
  it("parses a one-line banner and rejects bad fields with their paths", () => {
    expect(parseConfig({ consent_banner: { enabled: true } }).ok).toBe(true);
    const bad = parseConfig({
      consent_banner: {
        enabled: true,
        categories: ["ads", "ads"],
        languages: { DE: { title: "x" } },
        text: { title: "" },
        position: "left",
        version: 0,
        extra: 1,
      },
    });
    expect(bad.ok).toBe(false);
    const paths = (bad as { errors: { path: string }[] }).errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "consent_banner.categories",
        "consent_banner.languages.DE",
        "consent_banner.text.title",
        "consent_banner.position",
        "consent_banner.version",
        "consent_banner",
      ]),
    );
    expect(parseConfig({ consent_banner: { enabled: true, expiry_days: 396 } }).ok).toBe(false);
    expect(parseConfig({ consent_banner: { enabled: true, expiry_days: 395, privacy_url: "/legal/privacy" } }).ok).toBe(true);
    expect(parseConfig({ consent_banner: { enabled: true, privacy_url: "javascript:alert(1)" } }).ok).toBe(false);
  });

  it("warns about banners that are unlawful or never take effect, and drops the warnings a banner answers", () => {
    const codes = (cfg: ContainerConfig) => validateConfig(cfg).warnings.map((w) => w.code);
    const ads: ContainerConfig = { triggers: config.triggers, tags: [config.tags![1]!] };
    expect(codes(ads)).toContain("consent_not_configured");
    expect(codes({ ...ads, consent_banner: { enabled: true, privacy_url: "/privacy" } })).not.toContain("consent_not_configured");
    expect(codes({ ...ads, consent: { mode: "opt_in" }, consent_banner: { enabled: true, privacy_url: "/privacy" } })).toEqual(
      expect.arrayContaining(["consent_banner_outside_denied"]),
    );
    expect(
      codes({ ...ads, consent: { mode: "opt_in" }, consent_banner: { enabled: true, regions: "all", privacy_url: "/p" } }),
    ).not.toContain("consent_needs_banner");
    expect(codes({ ...ads, consent_banner: { enabled: true } })).toContain("consent_banner_no_privacy_url");
    expect(codes({ ...ads, consent_banner: { enabled: true, categories: ["analytics"], privacy_url: "/p" } })).toContain(
      "consent_banner_no_ads_category",
    );
    expect(codes({ ...ads, consent: { tcf: true }, consent_banner: { enabled: true, privacy_url: "/p" } })).toContain(
      "consent_banner_and_tcf",
    );
    const bypass: ContainerConfig = {
      triggers: config.triggers,
      tags: [{ ...config.tags![1]!, consent: [] } as NonNullable<ContainerConfig["tags"]>[number]],
      consent_banner: { enabled: true, privacy_url: "/p" },
    };
    expect(validateConfig(bypass).warnings.find((w) => w.code === "consent_banner_bypassed")?.path).toBe("tags.0.consent");
    const low = validateConfig({ consent_banner: { enabled: true, privacy_url: "/p", colors: { accent: "#7fa0ff" } } });
    expect(low.warnings.find((w) => w.code === "consent_banner_contrast")?.path).toBe("consent_banner.colors.accent");
    expect(contrast("#000", "#fff")).toBeCloseTo(21, 0);
    expect(contrast("#1f2328", "#ffffff")).toBeGreaterThan(4.5);
  });

  it("asks in the EEA, the UK, Switzerland and where the country is unknown; maps categories to Consent Mode v2", () => {
    const b = { enabled: true };
    expect(["DE", "FR", "IS", "NO", "GB", "CH", "XX", "T1", "", undefined].map((c) => bannerAsks(b, c))).toEqual(Array(10).fill(true));
    expect(["US", "BR", "IN", "JP"].map((c) => bannerAsks(b, c))).toEqual([false, false, false, false]);
    expect(bannerAsks({ enabled: true, regions: "all" }, "US")).toBe(true);
    expect(bannerAsks({ enabled: false }, "DE")).toBe(false);
    expect(bannerState("101")).toEqual({
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "granted",
      personalization_storage: "granted",
      functionality_storage: "granted",
    });
    expect(bannerState("")).toMatchObject({ analytics_storage: "denied", ad_storage: "denied", ad_personalization: "denied" });
    expect(BANNER_CATEGORIES.ads).toEqual(["ad_storage", "ad_user_data"]);
    expect(dependsOnCountry(config)).toBe(true);
    expect(dependsOnCountry({ consent_banner: { enabled: true, regions: "all" } })).toBe(false);
    expect(dependsOnCountry({ consent: { regions: { EEA: { ad_storage: "denied" } } } })).toBe(true);
    expect(dependsOnCountry({ tags: [] })).toBe(false);
  });
});

describe("consent banner in the runtime", () => {
  it("EEA visitor: Consent Mode default denied before any Google tag, tags wait, replay waits, the UI loads", () => {
    const b = browser("https://shop.test/");
    b.run(serve(config, { geo: { country: "DE" } }));
    const w = b.win;
    const defaults = consentCalls(w, "default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0]![2]).toMatchObject({
      ad_storage: "denied",
      analytics_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
      functionality_storage: "denied",
      security_storage: "granted",
    });
    expect(gtagCalls(w).some((c) => c[0] === "config")).toBe(false); // GA4 waits for analytics_storage
    expect(fired(w)).toEqual([]);
    expect(b.scripts()).toContain(`${BASE}/cb/0.js`);
    expect(host(w)).toMatchObject({ l: 0, id: "", c: [false, false, false] });
    expect(queue(w, "afsr")).toEqual([["consent", false, 1]]); // replay: "not yet"
    expect(dlEvents(w)).toEqual([]); // nothing decided yet
    expect(b.fetches.some((f) => f.body.type === "visit")).toBe(false); // no visitor id stored or sent
    expect(b.jar._afst_vid).toBeUndefined();
  });

  it("a choice updates Consent Mode, releases the tags of the granted categories only, tells replay and analytics, and records proof", () => {
    const analyticsScript = el("script", { src: "https://analytics.test/s.js", "data-site": "site_1", "data-require-consent": "true" });
    const b = browser("https://shop.test/", { cookies: { _afst_gclid: "G-1" } });
    (b.doc.head as unknown as FakeEl).appendChild(analyticsScript);
    b.run(serve(config, { geo: { country: "FR" } }));
    const w = b.win;
    host(w).done(true, false, false, "custom", "fr");

    expect(consentCalls(w, "update")).toEqual([["consent", "update", { analytics_storage: "granted" }]]);
    // Consent Mode: default, then the update, then (released) the Google tag's config.
    const calls = gtagCalls(w);
    const at = (f: (c: unknown[]) => boolean) => calls.findIndex(f);
    const order = [
      at((c) => c[0] === "consent" && c[1] === "default"),
      at((c) => c[0] === "consent" && c[1] === "update"),
      at((c) => c[0] === "config" && c[1] === "G-ABC123XYZ"),
    ];
    expect(order[0]).toBe(0);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    const f = fired(w);
    expect(f).toContain("tag ga4 (ga4) (released by consent)");
    expect(f).toContain("tag stats (custom_js) (released by consent)");
    expect(f.some((m) => m.includes("meta"))).toBe(false); // ads not granted
    expect(f.some((m) => m.includes("prefs"))).toBe(false); // personalization not granted
    expect(afst(w)("get", "consent")).toMatchObject({
      analytics_storage: "granted",
      ad_storage: "denied",
      functionality_storage: "denied",
    });

    const id = afst(w)("get", "consent_id") as string;
    expect(id).toMatch(/^[0-9a-z]{20}$/);
    const [cid, version, secs, bits] = decodeURIComponent(b.jar._afst_cc!).split(".");
    expect([cid, version, bits]).toEqual([id, "1", "100"]);
    expect(Math.abs(Number(secs) - Date.now() / 1000)).toBeLessThan(5);
    expect(b.jar._afst_gclid).toBeUndefined(); // ads refused: our click id cookie goes

    expect(dlEvents(w)).toEqual([
      { event: "afst_consent", afst_consent: { analytics: true, ads: false, personalization: false, method: "custom" } },
    ]);
    expect(queue(w, "afsr")).toEqual([
      ["consent", false, 1],
      ["consent", true],
    ]);
    expect(queue(w, "afsa")).toEqual([["consent", true]]);

    const rec = b.fetches.find((x) => x.body.type === "consent")!;
    expect(rec.url).toBe(`${BASE}/collect`);
    expect(rec.body.consent_record).toEqual({
      id,
      version: 1,
      analytics: true,
      ads: false,
      personalization: false,
      method: "custom",
      language: "fr",
    });
    // Anonymous: no visitor id, click ids, utm or GA ids, though analytics consent now allows them.
    for (const k of ["visitor_id", "click_ids", "first_touch", "ga_client_id", "fbp"]) expect(rec.body[k], k).toBeUndefined();
  });

  it("outside the regions: the configured defaults, no banner, the default is announced", () => {
    const b = browser("https://shop.test/");
    b.run(serve(config, { geo: { country: "US" } }));
    const w = b.win;
    expect(consentCalls(w, "default")[0]![2]).toMatchObject({ ad_storage: "granted", analytics_storage: "granted" });
    expect(b.scripts()).not.toContain(`${BASE}/cb/0.js`);
    expect(fired(w)).toEqual(expect.arrayContaining(["tag meta (meta_pixel)", "tag ga4 (ga4)"]));
    expect(dlEvents(w)).toEqual([
      { event: "afst_consent", afst_consent: { analytics: true, ads: true, personalization: true, method: "default" } },
    ]);
    expect(queue(w, "afsr")).toEqual([["consent", true]]);
    expect(queue(w, "afsa")).toEqual([]); // no tracker waiting for consent on this page
    // ?afst_consent=open shows it anyway (an agent checking the banner from anywhere).
    const forced = browser("https://shop.test/?afst_consent=open");
    forced.run(serve(config, { geo: { country: "US" } }));
    expect(host(forced.win)).toMatchObject({ l: 0, c: [true, true, true] });
  });

  it("a stored choice applies without the banner; a new version or an expired choice asks again (same consent id)", () => {
    const now = Math.floor(Date.now() / 1000);
    const cookie = (secs: number, v = 1, bits = "011") => ({ _afst_cc: `abcdefghjkmnpqrstvwx.${v}.${secs}.${bits}` });
    const b = browser("https://shop.test/", { cookies: cookie(now - 86_400) });
    b.run(serve(config, { geo: { country: "DE" } }));
    expect(b.scripts()).not.toContain(`${BASE}/cb/0.js`);
    expect(consentCalls(b.win, "default")[0]![2]).toMatchObject({
      analytics_storage: "denied",
      ad_storage: "granted",
      ad_user_data: "granted",
    });
    expect(fired(b.win)).toEqual(expect.arrayContaining(["tag meta (meta_pixel)", "tag prefs (custom_js)"]));
    expect(dlEvents(b.win)[0]).toMatchObject({ afst_consent: { analytics: false, ads: true, personalization: true, method: "stored" } });
    expect(queue(b.win, "afsr")).toEqual([["consent", false]]);

    const bumped = browser("https://shop.test/", { cookies: cookie(now - 86_400) });
    bumped.run(serve({ ...config, consent_banner: { ...config.consent_banner!, version: 2 } }, { geo: { country: "DE" } }));
    expect(bumped.scripts()).toContain(`${BASE}/cb/0.js`);
    expect(fired(bumped.win)).toEqual([]);
    expect(afst(bumped.win)("get", "consent_id")).toBe("abcdefghjkmnpqrstvwx");

    const expired = browser("https://shop.test/", { cookies: cookie(now - 181 * 86_400) });
    expired.run(serve(config, { geo: { country: "DE" } }));
    expect(expired.scripts()).toContain(`${BASE}/cb/0.js`);
    const longer = browser("https://shop.test/", { cookies: cookie(now - 181 * 86_400) });
    longer.run(serve({ ...config, consent_banner: { ...config.consent_banner!, expiry_days: 365 } }, { geo: { country: "DE" } }));
    expect(longer.scripts()).not.toContain(`${BASE}/cb/0.js`);
    // The old _afst_consent cookie (set by afst('consent','update')) doesn't stand in for a banner choice.
    const legacy = browser("https://shop.test/", {
      cookies: { _afst_consent: encodeURIComponent(JSON.stringify({ ad_storage: "granted" })) },
    });
    legacy.run(serve(config, { geo: { country: "DE" } }));
    expect(fired(legacy.win)).toEqual([]);
  });

  it("withdrawing consent removes our identity cookies; afst('consent','open') and data-afst-consent-open reopen the settings", () => {
    const link = el("a", { href: "#", "data-afst-consent-open": "" });
    const b = browser("https://shop.test/", {
      cookies: { _afst_cc: `abcdefghjkmnpqrstvwx.1.${Math.floor(Date.now() / 1000)}.111`, _afst_vid: "vid123456.1", _afst_gclid: "G-1" },
      body: [link],
    });
    b.run(serve(config, { geo: { country: "DE" } }));
    const w = b.win;
    expect(b.scripts()).not.toContain(`${BASE}/cb/0.js`);
    afst(w)("consent", "open");
    expect(b.scripts()).toContain(`${BASE}/cb/0.js`);
    expect(host(w)).toMatchObject({ l: 1, id: "abcdefghjkmnpqrstvwx", c: [true, true, true] });
    host(w).done(false, false, false, "reject_all");
    expect(consentCalls(w, "update")[0]![2]).toMatchObject({
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_personalization: "denied",
    });
    expect(b.jar._afst_vid).toBeUndefined();
    expect(b.jar._afst_gclid).toBeUndefined();
    expect(decodeURIComponent(b.jar._afst_cc!)).toMatch(/^abcdefghjkmnpqrstvwx\.1\.\d+\.000$/);
    // A footer link reopens it too (the click is the page's; the default is prevented).
    let prevented = false;
    b.dispatch("click", link, {
      preventDefault() {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    expect(host(w)).toMatchObject({ l: 1, c: [false, false, false] });
  });

  it("test traffic: the banner works, and the record is marked test (never kept)", () => {
    const b = browser("https://shop.test/?afsa_debug=1");
    b.run(serve(config, { geo: { country: "DE" } }));
    host(b.win).done(true, true, true, "accept_all");
    expect(b.fetches.find((x) => x.body.type === "consent")!.body.test).toBe(1);
  });
});

/** Every node under n (shadow roots included), depth first. */
function walk(n: FakeEl, out: FakeEl[] = []): FakeEl[] {
  for (const c of n.children) {
    out.push(c);
    walk(c, out);
  }
  if (n.shadowRoot) walk(n.shadowRoot, out);
  return out;
}
const textOf = (n: FakeEl): string => (n.tagName === "#TEXT" ? (n.textContent ?? "") : n.children.map(textOf).join(""));

describe("consent banner UI (the separate script)", () => {
  function open(cfg: ContainerConfig = config, url = "https://shop.test/", lang?: string) {
    const b = browser(url);
    if (lang) (b.doc.documentElement as unknown as FakeEl).lang = lang;
    b.run(serve(cfg, { geo: { country: "DE" } }));
    b.run(bannerUi());
    const root = (b.doc.body as unknown as FakeEl).querySelector("#afst-consent")!.shadowRoot!;
    const nodes = () => walk(root);
    const buttons = () => nodes().filter((n) => n.tagName === "BUTTON");
    const button = (label: string) => buttons().find((x) => textOf(x) === label)!;
    return { b, w: b.win, root, nodes, buttons, button };
  }

  it("first layer: a labelled dialog where Reject all is exactly as prominent as Accept all, with the privacy link", () => {
    const { nodes, buttons, button } = open();
    const dlg = nodes().find((n) => n.attrs.role === "dialog")!;
    expect(dlg.attrs).toMatchObject({ "aria-modal": "false", "aria-labelledby": "afst-t", "aria-describedby": "afst-m", tabindex: "-1" });
    expect(lastFocused).toBe(dlg); // focus moves into the banner
    expect(textOf(nodes().find((n) => n.attrs.id === "afst-t")!)).toBe("We value your privacy");
    expect(buttons().map(textOf)).toEqual(["Reject all", "Accept all", "Customize"]);
    expect(button("Reject all").attrs.class).toBe(button("Accept all").attrs.class);
    expect(button("Customize").attrs.class).not.toBe(button("Accept all").attrs.class);
    expect(nodes().find((n) => n.tagName === "A")!.attrs).toMatchObject({ href: "https://shop.test/privacy", rel: "noopener" });
    expect(textOf(nodes().find((n) => n.tagName === "STYLE")!)).toContain("prefers-reduced-motion");
  });

  it("settings layer: necessary always on, nothing pre-ticked; Save records custom; Escape goes back; reopened it shows the choice", () => {
    const { b, w, root, nodes, button } = open();
    button("Customize").click();
    const boxes = () => nodes().filter((n) => n.tagName === "INPUT");
    expect(boxes().map((x) => [x.attrs.id, !!x.checked, !!x.disabled])).toEqual([
      ["afst-c-necessary", true, true],
      ["afst-c-analytics", false, false],
      ["afst-c-ads", false, false],
      ["afst-c-personalization", false, false],
    ]);
    expect(nodes().find((n) => n.attrs.role === "dialog")!.attrs["aria-modal"]).toBe("true");
    // Escape on the first visit's settings goes back to the first layer (no choice made).
    nodes()
      .find((n) => n.listeners.keydown)!
      .fire("keydown", { key: "Escape" });
    expect(textOf(root)).toContain("Customize");
    expect(b.fetches.some((x) => x.body.type === "consent")).toBe(false);
    expect(afst(w)("get", "consent_id")).toBe("");

    button("Customize").click();
    boxes()[1]!.checked = true; // analytics
    button("Save choices").click();
    expect(afst(w)("get", "consent")).toMatchObject({ analytics_storage: "granted", ad_storage: "denied" });
    expect(b.fetches.find((x) => x.body.type === "consent")!.body.consent_record).toMatchObject({
      method: "custom",
      analytics: true,
      ads: false,
    });
    expect(nodes().some((n) => n.attrs.role === "dialog")).toBe(false); // closed

    afst(w)("consent", "open");
    expect(boxes().map((x) => !!x.checked)).toEqual([true, true, false, false]);
    expect(textOf(root)).toContain(`Your consent ID: ${afst(w)("get", "consent_id")}`);
    expect(nodes().some((n) => n.attrs["aria-label"] === "Close")).toBe(true);
  });

  it("a visitor who must choose can't make the banner go away by closing the settings", () => {
    const { w, root, nodes } = open();
    afst(w)("consent", "open"); // the settings layer straight away (a footer link)
    expect(textOf(root)).toContain("Save choices");
    nodes()
      .find((n) => n.attrs["aria-label"] === "Close")!
      .click();
    expect(textOf(root)).toContain("Customize"); // back at the first layer, still asking
    expect(afst(w)("get", "consent_id")).toBe("");
  });

  it("only the configured categories, per-language text, Accept all grants only what's shown, and the optional reopen button", () => {
    const cfg: ContainerConfig = {
      ...config,
      consent_banner: {
        enabled: true,
        categories: ["analytics"],
        position: "center",
        reopen_button: true,
        text: { title: "Cookies?" },
        languages: { de: { accept: "Alle akzeptieren", reject: "Alle ablehnen" } },
      },
    };
    const { w, nodes, buttons, button } = open(cfg, "https://shop.test/", "de-AT");
    expect(textOf(nodes().find((n) => n.attrs.id === "afst-t")!)).toBe("Cookies?");
    expect(buttons().map(textOf)).toEqual(["Alle ablehnen", "Alle akzeptieren", "Customize"]);
    expect(nodes().find((n) => n.attrs.role === "dialog")!.attrs).toMatchObject({ "aria-modal": "true", lang: "de" });
    button("Alle akzeptieren").click();
    expect(afst(w)("get", "consent")).toMatchObject({ analytics_storage: "granted", ad_storage: "denied", ad_personalization: "denied" });
    // The reopen button stays after the choice.
    expect(buttons().map(textOf)).toEqual(["Privacy choices"]);
    button("Privacy choices").click();
    expect(
      nodes()
        .filter((n) => n.tagName === "INPUT")
        .map((x) => x.attrs.id),
    ).toEqual(["afst-c-necessary", "afst-c-analytics"]);
  });
});
