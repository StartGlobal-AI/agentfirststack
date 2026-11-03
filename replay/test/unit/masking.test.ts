import { describe, expect, it } from "vitest";
import {
  clickTarget,
  cssEscape,
  type El,
  isInteractive,
  rawLabel,
  stableClass,
  stableId,
  stableSelector,
  tagDescriptor,
} from "../../src/lib/describe";
import {
  applyRule,
  globToRegExp,
  inputAlwaysMasked,
  maskAll,
  maskPartial,
  pathMatches,
  scrubText,
  stripQuery,
  textRule,
} from "../../src/lib/mask-rules";
import { selectorListProblems, selectorProblem } from "../../src/lib/selectors";
import type { SiteRow } from "../../src/service/context";
import { loaderConfig } from "../../src/service/sites";

describe("masking rules", () => {
  it("strict masks everything not unmasked; balanced masks digits and emails; relaxed shows text", () => {
    expect(textRule("strict", false, false)).toBe("mask");
    expect(textRule("strict", true, false)).toBe("show");
    expect(textRule("balanced", false, false)).toBe("partial");
    expect(textRule("relaxed", false, false)).toBe("show");
    // mask_selectors win over unmask_selectors in every mode
    for (const m of ["strict", "balanced", "relaxed"] as const) expect(textRule(m, true, true)).toBe("mask");
  });
  it("masking keeps length and word shape, never content", () => {
    expect(maskAll("Pay now €49")).toBe("*** *** ***");
    expect(maskPartial("Order 1234 for jo.doe+x@mail.example.com ok")).toBe("Order **** for ************************* ok");
    expect(applyRule("show", "Hi")).toBe("Hi");
    expect(applyRule("partial", "Card 4242")).toBe("Card ****");
  });
  it("passwords, card, one-time-code and hidden fields are always masked", () => {
    expect(inputAlwaysMasked("password", null, null)).toBe(true);
    expect(inputAlwaysMasked("hidden", null, null)).toBe(true);
    expect(inputAlwaysMasked("text", "cc-number", null)).toBe(true);
    expect(inputAlwaysMasked("text", "one-time-code", null)).toBe(true);
    expect(inputAlwaysMasked("text", null, "cardNumber")).toBe(true);
    expect(inputAlwaysMasked("text", null, "cvc")).toBe(true);
    expect(inputAlwaysMasked("email", "email", "email")).toBe(false);
    expect(inputAlwaysMasked("search", null, "q")).toBe(false);
  });
  it("query strings and fragments are dropped; free text is scrubbed", () => {
    expect(stripQuery("https://x.test/reset?token=abc#top")).toBe("https://x.test/reset");
    expect(stripQuery("/a")).toBe("/a");
    expect(
      scrubText(
        "Failed for jane@ex.com at https://x.test/p?email=jane%40ex.com card 4242 4242 4242 4242 key=abcdefghijklmnopqrstuvwxyz0123456789",
        500,
      ),
    ).toBe("Failed for [email] at https://x.test/p card [number] key=[token]");
    expect(scrubText("x y ".repeat(10), 10)).toBe("x y x y x…");
  });
  it("path globs: * matches anything, the rest is literal", () => {
    expect(globToRegExp("/account/*").test("/account/settings/2fa")).toBe(true);
    expect(globToRegExp("/a.b").test("/aXb")).toBe(false);
    expect(pathMatches("/admin", ["/account/*", "/admin*"])).toBe(true);
    expect(pathMatches("/pricing", ["/account/*"])).toBe(false);
  });
});

describe("selector config validation", () => {
  it("accepts ordinary selectors and refuses ones that could break out of a list", () => {
    for (const s of ["nav", "button.cta", "#hero h1", "[data-public]", 'a[href^="/docs"]', "ul > li:nth-child(2)", ":is(h1, h2)"])
      expect(selectorProblem(s)).toBeNull();
    expect(selectorProblem("")).toMatch(/empty/);
    expect(selectorProblem("a { color: red }")).toMatch(/contains/);
    expect(selectorProblem("<script>")).toMatch(/contains/);
    expect(selectorProblem("[data-x")).toMatch(/unbalanced/);
    expect(selectorProblem("a[title='x]")).toMatch(/unclosed quote/);
    expect(selectorProblem("a,,b")).toMatch(/empty item/);
    expect(selectorListProblems("unmask_selectors", ["nav", "a{"])).toEqual([
      'unmask_selectors[1] ("a{") contains { } < ; @ \\ or a newline.',
    ]);
  });
  it("the loader config carries the site's masking settings, clamped to the deployment's caps", () => {
    const site = {
      id: "rsite_0123456789abcdef",
      sample_rate: 0.5,
      mask_mode: "balanced",
      unmask_selectors: '["nav"," button "]',
      mask_selectors: '[".price"]',
      block_selectors: '["#chat"]',
      exclude_paths: '["/account/*"]',
      max_session_minutes: 60,
      require_consent: 1,
      capture_console_errors: 0,
      enabled: 1,
    } as unknown as SiteRow;
    const env = { MAX_SAMPLE_RATE: "0.1", MAX_SESSION_MINUTES: "20" } as never;
    expect(loaderConfig(site, env, "https://replay.test", "/recorder.abc.js")).toEqual({
      site: "rsite_0123456789abcdef",
      rec: "/recorder.abc.js",
      sr: 0.1,
      mask: "balanced",
      unmask: "nav,button",
      maskSel: ".price",
      block: "#chat",
      ex: ["/account/*"],
      maxMs: 20 * 60_000,
      idleMs: 300_000,
      consent: true,
      errors: false,
      on: true,
      base: "https://replay.test",
    });
    expect(loaderConfig(site, {} as never, "b", "r").sr).toBe(0.5);
  });
});

/** A tiny fake element tree for the selector and label logic. */
function el(tag: string, attrs: Record<string, string> = {}, children: (El | string)[] = []): El & { children: El[] } {
  const node: El & { children: El[]; textContent: string } = {
    tagName: tag.toUpperCase(),
    id: attrs.id ?? "",
    parentElement: null,
    getAttribute: (n: string) => (n === "class" ? (attrs.class ?? null) : (attrs[n] ?? null)),
    classList: (attrs.class ?? "").split(/\s+/).filter(Boolean),
    children: [],
    textContent: "",
  };
  for (const c of children) {
    if (typeof c === "string") node.textContent += c;
    else {
      c.parentElement = node;
      node.children.push(c);
      node.textContent += c.textContent ?? "";
    }
  }
  return node;
}

describe("element description (recorder)", () => {
  it("anchors selectors at stable ids and test attributes, skips generated ids and hashed classes", () => {
    const btn = el("button", { class: "btn css-1x2y3z primary" }, ["Pay ", el("svg")]);
    const other = el("button", { class: "btn" }, ["Back"]);
    const form = el("form", { id: "checkout" }, [el("div", { class: "row" }, [other, btn])]);
    el("body", {}, [form]);
    expect(stableSelector(btn)).toBe("#checkout > div.row > button.btn.primary:nth-of-type(2)");
    const gen = el("a", { id: ":r1:", "data-testid": "nav-home", href: "/" }, ["Home"]);
    el("nav", {}, [gen]);
    expect(stableSelector(gen)).toBe('a[data-testid="nav-home"]');
    const deep = el("span");
    let cur: El = deep;
    for (let i = 0; i < 8; i++) cur = el("div", {}, [cur]);
    expect(stableSelector(deep).split(" > ")).toHaveLength(5);
    expect(stableId("main")).toBe(true);
    expect(stableId("ember1234")).toBe(false);
    expect(stableId("a1b2c3d4e5f6a7b8")).toBe(false);
    expect(stableClass("Button_root__3hNo2")).toBe(false);
    expect(stableClass("hover:bg-blue-500")).toBe(false);
    expect(stableClass("sc-AxjAm")).toBe(false); // styled-components
    expect(stableClass("cta")).toBe(true);
    expect(cssEscape("1col")).toBe("\\31 col");
    expect(cssEscape("a.b")).toBe("a\\.b");
  });
  it("a click means the nearest interactive ancestor; labels never use input values", () => {
    const icon = el("svg");
    const btn = el("button", { "aria-label": "Close dialog" }, [icon]);
    el("div", {}, [btn]);
    expect(clickTarget(icon)).toEqual({ el: btn, interactive: true });
    expect(rawLabel(btn)).toBe("Close dialog");
    const p = el("p", {}, ["Just   some\n text"]);
    el("main", {}, [p]);
    expect(clickTarget(p)).toEqual({ el: p, interactive: false });
    expect(rawLabel(p)).toBe("Just some text");
    expect(rawLabel(el("input", { type: "submit", value: "Sign up" }))).toBe("Sign up");
    expect(rawLabel(el("input", { type: "email", value: "secret@x.test", placeholder: "Email" }))).toBe("Email");
    expect(rawLabel(el("img", { alt: "Logo" }))).toBe("Logo");
    expect(
      rawLabel(
        el(
          "div",
          {},
          Array.from({ length: 20 }, () => el("p", {}, ["x"])),
        ),
      ),
    ).toBe("");
    expect(isInteractive(el("a", { href: "/x" }))).toBe(true);
    expect(isInteractive(el("a"))).toBe(false);
    expect(isInteractive(el("div", { role: "button" }))).toBe(true);
    expect(isInteractive(el("div", { tabindex: "-1" }))).toBe(false);
    expect(tagDescriptor(el("input", { type: "EMAIL" }))).toBe("input[type=email]");
    expect(tagDescriptor(el("input"))).toBe("input[type=text]");
  });
});
