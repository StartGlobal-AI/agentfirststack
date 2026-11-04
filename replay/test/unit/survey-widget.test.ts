import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { normalizeQuestions, publicSurvey, type SurveyDef, template } from "../../src/lib/survey-def";

// The built widget (pnpm test runs scripts/build-recorder.mjs first).
const SURVEY = readFileSync(new URL("../../dist/survey.txt", import.meta.url), "utf8");
const LOADER = readFileSync(new URL("../../dist/loader.txt", import.meta.url), "utf8");

/** A tiny DOM: enough for the widget, and it throws on any HTML-parsing API. */
class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  className = "";
  type = "";
  value = "";
  checked = false;
  maxLength = -1;
  placeholder = "";
  disabled = false;
  style: Record<string, string> & { setProperty?: (k: string, v: string) => void } = {};
  shadow: FakeEl | null = null;
  shadowMode: string | null = null;
  adoptedStyleSheets: unknown[] = [];
  attachedWithAttrs: Record<string, string> | null = null;
  private text = "";
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
    const props: Record<string, string> = {};
    this.style = Object.assign(props, { setProperty: (k: string, v: string) => void (props[k] = v) });
  }
  set innerHTML(_v: string) {
    throw new Error("innerHTML used");
  }
  set outerHTML(_v: string) {
    throw new Error("outerHTML used");
  }
  insertAdjacentHTML() {
    throw new Error("insertAdjacentHTML used");
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    this.text = String(v);
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  get id() {
    return this.attrs.id ?? "";
  }
  get parentElement() {
    return this.parent;
  }
  addEventListener(t: string, f: (e: unknown) => void) {
    (this.listeners[t] ??= []).push(f);
  }
  removeEventListener() {}
  appendChild(c: FakeEl) {
    c.parent = this;
    this.children.push(c);
    if (c.shadowMode && !c.attachedWithAttrs) c.attachedWithAttrs = { ...c.attrs };
    return c;
  }
  append(...cs: FakeEl[]) {
    for (const c of cs) this.appendChild(c);
  }
  replaceChildren(...cs: FakeEl[]) {
    this.children = [];
    this.text = "";
    this.append(...cs);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  attachShadow(o: { mode: string }) {
    this.shadowMode = o.mode;
    this.shadow = new FakeEl("#shadow");
    return this.shadow;
  }
  focus() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, width: 10, height: 10 };
  }
  click() {
    for (const f of this.listeners.click ?? []) f({ target: this, preventDefault() {}, stopPropagation() {} });
  }
  /** depth-first search through children and open shadow roots */
  all(): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl) => {
      out.push(e);
      for (const c of e.children) walk(c);
      if (e.shadow) walk(e.shadow);
    };
    walk(this);
    return out;
  }
}

function page(opts: {
  surveys: ReturnType<typeof publicSurvey>[];
  path?: string;
  gpc?: boolean;
  local?: Record<string, string>;
  sid?: string | null;
  tags?: Record<string, unknown>;
}) {
  const body = new FakeEl("body");
  const posts: Record<string, unknown>[] = [];
  const timers: (() => void)[] = [];
  const local: Record<string, string> = { ...(opts.local ?? {}) };
  const session: Record<string, string> = {};
  const store = (m: Record<string, string>) => ({
    getItem: (k: string) => m[k] ?? null,
    setItem: (k: string, v: string) => void (m[k] = v),
  });
  const docListeners: Record<string, ((e: unknown) => void)[]> = {};
  class ErrorEvent {}
  class CSSStyleSheet {
    css = "";
    replaceSync(c: string) {
      this.css = c;
    }
  }
  const ctx: Record<string, unknown> = {
    JSON,
    Math,
    Date,
    Set,
    Map,
    WeakSet,
    Array,
    Object,
    String,
    Number,
    Uint8Array,
    ErrorEvent,
    CSSStyleSheet,
    crypto: { getRandomValues: (a: Uint8Array) => a.map((_, i) => i * 3) },
    location: { pathname: opts.path ?? "/checkout", search: "" },
    navigator: { userAgent: "Mozilla/5.0 (Macintosh) Chrome/131", globalPrivacyControl: !!opts.gpc },
    sessionStorage: store(session),
    localStorage: store(local),
    matchMedia: () => ({ matches: false }),
    setTimeout: (f: () => void) => void timers.push(f),
    setInterval: () => 0,
    addEventListener: () => {},
    scrollY: 0,
    innerHeight: 800,
    fetch: (url: string, init: { body: string }) => {
      posts.push({ url, ...JSON.parse(init.body) });
      return Promise.resolve({});
    },
    document: {
      currentScript: { src: "https://replay.test/sv/rsite_0123456789abcdef.abc.js" },
      body,
      documentElement: { scrollHeight: 2000 },
      readyState: "complete",
      createElement: (t: string) => new FakeEl(t),
      addEventListener: (t: string, f: (e: unknown) => void) => void (docListeners[t] ??= []).push(f),
      removeEventListener: () => {},
      querySelector: () => null,
    },
  };
  ctx.window = ctx;
  ctx.__afsrSv = { T: opts.tags ?? {}, U: 0, q: [], sid: () => (opts.sid === undefined ? "rs_aaaaaaaaaaaaaaaa" : opts.sid) };
  runInNewContext(
    `(function(){var __AFSV__=${JSON.stringify({ site: "rsite_0123456789abcdef", base: "https://x", s: opts.surveys })};\n${SURVEY}\n})();`,
    ctx,
  );
  const flush = () => {
    while (timers.length) timers.shift()!();
  };
  const find = (pred: (e: FakeEl) => boolean) => body.all().filter(pred);
  return { body, posts, flush, find, local, session, ctx };
}

const def = (over: Partial<SurveyDef> = {}): SurveyDef => ({
  kind: "popover",
  questions: normalizeQuestions(template("nps") as Parameters<typeof normalizeQuestions>[0], 20).questions,
  targeting: {},
  trigger: { on: "load" },
  frequency: "once_per_visitor",
  limits: {},
  appearance: { accent: "#2a6df4" },
  link_session: "auto",
  scrub_pii: true,
  show_with_gpc: false,
  ...over,
});
const sv = (over: Partial<SurveyDef> = {}, id = "rsv_0000000000000001") => publicSurvey(id, 1, def(over));

describe("survey widget (dist/survey.txt in a fake DOM)", () => {
  it("stays small and has no HTML-parsing, eval or cookie code in it", () => {
    expect(gzipSync(SURVEY).length).toBeLessThan(8 * 1024);
    expect(SURVEY).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|document\.cookie/);
    expect(SURVEY).toContain('mode:"closed"');
    expect(SURVEY).toContain("data-afsr-block");
    expect(SURVEY).toContain("data-afsr-survey");
  });

  it("renders in a closed shadow root on a blocked host, owner text as text only, then posts the answers", () => {
    const evil = '<img src=x onerror="alert(1)">How likely?';
    const s = sv({ questions: [{ ...def().questions[0]!, text: evil }, def().questions[1]!] });
    const p = page({ surveys: [s] });
    const host = p.body.children[0]!;
    expect(host.shadowMode).toBe("closed");
    // the shadow root existed and the host was blocked before it entered the page
    expect(host.attachedWithAttrs).toMatchObject({ "data-afsr-block": "", "data-afsr-ignore": "" });
    expect(host.style["--a"]).toBe("#2a6df4");
    expect((host.shadow!.adoptedStyleSheets[0] as { css: string }).css).toContain(":host{all:initial}");
    const title = p.find((e) => e.textContent === evil && e.children.length === 0);
    expect(title).toHaveLength(1);
    expect(p.find((e) => e.tagName === "IMG")).toHaveLength(0);
    expect(p.posts[0]).toEqual({ url: "https://replay.test/f", v: 1, s: "rsite_0123456789abcdef", sv: s.id, ver: 1, imp: 1 });
    // NPS 3 auto-advances to the follow-up question
    p.find((e) => e.tagName === "BUTTON" && e.attrs["aria-label"] === "3")[0]!.click();
    p.flush();
    const ta = p.find((e) => e.tagName === "TEXTAREA")[0]!;
    ta.value = "  too slow  ";
    for (const f of ta.listeners.input ?? []) f({});
    p.find((e) => e.tagName === "BUTTON" && e.textContent === "Send")[0]!.click();
    const done = p.posts.find((x) => x.d === 1)!;
    expect(done).toMatchObject({ sv: s.id, a: { q1: 3, q2: "too slow" }, sid: "rs_aaaaaaaaaaaaaaaa", p: "/checkout" });
    expect(done.r).toMatch(/^[0-9a-z]{16}$/);
    expect(p.local[`afsr_sv_${s.id}`]).toBe("done");
    p.flush();
    expect(p.body.children).toHaveLength(0); // closed after the thanks
  });

  it("targeting, frequency, GPC, tags and link_session never/ask decide what shows and what is sent", () => {
    expect(page({ surveys: [sv({ targeting: { pages: ["/pricing*"] } })] }).body.children).toHaveLength(0);
    expect(page({ surveys: [sv({ targeting: { exclude_pages: ["/check*"] } })] }).body.children).toHaveLength(0);
    expect(page({ surveys: [sv()], local: { afsr_sv_rsv_0000000000000001: "1" } }).body.children).toHaveLength(0);
    expect(page({ surveys: [sv()], gpc: true }).body.children).toHaveLength(0);
    expect(page({ surveys: [sv({ show_with_gpc: true })], gpc: true }).body.children).toHaveLength(1);
    expect(page({ surveys: [sv({ targeting: { tags: { plan: "pro" } } })], tags: { plan: "free" } }).body.children).toHaveLength(0);
    expect(page({ surveys: [sv({ targeting: { tags: { plan: "pro" } } })], tags: { plan: ["pro", "x"] } }).body.children).toHaveLength(1);
    expect(page({ surveys: [sv({ trigger: { on: "manual" } })] }).body.children).toHaveLength(0);
    // a bad accent never reaches CSS
    const bad = page({ surveys: [{ ...sv(), ap: { accent: "red;background:url(x)" } }] });
    expect(bad.body.children[0]!.style["--a"]).toBeUndefined();
    // never: no session id even from a recorded tab
    const never = page({ surveys: [sv({ link_session: "never" })] });
    never.find((e) => e.attrs["aria-label"] === "9")[0]!.click();
    never.flush();
    never.find((e) => e.tagName === "BUTTON" && e.textContent === "Send")[0]!.click();
    expect(never.posts.find((x) => x.d === 1)).not.toHaveProperty("sid");
    // ask: only when the box is ticked
    const ask = page({
      surveys: [
        sv({
          link_session: "ask",
          questions: normalizeQuestions(template("free_text") as Parameters<typeof normalizeQuestions>[0], 20).questions,
        }),
      ],
    });
    const cb = ask.find((e) => e.tagName === "INPUT" && e.type === "checkbox")[0]!;
    const ta = ask.find((e) => e.tagName === "TEXTAREA")[0]!;
    ta.value = "hi";
    for (const f of ta.listeners.input ?? []) f({});
    cb.checked = true;
    for (const f of cb.listeners.change ?? []) f({});
    ask.find((e) => e.tagName === "BUTTON" && e.textContent === "Send")[0]!.click();
    expect(ask.posts.find((x) => x.d === 1)).toMatchObject({ sid: "rs_aaaaaaaaaaaaaaaa" });
  });

  it("typing stays inside the survey, a load-triggered text box never takes the focus, feedback respects GPC", () => {
    const text = normalizeQuestions(template("free_text") as Parameters<typeof normalizeQuestions>[0], 20).questions;
    const p = page({ surveys: [sv({ questions: text })] });
    const root = p.body.children[0]!.shadow!;
    for (const t of ["keydown", "keyup", "beforeinput", "input", "paste", "compositionend", "focusin"])
      expect(root.listeners[t]?.length).toBe(1);
    let stopped = false;
    root.listeners.keydown![0]!({ stopPropagation: () => (stopped = true) });
    expect(stopped).toBe(true);
    const focused: string[] = [];
    const ta = p.find((e) => e.tagName === "TEXTAREA")[0]!;
    ta.focus = () => void focused.push("ta");
    p.flush();
    expect(focused).toEqual([]); // the visitor didn't open it: no focus taken
    // afsr('feedback') opens the panel only where the feedback survey may show
    const fb = sv(
      { kind: "feedback", questions: normalizeQuestions(template("feedback") as Parameters<typeof normalizeQuestions>[0], 20).questions },
      "rsv_0000000000000009",
    );
    const gpcPage = page({ surveys: [fb], gpc: true });
    (gpcPage.ctx.__afsrSv as { h: (c: unknown[]) => void }).h(["feedback"]);
    expect(gpcPage.body.children).toHaveLength(0);
    const ok = page({ surveys: [fb] });
    expect(ok.body.children).toHaveLength(1); // the side tab
    (ok.ctx.__afsrSv as { h: (c: unknown[]) => void }).h(["feedback"]);
    expect(ok.body.children).toHaveLength(2);
  });

  it("an email question sends the address only with its consent box ticked, and never takes the focus", () => {
    const qs = normalizeQuestions(
      [{ type: "email", text: "Can we follow up?", consent_text: "You may email me about this answer only." }] as Parameters<
        typeof normalizeQuestions
      >[0],
      20,
    ).questions;
    const send = (tick: boolean) => {
      const p = page({ surveys: [sv({ questions: qs })] });
      const input = p.find((e) => e.tagName === "INPUT" && (e as unknown as { type: string }).type === "email")[0]!;
      const box = p.find((e) => e.tagName === "INPUT" && (e as unknown as { type: string }).type === "checkbox")[0]!;
      expect((input as unknown as { autocomplete: string }).autocomplete).toBe("email");
      expect(p.find((e) => e.textContent === "You may email me about this answer only." && e.children.length === 0)).toHaveLength(1);
      let focused = false;
      input.focus = () => void (focused = true);
      input.value = "person@example.test";
      for (const f of input.listeners.input ?? []) f({});
      if (tick) {
        (box as unknown as { checked: boolean }).checked = true;
        for (const f of box.listeners.change ?? []) f({});
      }
      p.flush();
      expect(focused).toBe(false);
      p.find((e) => e.tagName === "BUTTON" && e.textContent === "Send")[0]!.click();
      return p.posts.find((x) => x.d === 1);
    };
    expect(send(false)).toMatchObject({ a: {} });
    expect(send(true)).toMatchObject({ a: { q1: { email: "person@example.test", consent: true } } });
  });

  it("the Send label follows skip logic; Other text survives toggling choices", () => {
    const qs = normalizeQuestions(
      [
        { id: "q1", type: "multi_choice", text: "What?", choices: ["A", "B"], other: true, logic: [{ if: { equals: "A" }, goto: "end" }] },
        { id: "q2", type: "long_text", text: "More?" },
      ] as Parameters<typeof normalizeQuestions>[0],
      20,
    ).questions;
    const p = page({ surveys: [sv({ questions: qs })] });
    const go = () => p.find((e) => e.tagName === "BUTTON" && e.className === "p")[0]!;
    expect(go().textContent).toBe("Next");
    const other = p.find((e) => e.tagName === "INPUT" && e.className === "tx")[0]!;
    other.value = "C";
    for (const f of other.listeners.input ?? []) f({});
    p.find((e) => e.tagName === "BUTTON" && e.textContent === "A")[0]!.click();
    expect(go().textContent).toBe("Send");
    go().click();
    expect(p.posts.find((x) => x.d === 1)).toMatchObject({ a: { q1: ["A", "C"] } });
  });

  it("closing early sends the partial answers once; afsr('survey', id) shows a manual survey", () => {
    const p = page({ surveys: [sv({ trigger: { on: "manual" } })] });
    expect(p.body.children).toHaveLength(0);
    (p.ctx.__afsrSv as { h: (c: unknown[]) => void }).h(["survey", "rsv_0000000000000001"]);
    expect(p.body.children).toHaveLength(1);
    p.find((e) => e.attrs["aria-label"] === "7")[0]!.click();
    p.find((e) => e.tagName === "BUTTON" && e.className === "x")[0]!.click();
    expect(p.posts.filter((x) => x.r)).toEqual([expect.objectContaining({ d: 0, a: { q1: 7 } })]);
  });

  it("the loader loads it lazily only with active surveys or a preview, and routes survey commands to it", () => {
    const run = (cfg: Record<string, unknown>, search = "") => {
      const injected: string[] = [];
      const ctx: Record<string, unknown> = {
        JSON,
        Math,
        Date,
        Uint8Array,
        crypto: { getRandomValues: (a: Uint8Array) => a },
        ErrorEvent: class {},
        location: { search },
        navigator: { doNotTrack: "1" },
        sessionStorage: { getItem: () => null, setItem() {} },
        localStorage: { getItem: () => null, setItem() {} },
        setTimeout: (f: () => void) => f(),
        addEventListener: () => {},
        document: {
          currentScript: { src: "https://replay.test/r/rsite_0123456789abcdef.js" },
          readyState: "complete",
          head: { appendChild: (s: { src: string }) => injected.push(s.src) },
          createElement: () => ({ src: "" }),
        },
      };
      ctx.window = ctx;
      const base = {
        site: "rsite_0123456789abcdef",
        rec: "/rec/x.js",
        sr: 1,
        mask: "strict",
        unmask: "",
        maskSel: "",
        block: "",
        ex: [],
        maxMs: 1e6,
        idleMs: 1e6,
        consent: false,
        errors: true,
        on: true,
        base: "https://replay.test",
      };
      runInNewContext(`(function(){var __AFSR__=${JSON.stringify({ ...base, ...cfg })};\n${LOADER}\n})();`, ctx);
      return { injected, ctx };
    };
    // DNT stops recording, not surveys (each survey decides with show_with_gpc)
    expect(run({ sv: "k3" }).injected).toEqual(["https://replay.test/sv/rsite_0123456789abcdef.k3.js"]);
    expect(run({}).injected).toEqual([]);
    const tok = "abcdefghjkmnpqrstvwxyz01";
    expect(run({}, `?afsr_survey=rsv_0000000000000001.${tok}`).injected).toEqual([
      `https://replay.test/sv/rsite_0123456789abcdef.p.js?preview=rsv_0000000000000001&pt=${tok}`,
    ]);
    expect(run({}, "?afsr_survey=rsv_0000000000000001").injected).toEqual([]); // no token, no preview
    expect(run({ sv: "k3", on: false }).injected).toEqual([]);
    const r = run({ sv: "k3" });
    const afsr = r.ctx.afsr as (...a: unknown[]) => void;
    afsr("set", "plan", "pro");
    afsr("identify", "u1", { company: "Acme" });
    afsr("survey", "rsv_0000000000000001");
    const shared = r.ctx.__afsrSv as { T: Record<string, unknown>; U: number; q: unknown[][] };
    expect(shared.T).toEqual({ plan: "pro", company: "Acme" });
    expect(shared.U).toBe(1);
    expect(shared.q).toEqual([["survey", "rsv_0000000000000001"]]);
  });
});
